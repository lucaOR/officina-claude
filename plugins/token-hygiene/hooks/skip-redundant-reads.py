#!/usr/bin/env python3
"""Three hooks in one script, dispatched on hook_event_name:

  PreToolUse(Read)          — deny a Read whose line range was already read in this
                              session epoch and whose file has not changed since.
  PostToolUse(Read)         — record the range the agent actually received.
  SessionStart(clear|compact) — start a new epoch (the old reads are gone from context).

Recording happens on PostToolUse, not PreToolUse: a Read this hook allows can still be
denied by another PreToolUse(Read) hook (cap-large-reads.py), and recording it then would
mark content as "in your context" that the agent never received. The two guards would
then alternate denials — one relenting on even attempts, the other on odd — and the file
would be unreachable forever. Only a Read that returned may be recorded.

Why deny rather than warn: within one epoch nothing leaves the context. Context is
only lost at a compaction or a `/clear`, and both start a new epoch here, so
"already read in this epoch" means "still in your context above" — an invariant, not
a guess. Re-reading it buys nothing and then rides along in every later replay.

Measured on one project (108 transcripts): 405 of 1,968 Read calls — 2.33 MB,
18.9% of all Read bytes — re-read a line range already covered in the same session.

Safety properties:
  * mtime+size are part of the key, so a Read after any write goes straight through.
  * Only line-oriented reads are guarded; images, PDFs and `pages` reads are ignored.
  * Relent-once: a second attempt at the same range is allowed, so the agent can
    never be wedged by a stale epoch.
  * Fail-open: any error here allows the Read.
  * Per-agent state: a subagent's reads are keyed by session_id + agent_id, since it
    shares the parent's session but not its context.

Disable entirely with REREAD_GUARD_DISABLE=1.
"""
import json
import os
import re
import sys
import time
from pathlib import Path

CACHE = Path(os.environ.get("XDG_CACHE_HOME") or (Path.home() / ".cache")) / "claude-code-hooks" / "reads"
DEFAULT_LIMIT = 2000          # the Read tool's own default line budget
PRUNE_AFTER_DAYS = 7
OPAQUE = re.compile(r"\.(png|jpe?g|gif|webp|bmp|svg|pdf|ipynb)$", re.IGNORECASE)


def slug():
    root = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    return re.sub(r"[/.]", "-", root)


def state_file(session_id):
    return CACHE / slug() / "{sid}.json".format(sid=re.sub(r"[^A-Za-z0-9_-]", "_", session_id))


