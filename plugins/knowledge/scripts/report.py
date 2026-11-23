#!/usr/bin/env python3
"""Aggregate the rule-hit ledger into actionable signal: dead / violated / noisy rules.
The single aggregation engine — shared by this CLI, dashboard.py, and the kb health sweep (kb/kb_audit.py)."""
from __future__ import annotations

import argparse
import contextlib
import io
import json
from datetime import datetime, timedelta
from pathlib import Path

import adjudications
import lib
import ledger
import paths
import usage

_OUTCOME_KEY = {"fail": "fails", "pass": "passes",
                "reminder": "reminders", "inconclusive": "inconclusive"}


def default_roots(root=None) -> list:
    root = paths.project_root(root)
    roots = [root]
    for child in sorted(root.iterdir()):
        if (child / ".claude" / "knowledge").is_dir():
            roots.append(child)
    return roots


def normalize_since(since) -> str | None:
    """Accept 'YYYY-MM-DD' or a full ISO timestamp; return a cutoff comparable against
    a ledger `ts`. Raises ValueError on anything else, so a typo fails loud rather than
    silently emptying the window."""
    if since is None or since == "":
        return None
    return datetime.fromisoformat(since).isoformat(timespec="seconds")


def filter_rows(rows: list, service, days, source=None, since=None) -> list:
    """`days` is relative to now; `since` is an absolute cutoff. Both are inclusive
    lower bounds and both apply when both are given (intersection)."""
    out = rows
    if service is not None:
        # keep cross-service rows (service=None) under any service filter
        out = [r for r in out if r.get("service") in (service, None)]
    if source is not None:
        out = [r for r in out if r.get("src") == source]
    if days is not None:
        cutoff = (datetime.now() - timedelta(days=days)).isoformat(timespec="seconds")
        out = [r for r in out if (r.get("ts") or "") >= cutoff]
    absolute = normalize_since(since)
    if absolute is not None:
        out = [r for r in out if (r.get("ts") or "") >= absolute]
    return out


_PHASES = ("edit", "commit", "sweep")
_COUNTING = ("caught_at_edit", "blocked_at_commit",
             "landed_ignored", "landed_advisory", "landed_ungated")
_DIAGNOSTIC = ("unresolved", "already_counted")


def _commit_index(rows: list) -> set:
    """(service, parent, file) for every post-commit marker.

    Membership answers "did a commit land on top of THAT head and touch THAT file",
    which is the positive evidence behind caught_at_edit. Both shas come from
    `git rev-parse --short` in the same repo, so they abbreviate to the same length."""
    return {(r.get("service"), r.get("parent"), r.get("label"))
            for r in rows if r.get("phase") == "postcommit" and r.get("parent")}


