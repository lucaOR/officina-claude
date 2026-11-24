"""Shared helpers for handoff lineage and transcript lookup.

The handoff pointer a successor session receives carries `HANDOFF v1 ... parent=<session-id>`.
The title hook, the /handoff collector and /session:recall all read that pointer or look up a
transcript by session id, so the pattern and the lookup live here once and cannot drift apart.

Consumers add this directory to sys.path themselves, because the plugin's scripts run as plain
files, not as an installed package.
"""
import os
import re
from pathlib import Path

SENTINEL = re.compile(
    r"HANDOFF v1\b[^\n]*?\bparent=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})")

# Mirrors the metrics hook's sentinel regex, `parent=([0-9a-fA-F-]{8,})` in
# record-session-metrics.js. An id that fails this cannot be recorded no matter
# how the note is written, so an id shaped like anything else is not an id worth
# using. It also keeps a separator out of any path built from it.
SESSION_ID_RE = re.compile(r"^[0-9a-fA-F-]{8,}$")


def parent_from_prompt(prompt):
    """Return the parent session id a handoff pointer names, or None."""
    m = SENTINEL.search(prompt or "")
    return m.group(1) if m else None


def projects_root() -> Path:
    return Path.home() / ".claude" / "projects"


def project_slug():
    root = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    return str(root).replace("/", "-").replace(".", "-")


def search_dirs():
    """Transcript directories to search, most likely first.

    The harness keys a transcript directory on the project root the session
    STARTED in, which is not always the current working directory. A session
    started in the main checkout keeps writing under the main checkout's slug
    even after it moves into a worktree, while a session started inside the
    worktree writes under the worktree's own slug. Deriving the directory from
    cwd is therefore wrong in one of those two cases, and wrong silently: the
    directory exists, holds real transcripts, and yields a real but unrelated
    session id. So the slug is only an ordering hint here, and every project
    directory stays searchable.
    """
    override = os.environ.get("HANDOFF_TRANSCRIPT_DIR")
    if override:
        return [Path(override)]
    projects = projects_root()
    first = projects / project_slug()
    if not projects.is_dir():
        return [first]
    return [first, *sorted(p for p in projects.iterdir() if p.is_dir() and p != first)]


def find_transcript(session_id):
    """Return the path of `<session_id>.jsonl` in any transcript directory, or None."""
    if not session_id or not SESSION_ID_RE.match(session_id):
        return None
    for d in search_dirs():
        f = d / f"{session_id}.jsonl"
        if f.is_file():
            return f
    return None
