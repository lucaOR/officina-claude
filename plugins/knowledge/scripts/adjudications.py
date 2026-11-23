"""Verdicts on knowledge-base findings: was the rule RIGHT, not just loud.

Effectiveness without precision is worse than no number. On 2026-08-18 the report
ranked hub/conventions#dto-readonly-immutable-constructors first under "promote to
blocking" at a 47% violation rate while every one of its 43 findings was a false
positive, and acting on that headline would have hard-blocked correct code.

Verdicts are written by a human, or by an agent under explicit instruction. Nothing in
this module infers one: an unadjudicated event stays unadjudicated and is reported as
such, never rounded to correct.

TWO ROW SHAPES, and the split is not cosmetic. Three verdicts judge a finding the engine
produced and therefore key on its event_key. `false_negative` judges a finding it FAILED
to produce -- there is no row, no event_key, nothing to attach to -- so it keys on
(fqid, file, head) instead. The arithmetic differs to match: a false positive lowers
precision, a false negative lowers RECALL and cannot touch precision, because precision
asks "of what it reported, how much was right" and a miss was never reported."""
from __future__ import annotations

from pathlib import Path

import paths

EVENT_VERDICTS = ("true_positive", "false_positive", "irrelevant")
MISS_VERDICT = "false_negative"


def default_path(uc_web: Path) -> Path:
    return paths.metrics_file(uc_web, "kb-adjudications.jsonl")


def build_row(event_key: str, fqid: str, verdict: str, ts: str, by: str,
              note: str = "", service: str | None = None) -> dict:
    """One verdict on a finding the engine produced.

    Raises on an unknown verdict rather than storing it: the rest of the KB tooling is
    deliberately fail-open, but a free-text verdict would silently poison every
    precision number computed from this file afterwards. `false_negative` is rejected
    here too, and not by oversight -- see build_miss_row.

    `service` mirrors the classified event's own service, so `report.aggregate()` can
    join the adjudication store filtered to the same window/service scope as the rest
    of the report instead of always reading the whole store."""
    if verdict not in EVENT_VERDICTS:
        extra = ("; false_negative has no event to key on — use build_miss_row"
                 if verdict == MISS_VERDICT else "")
        raise ValueError("verdict must be one of {v}, got {g!r}{e}".format(
            v=", ".join(EVENT_VERDICTS), g=verdict, e=extra))
    return {"ts": ts, "event_key": event_key, "fqid": fqid, "verdict": verdict,
            "by": by, "note": note, "service": service}


def build_miss_row(fqid: str, file: str, head: str, ts: str, by: str,
                   note: str = "", service: str | None = None) -> dict:
    """A violation the rule SHOULD have caught and did not.

    Keyed on (fqid, file, head) because there is no finding to point at. `head` pins the
    claim to a tree state, so the same miss asserted twice is one miss, and so it stays
    re-checkable after the rule is fixed. `event_key` is present and None on purpose, so
    the two shapes are distinguishable by a single field in one shared file.

    `service` is supplied by the caller rather than read off an event (there is no event
    to read it from), so `report.aggregate()` can join the adjudication store filtered
    to the same window/service scope as the rest of the report."""
    return {"ts": ts, "event_key": None, "fqid": fqid, "file": file, "head": head,
            "verdict": MISS_VERDICT, "by": by, "note": note, "service": service}


def latest(rows: list) -> dict:
    """Last verdict per event_key, by file order. The store is append-only, so a
    re-adjudication is a new row rather than an edit, and the newest one wins. Miss rows
    carry event_key None and are skipped by the same truthiness test that skips
    malformed rows."""
    out = {}
    for row in rows:
        key = row.get("event_key")
        if key:
            out[key] = row
    return out


def misses(rows: list) -> dict:
    """Last miss row per (fqid, file, head). Same append-only, newest-wins rule."""
    out = {}
    for row in rows:
        if row.get("verdict") != MISS_VERDICT:
            continue
        fqid, file, head = row.get("fqid"), row.get("file"), row.get("head")
        if fqid and file:
            out[(fqid, file, head)] = row
    return out
