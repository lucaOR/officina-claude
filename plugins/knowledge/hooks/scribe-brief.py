#!/usr/bin/env python3
"""SessionStart hook: re-inject the scribe's brief in a scribe session.

Registered on startup|resume|clear|compact, like the digest hook, so a scribe session survives a
/clear or a compaction without losing its role. A session is the scribe when the payload's
`agent_type` is `knowledge:scribe` or `scribe`, or CLAUDE_ROLE is `scribe`. The hook appends
`export KNOWLEDGE_ROLE=scribe` to $CLAUDE_ENV_FILE, so the kb skill's point-of-use re-check can read it,
then prints the brief: the role, the queue size and oldest age, when the health sweep last ran
and whether it is due, and a warning when another run's
lease is fresh. It never claims anything: exclusivity belongs to the run lease (kb_lease.py),
not to the session, and it never probes a process.

Fails open and silent: no knowledge base in the project, unparseable input or any error means
exit 0 with empty stdout. The engine modules (kb_audit pulls in lib and YAML) are imported only
after the role check and inside the fail-open `try`: every session start in every project runs
this hook, and only a scribe session needs them. A queue that cannot be read, or holds an
unparseable line, still leaves the role text and the lease warning in the brief.
"""
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve()
sys.path.insert(0, str(HERE.parents[1] / "scripts"))
sys.path.insert(0, str(HERE.parents[1] / "scripts" / "kb"))

SCRIBE_AGENTS = {"knowledge:scribe", "scribe"}
# Claude Code sources $CLAUDE_ENV_FILE in the shell of every Bash command. Without `export` the
# role would be a shell variable only, unset for printenv, python3 or any script the scribe runs.
ROLE_LINE = "export KNOWLEDGE_ROLE=scribe"

BRIEF = """KB SCRIBE SESSION — you are the **scribe** for this project's knowledge base.

You are the only role that writes KB YAML. You never edit code and you never write a verdict.

Queue: `.claude/knowledge/.local/queue.md`.

This session started as the scribe, but that only proves the guard held at that moment.
Before running `/knowledge:kb run`, independently re-check `KNOWLEDGE_ROLE` or `CLAUDE_ROLE`
in that same turn — do not treat this brief's presence as proof the guard still holds right now."""


def _age(delta_seconds: float) -> str:
    minutes = int(max(delta_seconds, 0) // 60)
    if minutes < 60:
        return f"{minutes}m"
    if minutes < 60 * 48:
        return f"{minutes // 60}h"
    return f"{minutes // (60 * 24)}d"


def brief_lines(root: Path, now: datetime | None = None) -> list[str]:
    import kb_audit
    import kb_lease
    import kb_queue
    now = now or datetime.now(timezone.utc)
    lines = BRIEF.split("\n")
    try:
        rows, skipped = kb_queue.scan(root)
    except Exception:
        rows, skipped = None, 0
    if rows is None:
        lines.append("Queue now: unreadable; `/knowledge:kb run` will report why.")
    elif rows:
        stamps = []
        for row in rows:
            try:
                stamps.append(datetime.fromisoformat(row["ts"]))
            except (KeyError, TypeError, ValueError):
                pass
        oldest = f", oldest {_age((now - min(stamps)).total_seconds())} old" if stamps else ""
        lines.append(f"Queue now: {len(rows)} unconsumed row(s){oldest}.")
    else:
        lines.append("Queue now: empty.")
    if skipped:
        lines.append(f"Queue also holds {skipped} unparseable line{'s' if skipped != 1 else ''}, "
                     f"skipped and left untouched in the file; fix or remove by hand.")
    stamp = kb_audit.last_full(root)
    since = "never" if stamp is None else f"{_age((now - stamp).total_seconds())} ago"
    lines.append(f"Health sweep: last full {since}; "
                 f"{'due' if kb_audit.due(root, now) else 'not due'} at the next `/knowledge:kb run`.")
    held = kb_lease.status(root, now)
    if held and held["fresh"]:
        lines.append(
            f"WARNING: another run holds the scribe lease (session {held.get('session_id')}, "
            f"host {held.get('host')}, started {held.get('started')}, last refreshed "
            f"{held.get('refreshed')}). `/knowledge:kb run` will refuse until it goes stale or "
            f"you confirm a takeover.")
    return lines


def main() -> None:
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            return
        if (payload.get("agent_type") not in SCRIBE_AGENTS
                and os.environ.get("CLAUDE_ROLE") != "scribe"):
            return
        import paths
        root = paths.project_root()
        if not paths.has_knowledge(root):
            return
        env_file = os.environ.get("CLAUDE_ENV_FILE")
        if env_file:
            try:
                try:
                    present = ROLE_LINE in Path(env_file).read_text(
                        encoding="utf-8").splitlines()
                except OSError:
                    present = False
                if not present:
                    with open(env_file, "a", encoding="utf-8") as f:
                        f.write(ROLE_LINE + "\n")
            except OSError:
                pass
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": "\n".join(brief_lines(root))}}))
    except Exception:
        pass                                       # fail-open: never block a session start


if __name__ == "__main__":
    main()