def _disposition(inst: dict, committed: set, gated: dict) -> str:
    """One violation instance -> what the knowledge base actually did about it.

    Leans on three properties of the engine, all of which must stay true:
      * check.py:main() exits 1 only for a `blocking` violation, and
        pre-commit-knowledge.sh blocks only on that exit. So a commit-phase fail on a
        `recommended` rule ALWAYS lands, and needs no post-commit confirmation of its
        own — PROVIDED nothing that runs after it can still abort the commit; see the
        third bullet below, which is where that stops being true today.
      * `git commit --no-verify` skips the hook entirely, producing no commit row at
        all. If no edit-phase row exists either, the violation surfaces later at sweep
        phase as landed_ungated, which is the honest answer: we cannot observe a hook
        that did not run. But if an edit-phase row DOES exist and a commit later lands
        on that head touching that file, this classifies as caught_at_edit even when
        the landing commit bypassed the gate via --no-verify — P is written
        unconditionally by post-commit, so it cannot distinguish "gate passed" from
        "gate never ran" in that case. Known blind spot, not fixed by this design.
      * A commit-phase fail row does not by itself prove the commit landed, because
        gates that run AFTER the KB gate (currently just Sonar) can still abort it:
        githooks/pre-commit runs the KB gate first — writing the commit-phase fail row
        this function reads — and only then runs Sonar (bin/sonar-diff.py --staged),
        which can still block the commit. This design does not verify commit-phase
        dispositions (landed_advisory, landed_ignored, blocked_at_commit) against the
        `committed` marker index the way caught_at_edit does, so a Sonar-aborted commit
        is scored the same as one that actually landed. Known blind spot, not fixed by
        this design."""
    # NOTE: asserted purely from inst["commit"] + severity, with no check against the
    # `committed` marker index. If this commit was blocked and then re-attempted via
    # `git commit --no-verify`, the ORIGINAL blocked commit-phase row survives and this
    # branch still scores it as a catch even though the violation actually landed.
    if inst["commit"] and inst["sev"] == "blocking":
        return "blocked_at_commit"
    if inst["commit"] and inst["edit"]:
        return "landed_ignored"
    if inst["commit"]:
        return "landed_advisory"
    if inst["edit"]:
        # NOTE: does not distinguish a genuine catch from a --no-verify bypass with an
        # edit-phase row present — see docstring above.
        # The catch has to be observed, not inferred. Without a commit on this head
        # touching this file, "gone by commit time" is equally consistent with an edit
        # that was abandoned, stashed, reverted, or is still sitting in the tree.
        landed = (inst["service"], inst["head"], inst["label"]) in committed
        return "caught_at_edit" if landed else "unresolved"
    # Sweep-only. Its baseline is the branch base, so it re-reports violations the gates
    # already recorded under an earlier HEAD; those are re-sightings, not new coverage
    # gaps. Only suppress on a STRICTLY earlier gate row, so a sweep that genuinely saw
    # it first still counts.
    seen = gated.get(inst["dedup"])
    if seen is not None and seen < (inst["sweep"] or ""):
        return "already_counted"
    return "landed_ungated"


def classify(rows: list) -> dict:
    """Fold phased fail rows into one record per violation instance.

    Rows written before the event pipeline existed carry no `phase` and no
    `event_key`; they are skipped rather than guessed at, so the legacy census and the
    event view never contaminate each other. Rows the writer deliberately left unkeyed
    are skipped by the same test: project-scope checks, whose label differs at every
    phase, and root-repo runs, which have no gate that could have caught them.

    Only `fail` rows create an instance — a pass is the absence of a violation, and a
    reminder has no instance to speak of. Several rows for the same key are the same
    violation seen more than once (five replayed sweeps, an edit hook firing on
    consecutive saves), so the earliest timestamp per phase wins and the instance count
    is unaffected."""
    committed = _commit_index(rows)
    inst, gated = {}, {}
    for row in rows:
        key, phase = row.get("event_key"), row.get("phase")
        if not key or phase not in _PHASES or row.get("outcome") != "fail":
            continue
        i = inst.setdefault(key, {"fqid": row.get("fqid"), "sev": row.get("sev"),
                                  "label": row.get("label"), "branch": row.get("branch"),
                                  "service": row.get("service"), "head": row.get("head"),
                                  "dedup": row.get("dedup_key"),
                                  "edit": None, "commit": None, "sweep": None})
        ts = row.get("ts") or ""
        if i[phase] is None or ts < i[phase]:
            i[phase] = ts
        if phase in ("edit", "commit"):
            d = row.get("dedup_key")
            if d and (d not in gated or ts < gated[d]):
                gated[d] = ts
    for i in inst.values():
        i["disposition"] = _disposition(i, committed, gated)
    return inst


