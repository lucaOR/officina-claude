"""Append-only rule-hit ledger: one JSONL line per matched rule per check run."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import paths


def default_path(uc_web: Path) -> Path:
    return paths.metrics_file(uc_web, "kb-ledger.jsonl")


def _key(*parts) -> str:
    return hashlib.sha1("\x00".join(p or "" for p in parts).encode("utf-8")).hexdigest()[:16]


def event_key(fqid: str, label: str, head) -> str:
    """Identity of one violation instance, stable across the edit->commit window.

    Both the PostToolUse hook and the pre-commit gate run with `--baseline HEAD`, and
    HEAD does not move between them, so both derive the same key for the same violation
    and the two rows can be paired. The key changes as soon as the commit lands: under
    `--baseline HEAD` a surviving violation is then pre-existing rather than introduced,
    so it stops reporting, and if it is re-introduced later that is genuinely a new
    instance. This is also what collapses the same violation replayed by N sweep runs
    into one instance instead of N."""
    return _key(fqid, label, head)


def dedup_key(fqid: str, label: str, branch) -> str:
    """Branch-scoped identity, deliberately independent of HEAD.

    The readiness sweep does NOT share the hooks' baseline: it passes the branch base
    (deterministic.sh:63), so it reports as "introduced" anything added anywhere on the
    branch, under whatever HEAD it happens to run at. Such a row therefore gets a fresh
    event_key even when the commit gate already recorded that exact violation, and
    without a second key report.classify() would count it twice -- once as
    landed_advisory and once as landed_ungated, which are contradictory remedies for
    one violation. dedup_key is what lets the sweep row be recognised as a re-sighting;
    it is never used for the edit->commit pairing."""
    return _key(fqid, label, branch)


def _keyable(rule, outcome: str) -> bool:
    """Whether this record denotes a violation instance with a computable identity.

    A `scope: project` check is excluded: check.py:evaluate() gives it a label of
    ", ".join(matched), which is a function of the file list the caller passed, so its
    label -- and therefore its key -- differs at every phase and can never pair."""
    if outcome != "fail":
        return False
    return not (rule.check and rule.check.get("scope", "file") == "project")


def build_rows(records: list, service, source: str, ts: str, run_id: str,
               phase: str = "adhoc", branch=None, head=None, baseline=None,
               keyed: bool = True) -> list:
    """Pure: turn evaluate()'s census [(Rule, label, outcome)] into ledger dicts.

    `src` says who invoked the engine; `phase` says where in the authoring cycle the run
    sits. They are orthogonal — the same `hook` source covers both the edit-time
    PostToolUse hook and the pre-commit gate, and only `phase` separates them.

    `keyed=False` keeps a run's rows out of the event model entirely while leaving them
    in the census. The caller uses it for the root repo, which has neither the
    edit hook nor the commit gate wired, so every one of its violations would otherwise
    classify as a coverage failure no gate could have prevented.

    Rows written before this existed carry none of these fields; report.py treats a
    missing `phase` as legacy and leaves those rows out of event classification rather
    than guessing at them."""
    rows = []
    for rule, label, outcome in records:
        row = {
            "ts": ts, "run": run_id, "src": source, "service": service,
            "fqid": rule.fqid, "sev": rule.severity,
            "outcome": outcome, "label": label,
            "phase": phase, "branch": branch, "head": head, "baseline": baseline,
        }
        if keyed and _keyable(rule, outcome):
            row["event_key"] = event_key(rule.fqid, label, head)
            row["dedup_key"] = dedup_key(rule.fqid, label, branch)
        rows.append(row)
    return rows


def commit_rows(files: list, service, ts: str, run_id: str, branch, head, parent) -> list:
    """Markers saying "a commit landed on `parent`, and it touched these files".

    They carry no rule and no outcome of their own — `fqid` is None, which is why
    report.py's per-rule aggregation (guarded with `if fqid:`) skips them untouched.
    Their whole job is to turn `caught_at_edit` from an inference into an observation:
    an edit-phase violation judged against HEAD `parent` is only credited as caught if
    a commit actually landed on `parent` and touched that file. Without them, every
    abandoned, stashed or reverted edit reads as the knowledge base working."""
    return [
        {
            "ts": ts, "run": run_id, "src": "hook", "service": service,
            "fqid": None, "sev": None,
            "outcome": "committed", "label": f,
            "phase": "postcommit", "branch": branch, "head": head, "parent": parent,
            "baseline": None,
        }
        for f in files
    ]


def append(path: Path, rows: list) -> None:
    if not rows:
        return
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
            fh.flush()


def load_ledger(path: Path) -> list:
    """Read JSONL; tolerate a missing file and skip malformed lines. Loads the whole
    file into memory — fine for the small local ledger this tool produces."""
    path = Path(path)
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows
