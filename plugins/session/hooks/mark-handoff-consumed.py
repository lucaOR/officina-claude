#!/usr/bin/env python3
"""PostToolUse(Read) hook: mark a handoff note as consumed once it is actually read.

Pairs with sweep-handoff-notes.py, which is the only thing that acts on the marker
this writes. The signal has to be "this exact file was opened with the Read tool",
not "a session started" or "the pointer's parent= id was seen" — either of those
would fire for a session that never got around to reading the note, and the
backlog item this closes exists specifically because no earlier "was it consumed"
signal was trustworthy enough to delete on.

Covers both places a handoff note can live:
  - ~/.claude/handoff/<session-id>.md, written by collect.py / the handoff skill.
  - <repo>/.claude/handoff.local*.md, the gitignored per-role notes paired
    sessions write directly (worker/adjudicator/etc.) so they don't clobber
    each other's file.

The marker is a sidecar, `<note>.consumed`, not a rewrite of the note itself —
the note's content is not this hook's to touch, and a sidecar is what
sweep-handoff-notes.py can stat for its own mtime-based grace period.

Fail-open throughout: a hook that cannot mark a note as read must never affect
the Read that triggered it.
"""
import json
import os
import sys
import time
from pathlib import Path


def is_handoff_note(file_path: str) -> bool:
    if not file_path.endswith(".md"):
        return False
    p = Path(file_path)
    home_handoff = Path.home() / ".claude" / "handoff"
    try:
        p.relative_to(home_handoff)
        return True
    except ValueError:
        pass
    root = Path(os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd())
    return p.parent == (root / ".claude") and p.name.startswith("handoff.local")


def main():
    data = json.load(sys.stdin)
    if data.get("tool_name") != "Read":
        return
    response = data.get("tool_response")
    if isinstance(response, dict) and response.get("is_error"):
        return          # the Read failed, so nothing was actually consumed
    file_path = (data.get("tool_input") or {}).get("file_path")
    if not isinstance(file_path, str) or not is_handoff_note(file_path):
        return
    try:
        Path(file_path + ".consumed").write_text(str(time.time()), encoding="utf-8")
    except OSError:
        pass


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass          # fail-open: never affect a Read because this hook broke
