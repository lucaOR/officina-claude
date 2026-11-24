#!/usr/bin/env python3
"""Gather the mechanical facts a /handoff note needs, in one call.

The model should spend no turns rediscovering branch names, commit subjects or
transcript paths, and the git section of a note should never be wrong because
someone typed it from memory. Everything here is cheap and deterministic;
everything judgement-shaped stays with the model.

The transcript is identified by the session id the harness exports into every
tool call, and the file is found by searching the transcript directories for
that id. Only when the harness exports no id does this fall back to the newest
.jsonl in the directory guessed from the project root, and then the
modification time is printed alongside it -- a wrong pick under two live
sessions is visible rather than silent.

The note's own path is printed too, so the skill never constructs it and two
sessions never write the same file.
"""
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "lib"))
from lineage import SESSION_ID_RE, find_transcript, project_slug, search_dirs  # noqa: E402,F401

MAX_CHANGED = 20


def git(*args):
    try:
        out = subprocess.run(
            ["git", *args], capture_output=True, text=True, timeout=10, check=True
        )
        return out.stdout.strip()
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
        return ""


def locate_transcript():
    """Return (session_id, display) for this session's transcript.

    The harness exports CLAUDE_CODE_SESSION_ID into every tool call, and it is
    the same id the metrics hook keys a session on, so when it is present it
    wins outright -- no directory guess can contradict it, and the note's
    `parent=` is exact. The file is then located by name rather than by
    modification time, which also removes the concurrent-sessions race.

    Without that variable -- or with one the metrics hook could never match,
    which is the same thing in effect -- the fallback is the newest .jsonl in
    the guessed directory. Its id and display string come from a single stat of
    a single file, because stat-ing twice risks a concurrent write making the
    two printed lines disagree.
    """
    sid = os.environ.get("CLAUDE_CODE_SESSION_ID")
    if sid and not SESSION_ID_RE.match(sid):
        sid = None
    if sid:
        f = find_transcript(sid)
        if f:
            return sid, f"{f}  (last written {mtime(f.stat())})"
        return sid, "(no transcript file found for this session id)"
    d = search_dirs()[0]
    if not d.is_dir():
        return None, "(none found)"
    stats = [(p, p.stat()) for p in d.glob("*.jsonl")]
    if not stats:
        return None, "(none found)"
    newest, st = max(stats, key=lambda pair: pair[1].st_mtime)
    return newest.stem, f"{newest}  (last written {mtime(st)})"


def mtime(st):
    return datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M")


def note_path(session_id):
    """Absolute path the note is to be written to.

    Named by session id for two reasons. It cannot collide, where the single
    shared file this replaces was overwritten by whichever session ran /handoff
    last; and the name already carries the `parent=` the metrics hook needs, so
    a pointer to the file identifies its origin without a second lookup.

    It lives under $HOME rather than in the repo because a worktree teardown
    deletes a note kept inside the worktree -- that is how the 2026-08-11 notes
    were lost -- and because `.claude/` is versioned, so a note written there is
    one `git add -A` away from being committed.

    Only an id the metrics hook could match is used in the filename. Anything
    else falls back to a timestamp: the id is interpolated into a path here, and
    the fallback branch of locate_transcript() returns a filename stem that
    nothing has validated.
    """
    d = Path.home() / ".claude" / "handoff"
    usable = session_id and SESSION_ID_RE.match(session_id)
    name = session_id if usable else datetime.now().strftime("unknown-%Y%m%d-%H%M%S")
    try:
        d.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass  # printed anyway; the write that follows creates it or fails loudly
    return d / f"{name}.md"


def main():
    branch = git("rev-parse", "--abbrev-ref", "HEAD") or "(not a git repo)"
    commits = git("log", "--oneline", "-3").replace("\n", " | ") or "(none)"
    status = [line for line in git("status", "--short").split("\n") if line]
    changed = " | ".join(status[:MAX_CHANGED]) if status else "(clean)"
    if len(status) > MAX_CHANGED:
        changed += f" | ... and {len(status) - MAX_CHANGED} more"

    session_id, transcript = locate_transcript()

    print(f"branch: {branch}")
    print(f"commits: {commits}")
    print(f"changed: {changed}")
    print(f"transcript: {transcript}")
    print(f"session_id: {session_id or '(none found)'}")
    print(f"note_path: {note_path(session_id)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
