#!/usr/bin/env python3
"""Delete handoff notes that have actually been read AND are past a grace period.

Registered as a SessionStart hook on matcher "startup" only — a real new terminal
launch, not a /resume, /clear or /compact, so this runs at most a few times a day
rather than on every context reset. Also runnable standalone for a manual sweep.

Deliberately narrower than "a next session started", which is not proof anyone
read the note: skills/handoff/SKILL.md's Boundaries section records that
on 2026-08-11 a pasted note was the only surviving copy of a session's state, so
this only acts on mark-handoff-consumed.py's sidecar -- written from a PostToolUse
hook on the actual Read of that exact file -- and only once that sidecar itself is
old enough that a "read it, then needed it again minutes later" case is implausible.
A note nobody has opened is left alone forever, same as before this script existed.

Two locations, matching mark-handoff-consumed.py's is_handoff_note():
  - ~/.claude/handoff/*.md
  - <repo>/.claude/handoff.local*.md

Fail-open and silent: this is mechanical housekeeping, not something worth a
line of context on every startup, and one file that fails to delete (e.g. a
permissions hiccup) must never stop the others from being swept.
"""
import os
import time
from pathlib import Path

GRACE_SECONDS = 24 * 60 * 60


def candidates():
    home_handoff = Path.home() / ".claude" / "handoff"
    if home_handoff.is_dir():
        yield from home_handoff.glob("*.md")
    root = Path(os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd())
    claude_dir = root / ".claude"
    if claude_dir.is_dir():
        yield from claude_dir.glob("handoff.local*.md")


def sweep_one(note: Path, now: float) -> None:
    marker = note.with_name(note.name + ".consumed")
    try:
        if now - marker.stat().st_mtime < GRACE_SECONDS:
            return
    except OSError:
        return          # never marked consumed (or already gone): leave it
    for path in (note, marker):
        try:
            path.unlink()
        except OSError:
            pass


def main():
    now = time.time()
    for note in candidates():
        sweep_one(note, now)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass          # fail-open: a broken sweep must never affect session start