def load(path):
    try:
        with path.open(encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(data, fh)
    tmp.replace(path)


def span(tool_input):
    """The line range a Read will return, as an inclusive (lo, hi) pair."""
    try:
        offset = int(tool_input.get("offset") or 1)
    except (TypeError, ValueError):
        offset = 1
    try:
        limit = int(tool_input.get("limit") or DEFAULT_LIMIT)
    except (TypeError, ValueError):
        limit = DEFAULT_LIMIT
    lo = max(offset, 1)
    return [lo, lo + max(limit, 1) - 1]


def covered(iv, spans):
    """True when (lo, hi) is fully inside the union of already-read spans."""
    lo, hi = iv
    for a, b in sorted(spans):
        if a > lo:
            break
        if b >= lo:
            lo = max(lo, b + 1)
        if lo > hi:
            return True
    return lo > hi


def emit(payload):
    print(json.dumps({"hookSpecificOutput": dict(payload, hookEventName="PreToolUse")}))


def prune():
    cutoff = time.time() - PRUNE_AFTER_DAYS * 86400
    for path in CACHE.glob("*/*.json"):
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink()
        except OSError:
            pass


def on_session_start(data):
    source = data.get("source")
    if source == "startup":
        prune()
        return
    if source not in ("clear", "compact"):
        return          # resume / fork keep their context, so they keep their epoch
    path = state_file(data.get("session_id") or "")
    try:
        path.unlink()
    except OSError:
        pass


def owner(data):
    """State key of whoever's context a Read lands in.

    Workflow and Agent subagents share the parent's session_id but each has its own
    context, so a sibling's read says nothing about what this agent holds. Hook input
    from inside a subagent carries `agent_id`; the main thread does not.
    """
    session_id = data.get("session_id")
    agent_id = data.get("agent_id")
    if not session_id:
        return None
    if isinstance(agent_id, str) and agent_id:
        return "{s}.{a}".format(s=session_id, a=agent_id)
    return session_id


def subject(data):
    """(file_path, owner, sig, span) for a line-oriented Read, else None."""
    tool_input = data.get("tool_input") or {}
    file_path = tool_input.get("file_path")
    if not isinstance(file_path, str) or not file_path:
        return None
    if tool_input.get("pages") or OPAQUE.search(file_path):
        return None     # page-addressed or non-line-oriented: not our range model
    session_id = owner(data)
    if not session_id:
        return None
    try:
        st = os.stat(file_path)
    except OSError:
        return None     # missing/unreadable: let the tool report the real error
    sig = "{m}:{s}".format(m=st.st_mtime_ns, s=st.st_size)
    return file_path, session_id, sig, span(tool_input)


def on_read_done(data):
    """PostToolUse(Read): record the range that actually landed in context."""
    response = data.get("tool_response")
    if isinstance(response, dict) and response.get("is_error"):
        return          # the Read failed, so nothing entered the context
    parts = subject(data)
    if parts is None:
        return
    file_path, session_id, sig, iv = parts

    path = state_file(session_id)
    state = load(path)
    files = state.setdefault("files", {})
    entry = files.get(file_path)

    if not entry or entry.get("sig") != sig:
        files[file_path] = {"sig": sig, "spans": [iv], "denied": 0}
        save(path, state)
        return

    spans = [s for s in entry.get("spans", []) if isinstance(s, list) and len(s) == 2]
    if not covered(iv, spans):
        spans.append(iv)
        entry["spans"] = spans
    entry["denied"] = 0   # the content is in context now; drop any pending deny
    save(path, state)


def on_read(data):
    parts = subject(data)
    if parts is None:
        return
    file_path, session_id, sig, iv = parts

    path = state_file(session_id)
    state = load(path)
    entry = (state.get("files") or {}).get(file_path)
    if not entry or entry.get("sig") != sig:
        return          # never read this version of the file

    spans = [s for s in entry.get("spans", []) if isinstance(s, list) and len(s) == 2]
    if not covered(iv, spans):
        return          # a range we have not delivered yet

    if entry.get("denied", 0) >= 1:
        # Relented: the agent asked twice, so assume it really is gone from context.
        entry["denied"] = 0
        save(path, state)
        emit({"additionalContext":
              "Note: this range of {p} was already read in this session; allowing the "
              "repeat because you asked twice.".format(p=file_path)})
        return

    entry["denied"] = entry.get("denied", 0) + 1
    save(path, state)
    emit({
        "permissionDecision": "deny",
        "permissionDecisionReason": (
            "Lines {lo}-{hi} of {p} were already read earlier in this session and the file "
            "is unchanged since (same mtime and size), so that content is still in your "
            "context above — scroll back to it instead of re-reading. Reading a different "
            "line range is fine. If the content genuinely is not in your context, issue the "
            "identical Read once more and it will be allowed through."
        ).format(lo=iv[0], hi=iv[1], p=file_path),
    })


def main():
    if os.environ.get("REREAD_GUARD_DISABLE") == "1":
        return
    data = json.load(sys.stdin)
    event = data.get("hook_event_name")
    if event == "SessionStart":
        on_session_start(data)
        return
    if data.get("tool_name") != "Read":
        return
    if event == "PreToolUse":
        on_read(data)
    elif event == "PostToolUse":
        on_read_done(data)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass          # fail-open: never block a Read because the hook broke