def effectiveness(classified: dict, adjudicated: dict | None = None,
                  misses: dict | None = None) -> list:
    """Per-rule catch/miss counters, worst first, with precision and recall beside them.

    `misses` (the column) answers "did the rule fail to STOP us", and the three miss
    reasons call for three different fixes: landed_ignored means the warning was read and
    overridden (reword the rule, or the rule is wrong), landed_advisory means it is right
    but under-severed (promote to blocking), landed_ungated means nothing ran (install
    the gate, widen the globs, or drop a muting flag).

    `false_negative` (the argument `misses`, confusingly, and the column) answers a
    different question: did the rule fail to FIRE. Those two are kept apart because their
    remedies are unrelated — a gating failure is a severity or wiring problem, a
    detection failure is a check or glob problem — and because they divide into different
    denominators. Effectiveness is catches over instances; recall is true positives over
    true positives plus false negatives.

    `unresolved` and `already_counted` are counted and printed but never scored, and
    `instances` excludes them. One is an outcome we could not observe and the other is a
    duplicate of something already scored; folding either into the rate would move the
    number on evidence that says nothing about whether the rule worked. A large
    `unresolved` column is itself the finding — usually the post-commit hook missing on
    a machine, or a workflow that rebases.

    `precision` and `recall` are None, never 1.0, when nothing has been adjudicated. An
    unverified rule is unverified: reporting it as perfect is exactly how a rule whose
    findings were 100% false ended up at the top of the promote-to-blocking list."""
    adjudicated = adjudicated or {}
    misses = misses or {}
    per = {}

    def _row(fqid):
        return per.setdefault(fqid, dict(
            {"fqid": fqid, "instances": 0, "true_positive": 0, "false_positive": 0,
             "unadjudicated": 0, "false_negative": 0},
            **{k: 0 for k in _COUNTING + _DIAGNOSTIC}))

    for key, i in classified.items():
        p = _row(i["fqid"])
        p[i["disposition"]] += 1
        if i["disposition"] in _COUNTING:
            p["instances"] += 1
        verdict = (adjudicated.get(key) or {}).get("verdict")
        if verdict in ("true_positive", "false_positive"):
            p[verdict] += 1
        elif verdict is None:
            p["unadjudicated"] += 1
    # Seeded from the miss store too, so a rule that NEVER fires still gets a row. It has
    # no classified instances by construction, and dropping it would hide the only
    # evidence that it is broken.
    for (fqid, _file, _head) in misses:
        _row(fqid)["false_negative"] += 1

    for p in per.values():
        p["catches"] = p["caught_at_edit"] + p["blocked_at_commit"]
        p["misses"] = p["instances"] - p["catches"]
        p["effectiveness"] = p["catches"] / p["instances"] if p["instances"] else None
        judged = p["true_positive"] + p["false_positive"]
        p["precision"] = (p["true_positive"] / judged) if judged else None
        found = p["true_positive"] + p["false_negative"]
        # Mirrors the precision guard above: recall must not read as a real 0% while an
        # unadjudicated backlog remains, because an unjudged finding could turn out to be
        # a true positive that `true_positive` cannot see yet. A genuine 0% requires either
        # a confirmed catch, or that everything findable has already been judged.
        p["recall"] = (p["true_positive"] / found) if found and (
            p["true_positive"] or p["unadjudicated"] == 0) else None
    return sorted(per.values(), key=lambda p: (p["misses"], p["instances"]), reverse=True)


def _adjudications(root) -> list:
    """The adjudication store, read fresh on every call. `aggregate()` calls this once
    per invocation and reuses the list for both joins, so a one-shot `report.py` run
    only reads it once. It cannot be cached across calls: `dashboard.py` runs this as a
    long-lived process polled every 5s, and a cross-call cache would freeze
    precision/recall/true_positive/false_positive at whatever the store looked like on
    the first request, silently diverging from the rest of the dashboard the moment
    someone adjudicates a finding while it's open."""
    return list(ledger.load_ledger(adjudications.default_path(root)))


def retire_candidates(per_rule: dict, usage_by_rule: dict, rules: list) -> list:
    """Rules that were delivered, never caught anything, and were never cited.

    Three conditions, and each exclusion matters:

      * delivered > 0 — a rule with zero deliveries has zero evidence either way.
        Calling that useless is exactly the mistake this report exists to stop; it
        belongs in DEAD, which already says it may be an untouched area.
      * fails == 0 — it never caught a real violation. A rule that catches things is
        worth its delivery cost whatever the volume.
      * cited == 0 — no answer ever named it. Citation is the only channel showing the
        rule reached a decision instead of just reaching the context window.

    Sorted by delivery count, because that is what the rule COSTS: every delivery is
    injected bytes in a session that then had nothing to show for them."""
    known = {r.fqid for r in rules}
    out = []
    for fqid, channels in usage_by_rule.items():
        if fqid not in known:
            continue
        delivered = channels.get("jit_delivered", 0) + channels.get("sweep_surfaced", 0)
        cited = channels.get("cited", 0)
        if delivered <= 0 or cited > 0:
            continue
        if (per_rule.get(fqid) or {}).get("fails", 0) > 0:
            continue
        out.append({"fqid": fqid, "delivered": delivered, "cited": cited,
                    "rows": (per_rule.get(fqid) or {}).get("rows", 0)})
    return sorted(out, key=lambda c: (-c["delivered"], c["fqid"]))


