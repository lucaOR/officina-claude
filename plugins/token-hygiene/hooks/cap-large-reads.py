#!/usr/bin/env python3
"""PreToolUse(Read): deny an unbounded Read of a large text file and ask for a
line range, a grep, or a subagent instead.

Why: Read is by far the largest context surface. Measured over 743 transcripts of one
project, Read is 57.1% of all tool-result bytes (45.7 MB of 79.9 MB), and
85.8% of those bytes come from calls that passed neither `offset` nor `limit`. Of the
604 reads above 20 KB, only 4% were ranged. Because every response replays the whole
context, one unbounded read of a 40 KB service class is not paid once — it is paid on
every later turn of the session, at the cached-input rate but against a prefix that
only grows.

Why deny rather than silently truncate: adding a `limit` behind the agent's back would
hand it a partial file it believes is complete, and the next Edit would be written
against content that does not exist. Truncating a log is safe; truncating source is
not. So the decision is pushed back to the agent with the file's real size attached.

Safety properties:
  * Only unbounded reads are gated: any `offset` or `limit` passes straight through.
  * Only line-oriented text is gated; images, PDFs, notebooks and `pages` reads are
    ignored, as are directories and anything unreadable.
  * Relent-once: a second identical attempt is allowed, so the agent can never be
    wedged by a file it genuinely has to see whole.
  * The relent counter is keyed on mtime+size, so a rewritten file starts fresh.
  * Fail-open: any error here allows the Read.

Tune with READ_CAP_BYTES (default 24576). Disable entirely with READ_CAP_DISABLE=1.
"""
import json
import os
import re
import sys
import time
from pathlib import Path

CACHE = Path(os.environ.get("XDG_CACHE_HOME") or (Path.home() / ".cache")) / "claude-code-hooks" / "caps"
DEFAULT_CAP = 24576           # ~600-800 lines of source; see the sweep in the commit message
PRUNE_AFTER_DAYS = 7
COUNT_CEILING = 8 * 1024 * 1024   # stop counting lines past this; size alone is enough
OPAQUE = re.compile(r"\.(png|jpe?g|gif|webp|bmp|svg|pdf|ipynb)$", re.IGNORECASE)
FEW_LINES = 50                # below this, a line range is useless — the file is one blob


def cap():
    try:
        value = int(os.environ.get("READ_CAP_BYTES") or DEFAULT_CAP)
    except ValueError:
        return DEFAULT_CAP
    return value if value > 0 else DEFAULT_CAP


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


def prune():
    cutoff = time.time() - PRUNE_AFTER_DAYS * 86400
    for path in CACHE.glob("*/*.json"):
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink()
        except OSError:
            pass


def line_count(path, size):
    """Number of lines, or None when the file is too big to be worth scanning."""
    if size > COUNT_CEILING:
        return None
    try:
        lines = 0
        with open(path, "rb") as fh:
            while True:
                chunk = fh.read(1024 * 1024)
                if not chunk:
                    break
                lines += chunk.count(b"\n")
        return lines + 1
    except OSError:
        return None


def emit(payload):
    print(json.dumps({"hookSpecificOutput": dict(payload, hookEventName="PreToolUse")}))


def plural(n):
    return "{n} line{s}".format(n=n, s="" if n == 1 else "s")


def reason(file_path, size, lines):
    kb = size / 1024.0
    where = plural(lines) if lines else "unknown line count"
    if lines is not None and lines < FEW_LINES:
        # Long lines, not many of them: offset/limit buys nothing here.
        narrow = (
            "This file is {kb:.0f} KB in only {n}, so a line range will not narrow it. "
            "Extract just what you need with Bash instead — `jq` for JSON, `grep -o`, or "
            "`cut -c` for a byte window."
        ).format(kb=kb, n=plural(lines))
    else:
        narrow = (
            "Locate what you need first (`Grep`, or `grep -n` via Bash), then Read with "
            "`offset` and `limit` around the hit. For a whole-file question such as \"what "
            "does this class do\" or \"where is X used\", dispatch a read-only subagent "
            "(Explore, for instance) and ask for a file:line answer: it reads the file in its "
            "own context, so the file body never enters this conversation and is never "
            "replayed on later turns."
        )
    return (
        "Unbounded Read of a large file blocked: {p} is {kb:.0f} KB ({where}). An unbounded "
        "read of this size is replayed in full on every subsequent turn of the session. "
        "{narrow} If you really do need the whole file in context, issue the identical Read "
        "once more and it will be allowed through."
    ).format(p=file_path, kb=kb, where=where, narrow=narrow)


def on_read(data):
    tool_input = data.get("tool_input") or {}
    file_path = tool_input.get("file_path")
    if not isinstance(file_path, str) or not file_path:
        return
    if tool_input.get("offset") is not None or tool_input.get("limit") is not None:
        return          # already bounded: this is the behaviour we want to encourage
    if tool_input.get("pages") or OPAQUE.search(file_path):
        return          # page-addressed or non-line-oriented: not our range model
    session_id = data.get("session_id")
    if not session_id:
        return

    try:
        st = os.stat(file_path)
    except OSError:
        return          # missing/unreadable: let the tool report the real error
    if not os.path.isfile(file_path):
        return
    if st.st_size <= cap():
        return

    sig = "{m}:{s}".format(m=st.st_mtime_ns, s=st.st_size)
    path = state_file(session_id)
    state = load(path)
    files = state.setdefault("files", {})
    entry = files.get(file_path)

    if entry and entry.get("sig") == sig and entry.get("denied", 0) >= 1:
        # Relented: the agent asked twice, so it really does want the whole file.
        files.pop(file_path, None)
        save(path, state)
        emit({"additionalContext":
              "Note: allowing the unbounded read of {p} because you asked twice. Prefer a "
              "ranged Read or a subagent for files this size.".format(p=file_path)})
        return

    files[file_path] = {"sig": sig, "denied": 1}
    save(path, state)
    emit({
        "permissionDecision": "deny",
        "permissionDecisionReason": reason(file_path, st.st_size,
                                          line_count(file_path, st.st_size)),
    })


def main():
    if os.environ.get("READ_CAP_DISABLE") == "1":
        return
    data = json.load(sys.stdin)
    event = data.get("hook_event_name")
    if event == "SessionStart":
        if data.get("source") == "startup":
            prune()
        return
    if event == "PreToolUse" and data.get("tool_name") == "Read":
        on_read(data)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass          # fail-open: never block a Read because the hook broke
