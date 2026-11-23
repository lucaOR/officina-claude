#!/usr/bin/env python3
"""Append-only log of skipped skill/process constraints.

Distinct from `kb-ledger.jsonl`: that ledger tracks CODE rules matched by check.py,
each with an executable or judgment check enforced (partly) by hooks. A skill's prose
instructions — e.g. knowledge-capture's "already covered" guard — have no such
enforcement; nothing runs them but the assistant's own reading of the skill body. When
one gets skipped, only a human noticing (or the assistant self-catching on review) ever
surfaces it, and without a record that observation evaporates at session end. This
module is that record: one row per skipped-constraint incident, so a recurring miss
against the same skill/rule is visible across sessions instead of only living in one
transcript.

Not a substitute for fixing the skill body. A miss recorded here that keeps recurring is
a signal the skill's instructions are being missed structurally (unclear wording, buried
under other steps) and the fix belongs in the skill file, not in more logging.
"""
from __future__ import annotations

from pathlib import Path

import ledger
import paths

CAUGHT_BY = ("self", "user")


def default_path(uc_web: Path) -> Path:
    return paths.metrics_file(uc_web, "skill-misses.jsonl")


def build_row(skill: str, rule: str, caught_by: str, ts: str, session: str,
              description: str = "", artifact_refs: list | None = None) -> dict:
    """One incident. Raises on an unknown `caught_by`: a typo'd value would silently
    vanish from by_skill()'s totals rather than showing up as a wrong number."""
    if caught_by not in CAUGHT_BY:
        raise ValueError("caught_by must be one of {c}, got {g!r}".format(
            c=", ".join(CAUGHT_BY), g=caught_by))
    return {"ts": ts, "session": session, "skill": skill, "rule": rule,
            "caught_by": caught_by, "description": description,
            "artifact_refs": artifact_refs or []}


def record(uc_web, rows: list) -> None:
    """Append. Deliberately NOT fail-silent — unlike usage.record, this is never called
    from a hook's critical path, only from an explicit, deliberate logging action, so a
    broken store should be loud rather than silently losing the incident it exists to
    preserve."""
    ledger.append(default_path(Path(uc_web)), rows)


def by_skill(rows: list) -> dict:
    """{skill: {rule: count}} — which skill/rule pairs recur, across all sessions."""
    out = {}
    for row in rows:
        skill, rule = row.get("skill"), row.get("rule")
        if not skill or not rule:
            continue
        per = out.setdefault(skill, {})
        per[rule] = per.get(rule, 0) + 1
    return out


def main():
    import argparse
    from datetime import datetime, timezone

    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--skill", required=True, help="skill name, e.g. knowledge-capture")
    ap.add_argument("--rule", required=True, help="the specific constraint skipped, e.g. "
                                                    "'already-covered-guard'")
    ap.add_argument("--caught-by", required=True, choices=CAUGHT_BY)
    ap.add_argument("--description", default="", help="what happened, in one or two sentences")
    ap.add_argument("--session", default="", help="Claude Code session id, if known")
    ap.add_argument("--artifact-ref", action="append", default=[],
                     help="path:line / SHA / transcript ref backing this; repeatable")
    ap.add_argument("--root", "--uc-web", dest="root", default=None,
                    help="project root (default: resolved from $CLAUDE_PROJECT_DIR or the cwd); "
                         "--uc-web is a legacy alias")
    a = ap.parse_args()
    root = paths.project_root(a.root)
    if paths.skip_without_knowledge(root, "skill_misses"):
        return
    ts = datetime.now(timezone.utc).isoformat()
    row = build_row(a.skill, a.rule, a.caught_by, ts, a.session,
                     description=a.description, artifact_refs=a.artifact_ref)
    record(root, [row])
    print(f"logged: {row['skill']} / {row['rule']} ({row['caught_by']})")


if __name__ == "__main__":
    main()