def _usage_sorted(usage_rows: dict, channel: str, registry: set | None = None,
                   sweep_only: set | None = None) -> list:
    """fqids with a nonzero `channel` count, ranked highest first. Zero-count rows are
    dropped rather than sorted to the bottom — a rule nobody delivered/cited isn't a
    low-ranked member of this list, it's not a member at all.

    `registry`, when given, tags each row `in_registry` so a fqid delivered/cited
    before the rule was renamed or deleted can be told apart from a live one.

    `sweep_only`, when given, tags each row `sweep_only` so a rule whose check only
    ever runs during a review sweep — never at edit time — can be told apart from one
    that's actually gated on every edit."""
    out = [{"fqid": fqid, channel: ch.get(channel, 0)}
           for fqid, ch in usage_rows.items() if ch.get(channel, 0) > 0]
    if registry is not None:
        for v in out:
            v["in_registry"] = v["fqid"] in registry
    if sweep_only is not None:
        for v in out:
            v["sweep_only"] = v["fqid"] in sweep_only
    return sorted(out, key=lambda v: (-v[channel], v["fqid"]))


def resident_usage(usage_rows: dict, rules: list) -> list:
    """Rules with `resident=True` in the registry — the digest's full-body tier, paying
    rent in every session regardless of whether any file matches them.

    This is registry membership, not a ledger derivation: the `digest_resident` usage
    channel has no writer (nothing appends to it), so counting from usage_rows would
    always read zero. `cited` is joined in for context — it's the only channel that
    shows a resident rule was actually used rather than merely loaded."""
    out = [{"fqid": r.fqid, "cited": usage_rows.get(r.fqid, {}).get("cited", 0),
            "sweep_only": r.sweep_only}
           for r in rules if r.resident]
    return sorted(out, key=lambda v: (-v["cited"], v["fqid"]))


def digest_rent_path(root) -> Path:
    return paths.metrics_file(root, "kb-digest-rent.jsonl")


def rent_summary(uc_web, service=None, days=None, since=None) -> dict:
    """Total injected digest bytes, split by SessionStart source.

    Read from the store rather than derived from the digest size, because the digest is
    appended only on the startup/clear branch — see inject-knowledge-digest.py."""
    rows = filter_rows(ledger.load_ledger(
        digest_rent_path(uc_web)), service, days, since=since)
    per_source, total = {}, 0
    for row in rows:
        n = int(row.get("bytes") or 0)
        per_source[row.get("source") or "unknown"] = \
            per_source.get(row.get("source") or "unknown", 0) + n
        total += n
    return {"firings": len(rows), "bytes": total, "by_source": per_source}


def _window_start(days, since):
    """Resolve the dashboard header's days/since filter to a calendar date, the same
    intersection-of-lower-bounds `filter_rows` applies, so a zero-filled series can be
    padded back to what the header actually asked for instead of just its own earliest
    active day. None when neither is set ("all"), matching `filter_rows`'s own no-op."""
    starts = []
    if days is not None:
        starts.append((datetime.now() - timedelta(days=days)).date())
    absolute = normalize_since(since)
    if absolute is not None:
        starts.append(datetime.fromisoformat(absolute).date())
    return max(starts) if starts else None


