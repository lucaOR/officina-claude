"""How often each rule is DELIVERED, and how often it is used.

325 of the 339 rules carry no executable check, so the ledger's four outcomes say
nothing about them beyond `reminder`. Without a usage signal, a rule that has been
delivered into 200 sessions and a rule nobody has ever read look identical — both
silent — and "silent" gets misread as "retire me".

Four channels, in descending strength of evidence:
  digest_resident  the rule's body sits in the always-loaded digest, so every session
                   that started paid for it whether or not it mattered
  jit_delivered    inject-rules-on-edit.py chose it for a specific file being edited
  sweep_surfaced   a review sweep printed it as a reminder against a real diff
  cited            an assistant answer named it — the only channel that shows the rule
                   reached a decision rather than merely reaching the context window

Delivery is not use. A rule with a large `jit_delivered` count and zero `cited` count is
paying rent in every session that touches its globs and returning nothing observable,
which is exactly the signal report.py's retire list is built from."""
from __future__ import annotations

from pathlib import Path

import paths

import ledger

CHANNELS = ("digest_resident", "jit_delivered", "sweep_surfaced", "cited")


def default_path(uc_web: Path) -> Path:
    return paths.metrics_file(uc_web, "kb-usage.jsonl")


def build_row(fqid: str, channel: str, ts: str, session, count: int = 1) -> dict:
    """One delivery. Raises on an unknown channel: a typo'd channel would silently
    vanish from every by_rule() total rather than showing up as a wrong number."""
    if channel not in CHANNELS:
        raise ValueError("channel must be one of {c}, got {g!r}".format(
            c=", ".join(CHANNELS), g=channel))
    return {"ts": ts, "session": session, "fqid": fqid, "channel": channel,
            "count": count}


def record(uc_web, rows: list) -> None:
    """Append, swallowing every error. Both hook callers run on the critical path — one
    before an edit, one at session start — so a broken or unwritable store must cost
    telemetry and never the thing being instrumented."""
    try:
        ledger.append(default_path(Path(uc_web)), rows)
    except Exception:
        pass


def by_rule(rows: list) -> dict:
    """{fqid: {channel: total}}. Absent channels are absent, not zero: a caller that
    wants zeros should ask for them explicitly, and a missing key is a louder signal
    than a 0 when reading the raw dict."""
    out = {}
    for row in rows:
        fqid, channel = row.get("fqid"), row.get("channel")
        if not fqid or channel not in CHANNELS:
            continue
        per = out.setdefault(fqid, {})
        per[channel] = per.get(channel, 0) + int(row.get("count") or 1)
    return out
