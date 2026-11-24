#!/usr/bin/env python3
"""UserPromptSubmit hook: give a session resumed from a handoff its parent's /rename title.

A /clear mints a new session, so the name the user gave the old one is gone. The handoff pointer
the user pastes already carries `HANDOFF v1 ... parent=<session-id>`, which is all this needs: it
reads the parent's last title and returns it as `sessionTitle`. The title is copied exactly, so a
chain of handoffs keeps one name, because each child's transcript then holds it for the next.

SessionStart cannot do this for plain handoffs: it fires on the clear, before the pointer is pasted.
Paired sessions are the exception and are handled in pair-brief.py, because their role file already
holds the previous session id and their pasted pointer need not carry `parent=`.

No-op on any prompt without the sentinel. Fail-open: a title that cannot be read must never affect
the prompt that triggered the hook.
"""
import json
import sys
from pathlib import Path

from session_title import last_title, parent_transcript

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from lineage import parent_from_prompt  # noqa: E402


def title_for(prompt: str, transcript_path: str) -> str | None:
    parent = parent_from_prompt(prompt)
    if not parent or not transcript_path:
        return None
    return last_title(parent_transcript(transcript_path, parent))


def main() -> None:
    try:
        data = json.load(sys.stdin)
        title = title_for(data.get("prompt"), data.get("transcript_path"))
        if not title:
            return
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "sessionTitle": title}}))
    except Exception:
        pass                                       # fail-open


if __name__ == "__main__":
    main()