def _zero_fill_days(days: list, start=None) -> list:
    """Fill every calendar day between `start` (or the first active day, if the header
    set no window) and the last active day with a zero row, so a chart's evenly-spaced
    day axis doesn't draw a multi-week gap the same as two consecutive days — and, when
    the header requests a window wider than the actual data, doesn't quietly shrink the
    chart to just the days that happened to have rows."""
    if not days and start is None:
        return []
    by_key = {d["day"]: d for d in days}
    lo = start if start is not None else datetime.strptime(days[0]["day"], "%Y-%m-%d").date()
    hi = (datetime.strptime(days[-1]["day"], "%Y-%m-%d").date() if days
          else datetime.now().date())
    out, cur = [], lo
    while cur <= hi:
        key = cur.isoformat()
        out.append(by_key.get(key) or {"day": key, "runs": 0, "failing_runs": 0})
        cur += timedelta(days=1)
    return out


def _zero_fill_day_series(counts: dict, key: str, start=None, end=None) -> list:
    """Same zero-fill discipline as `_zero_fill_days`, generalized to a single
    {day: count} series so a quiet day reads as 0, not a skipped gap. `end` lets a
    caller pin this series to another series' last day (e.g. by_day's), so two charts
    reacting to the same header stay on the same x-axis even when this one's own data
    happens to end earlier."""
    if not counts and start is None:
        return []
    days = sorted(counts)
    lo = start if start is not None else datetime.strptime(days[0], "%Y-%m-%d").date()
    hi = end if end is not None else (
        datetime.strptime(days[-1], "%Y-%m-%d").date() if days else datetime.now().date())
    out, cur = [], lo
    while cur <= hi:
        k = cur.isoformat()
        out.append({"day": k, key: counts.get(k, 0)})
        cur += timedelta(days=1)
    return out


