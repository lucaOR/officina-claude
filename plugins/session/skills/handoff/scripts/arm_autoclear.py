#!/usr/bin/env python3
"""Write the auto-clear flag that the session mod looks for after a handoff.

Called from skills/handoff/SKILL.md step 5, before the pointer is emitted. The flag
is ~/.claude/handoff/<session-id>.autoclear, JSON {session_id, pointer, created_at}.
The mod clears the session and submits the pointer; the pointer printed in the reply
stays the manual fallback.

    arm_autoclear.py <session_id> <pointer>   # prints the flag path
"""
import json
import os
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "lib"))
from lineage import SESSION_ID_RE  # noqa: E402

SENTINEL = "HANDOFF v1"


def arm(session_id: str, pointer: str, home: Path | None = None, now: int | None = None) -> Path:
    if not session_id or not SESSION_ID_RE.match(session_id):
        raise ValueError(f"bad session id: {session_id!r}")
    if SENTINEL not in pointer:
        raise ValueError(f"pointer lacks {SENTINEL!r}")
    d = (home or Path.home()) / ".claude" / "handoff"
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"{session_id}.autoclear"
    body = {"session_id": session_id, "pointer": pointer,
            "created_at": int(time.time()) if now is None else now}
    fd, tmp = tempfile.mkstemp(dir=d, prefix=f".{session_id}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(body, f)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    return path


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: arm_autoclear.py <session_id> <pointer>", file=sys.stderr)
        return 2
    try:
        print(arm(argv[1], argv[2]))
    except ValueError as e:
        print(f"arm_autoclear: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