def aggregate(rows: list, rules: list, service=None, days=None, since=None, root=None) -> dict:
    """Cross-reference ledger rows against the registry. Returns per-rule stats and
    the derived dead / violated / noisy / top lists plus a by-day activity series.

    `service`/`days`/`since` scope the adjudication join to the same window the caller
    already filtered `rows` to (via `filter_rows()`); they do not filter `rows` itself,
    which arrives pre-filtered."""
    stats, by_day = {}, {}
    for row in rows:
        fqid = row.get("fqid")
        if fqid:
            s = stats.setdefault(fqid, {"runs": set(), "rows": 0, "fails": 0, "passes": 0,
                                        "reminders": 0, "inconclusive": 0,
                                        "first_seen": None, "last_seen": None})
            s["rows"] += 1
            s["runs"].add(row.get("run"))
            key = _OUTCOME_KEY.get(row.get("outcome"))
            if key:
                s[key] += 1
            ts = row.get("ts")
            if ts:
                s["first_seen"] = ts if s["first_seen"] is None else min(s["first_seen"], ts)
                s["last_seen"] = ts if s["last_seen"] is None else max(s["last_seen"], ts)
        day = (row.get("ts") or "")[:10]
        # postcommit rows are markers, not activity — they carry no rule and no
        # outcome of their own (ledger.commit_rows()), so counting them here would
        # inflate both the by-day run count and the fail count for a day with no
        # actual check run.
        if day and row.get("phase") != "postcommit":
            d = by_day.setdefault(day, {"runs": set(), "failing_runs": set()})
            d["runs"].add(row.get("run"))
            if row.get("outcome") == "fail":
                d["failing_runs"].add(row.get("run"))

    per_rule = {}
    for fqid, s in stats.items():
        checked = s["fails"] + s["passes"]
        per_rule[fqid] = {
            "fqid": fqid, "runs": len(s["runs"]), "rows": s["rows"], "fails": s["fails"],
            "passes": s["passes"], "reminders": s["reminders"], "inconclusive": s["inconclusive"],
            "violation_rate": (s["fails"] / checked) if checked else None,
            "first_seen": s["first_seen"], "last_seen": s["last_seen"],
        }

    fired = set(per_rule)
    registry = {r.fqid for r in rules}
    sweep_only_rules = {r.fqid for r in rules if r.sweep_only}
    # a fqid can carry ledger history for a rule that was since renamed, merged, or
    # deleted from the YAML — flag it so callers can tell "still actionable" apart
    # from "historical only", instead of presenting a dead rule as something to fix.
    for v in per_rule.values():
        v["in_registry"] = v["fqid"] in registry
        # a sweep_only rule's check never runs at edit time (lib.file_matches excludes
        # it there), so any fails/passes here came from a review-sweep run only —
        # flag it so it doesn't read as a rule quietly gating every edit.
        v["sweep_only"] = v["fqid"] in sweep_only_rules
    has_check = {r.fqid for r in rules if r.check}
    # digest_only rules are resident in the digest and excluded from per-file matching
    # (lib.file_matches short-circuits them), so they can never fire AGAIN — listing one as
    # dead is a permanent false positive, since no amount of work will clear it.
    # They are not excluded from `fired`: the flag is a property of the rule today, while
    # the ledger is history, and a rule flagged after it had already logged rows keeps them.
    never_matchable = {r.fqid for r in rules if r.digest_only}

    dead = sorted(registry - fired - never_matchable)
    # primary key is absolute fail count (most actionable for reword/promote); rate breaks
    # ties. `or 0` is a safety net — fails>0 implies checked>0, so the rate is never None here.
    violated = sorted((v for v in per_rule.values() if v["fails"] > 0),
                      key=lambda v: (v["fails"], v["violation_rate"] or 0), reverse=True)
    noisy = sorted((v for v in per_rule.values()
                    if v["reminders"] > 0 and v["fqid"] not in has_check),
                   key=lambda v: v["reminders"], reverse=True)
    top = sorted(per_rule.values(), key=lambda v: v["runs"], reverse=True)
    window_start = _window_start(days, since)
    by_day_list = _zero_fill_days(
        [{"day": k, "runs": len(v["runs"]), "failing_runs": len(v["failing_runs"])}
         for k, v in sorted(by_day.items())], start=window_start)

    root = paths.project_root(root)
    adj = filter_rows(_adjudications(root), service, days, since=since)
    usage_log = filter_rows(
        ledger.load_ledger(usage.default_path(root)), service, days, since=since)
    usage_rows = usage.by_rule(usage_log)
    # sweep_surfaced has no store producer of its own — derive it from the sweep-phase
    # reminder rows already present in `rows` (Plan A's phase tagging), which arrives
    # pre-filtered to the same window as usage_rows above.
    for row in rows:
        if row.get("phase") == "sweep" and row.get("outcome") == "reminder":
            fqid = row.get("fqid")
            if fqid:
                per = usage_rows.setdefault(fqid, {})
                per["sweep_surfaced"] = per.get("sweep_surfaced", 0) + 1

    # digest_resident has no per-day signal at all (see usage.py's docstring — it is a
    # registry attribute, never a written row), so a "daily unique rules" series can only
    # honestly count jit_delivered: distinct fqids actually delivered into context that day.
    jit_days = {}
    for row in usage_log:
        if row.get("channel") != "jit_delivered":
            continue
        fqid, day = row.get("fqid"), (row.get("ts") or "")[:10]
        if fqid and day:
            jit_days.setdefault(day, set()).add(fqid)
    # by_day is the chart already anchored to the header's window (and, under a blank
    # header, to the ledger's own full history) — pin jit_by_day to the same span so
    # the two charts share an x-axis instead of jit_by_day quietly staying clipped to
    # its own much-newer channel's earliest row.
    jit_start, jit_end = window_start, None
    if by_day_list:
        if jit_start is None:
            jit_start = datetime.strptime(by_day_list[0]["day"], "%Y-%m-%d").date()
        jit_end = datetime.strptime(by_day_list[-1]["day"], "%Y-%m-%d").date()
    jit_by_day = _zero_fill_day_series(
        {day: len(fqids) for day, fqids in jit_days.items()}, "unique_jit_rules",
        start=jit_start, end=jit_end)
    return {"per_rule": per_rule, "dead": dead, "violated": violated, "noisy": noisy,
            "top": top, "by_day": by_day_list, "jit_by_day": jit_by_day,
            "effectiveness": effectiveness(
                classify(rows),
                adjudications.latest(adj),
                adjudications.misses(adj)),
            "usage": usage_rows,
            "most_delivered": _usage_sorted(usage_rows, "jit_delivered", registry, sweep_only_rules),
            "most_cited": _usage_sorted(usage_rows, "cited", registry, sweep_only_rules),
            "resident": resident_usage(usage_rows, rules),
            "retire": retire_candidates(per_rule, usage_rows, rules),
            "rent": rent_summary(root, service, days, since),
            "totals": {"registry": len(registry), "fired": len(fired), "dead": len(dead),
                       # overlaps `fired` (see above) — the three counts do not partition
                       "digest_only": len(never_matchable),
                       # postcommit rows are markers, not check runs — exclude them so
                       # a commit's marker row does not inflate the run count.
                       "runs": len({r.get("run") for r in rows
                                    if r.get("run") and r.get("phase") != "postcommit"})}}


def _print_text(agg: dict, windowed: bool = False, source_filtered: bool = False) -> None:
    t = agg["totals"]
    print(f"registry={t['registry']}  fired={t['fired']}  dead={t['dead']}  "
          f"digest_only={t['digest_only']}  runs={t['runs']}")
    # under a time window "dead" means "never fired IN THE WINDOW" — a rule that fired
    # earlier is silent here, not retirable. Say so, or the list reads as a retire-list.
    scope = "never fired in the selected window" if windowed \
        else "never fired — may be an untouched area, not necessarily useless"
    print(f"\nDEAD (in registry, {scope}):")
    for fqid in agg["dead"]:
        print(f"  {fqid}")
    print("\nFREQUENTLY VIOLATED (reword / promote to blocking):")
    for v in agg["violated"]:
        rate = "n/a" if v["violation_rate"] is None else f"{v['violation_rate']:.0%}"
        print(f"  {v['fqid']}  fails={v['fails']}  rate={rate}  runs={v['runs']}")
    print("\nNOISY REMINDERS (no check — check-synthesis candidates):")
    for v in agg["noisy"]:
        print(f"  {v['fqid']}  reminders={v['reminders']}  runs={v['runs']}")
    print("\nENFORCEMENT (one row per violation instance; legacy rows have no phase and "
          "are excluded).")
    print("  These are FLOORS, not totals: the engine compares counts rather than lines, "
          "so a violation added while another is removed in the same file is invisible, "
          "and unresolved instances are outcomes we could not observe at all.")
    if source_filtered:
        print("  --source narrows phased events too: some dispositions may be "
              "structurally unreachable in this window (see report.py's --source "
              "handling).")
    if not agg["effectiveness"]:
        print("  (no phased events in this window)")
    for e in agg["effectiveness"]:
        # Total-event census for this rule: every event it produced at any phase
        # (pass, fail, reminder), per spec's definition of "fires". Windowed by
        # --days/--since exactly like catches/misses beside it — filter_rows() runs
        # before aggregate() in main(), so both are computed off the same windowed
        # rows. The actual distinction from catches/misses is NOT windowing: catches
        # and misses are a deduplicated subset (violation outcomes only, deduped by
        # dedup_key), while this counts every event regardless of outcome.
        fires = agg["per_rule"].get(e["fqid"], {}).get("rows", 0)
        rate = "n/a" if e["effectiveness"] is None else f"{e['effectiveness']:.0%}"
        prec = ("unadjudicated" if e["precision"] is None
                else f"{e['precision']:.0%} of {e['true_positive'] + e['false_positive']}")
        rec = "n/a" if e["recall"] is None else f"{e['recall']:.0%}"
        print(f"  {e['fqid']}  fires={fires}  catches={e['catches']}  "
              f"misses={e['misses']} (ignored={e['landed_ignored']} "
              f"advisory={e['landed_advisory']} ungated={e['landed_ungated']})  "
              f"eff={rate}  [unresolved={e['unresolved']} "
              f"dup={e['already_counted']}]")
        print(f"      precision={prec}  recall={rec} "
              f"(false_negative={e['false_negative']})")
    rent = agg["rent"]
    if rent["firings"]:
        kb = rent["bytes"] / 1024
        split = "  ".join(f"{s}={n / 1024:.0f}KB" for s, n in sorted(rent["by_source"].items()))
        print(f"\nRENT: {rent['firings']} digest injections, {kb:.0f}KB total  ({split})")
    print("\nRETIRE CANDIDATES (delivered, never caught anything, never cited):")
    if windowed:
        print("  Windowed: every signal here (delivered/cited/fails) is scoped to the "
              "selected window — a rule whose only catches or citations fall outside it "
              "can still appear. Widen the window before retiring anything.")
    print("  Citations are a FLOOR: thinking blocks are not counted, and scribe and "
          "knowledge-* sessions are not excluded. Confirm a candidate by reading it "
          "before retiring it.")
    for c in agg["retire"]:
        print(f"  {c['fqid']}  delivered={c['delivered']}  rows={c['rows']}")


_BLOCKS = (("DEAD", "DEAD ("), ("FREQUENTLY VIOLATED", "FREQUENTLY VIOLATED ("),
           ("NOISY", "NOISY REMINDERS ("), ("RETIRE", "RETIRE CANDIDATES ("))


def findings(agg: dict, windowed: bool = False, source_filtered: bool = False) -> list:
    """What `--findings` prints (`--json` keeps dumping the whole aggregate). The ledger signal as `{"category", "fqids", "text"}` dicts: one per dead, violated,
    noisy and retire-candidate rule. `text` is the block heading plus that rule's entry,
    copied from what `_print_text` prints (it runs on a captured stdout), so the two never
    drift."""
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        _print_text(agg, windowed, source_filtered)
    blocks, current = {}, None
    for line in buf.getvalue().split("\n"):
        if line and not line.startswith(" "):
            current = next((c for c, head in _BLOCKS if line.startswith(head)), None)
            if current:
                blocks[current] = {"heading": line, "lines": []}
        elif current:
            blocks[current]["lines"].append(line)
    entries = {"DEAD": [v for v in agg["dead"]],
               "FREQUENTLY VIOLATED": [v["fqid"] for v in agg["violated"]],
               "NOISY": [v["fqid"] for v in agg["noisy"]],
               "RETIRE": [c["fqid"] for c in agg["retire"]]}
    out = []
    for category, _head in _BLOCKS:
        for fqid in entries[category]:
            entry = next(l for l in blocks[category]["lines"]
                         if l == f"  {fqid}" or l.startswith(f"  {fqid}  "))
            out.append({"category": category, "fqids": [fqid],
                        "text": blocks[category]["heading"] + "\n" + entry})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--service", default=None)
    ap.add_argument("--source", default=None, choices=["skill", "hook", "adhoc"])
    ap.add_argument("--days", type=int, default=None, help="relative window, N days back from now")
    ap.add_argument("--since", default=None,
                    help="absolute cutoff, YYYY-MM-DD or full ISO timestamp (inclusive)")
    ap.add_argument("--json", action="store_true",
                    help="print the whole aggregate as JSON instead of text")
    ap.add_argument("--findings", action="store_true",
                    help="print the dead/violated/noisy/retire findings as a JSON list of "
                         "{category, fqids, text}")
    ap.add_argument("--root", default=None, help="project root (default: resolved from $CLAUDE_PROJECT_DIR or the cwd)")
    lib.add_lease_arg(ap)
    a = ap.parse_args()
    root = paths.project_root(a.root)
    if paths.skip_without_knowledge(root, "report"):
        return
    lib.touch_lease(root, a)
    try:
        normalize_since(a.since)
    except ValueError as exc:
        ap.error(f"--since: {exc}")
    rules = lib.load_all(default_roots(root))
    rows = filter_rows(ledger.load_ledger(ledger.default_path(root)),
                       a.service, a.days, a.source, a.since)
    agg = aggregate(rows, rules, service=a.service, days=a.days, since=a.since, root=root)
    if a.findings:
        print(json.dumps(findings(agg, windowed=bool(a.days or a.since),
                                  source_filtered=bool(a.source)), indent=2))
    elif a.json:
        print(json.dumps(agg, indent=2))
    else:
        _print_text(agg, windowed=bool(a.days or a.since), source_filtered=bool(a.source))


if __name__ == "__main__":
    main()
