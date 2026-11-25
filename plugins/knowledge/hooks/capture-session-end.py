#!/usr/bin/env python3
"""SessionEnd hook: spawn the detached capture runner when scribe.capture is on.

The KNOWLEDGE_EXTRACT guard comes first: the extractor's own `claude -p` child ends a session
too, and must not start another capture. Capture is off by default. Fails open and silent.
"""
import os

if os.environ.get("KNOWLEDGE_EXTRACT"):
    raise SystemExit(0)

import contextlib  # noqa: E402
import io  # noqa: E402
import json  # noqa: E402
import re  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402
from pathlib import Path  # noqa: E402

HERE = Path(__file__).resolve()
sys.path.insert(0, str(HERE.parents[1] / "scripts"))
RUNNER = HERE.parents[1] / "scripts" / "capture" / "run_capture.py"


def main() -> None:
    try:
        if os.environ.get("KNOWLEDGE_EXTRACT"):
            return
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            return
        session, transcript = payload.get("session_id"), payload.get("transcript_path")
        if not isinstance(session, str) or not isinstance(transcript, str):
            return
        if not re.fullmatch(r"[A-Za-z0-9_-]+", session):
            return
        import lib
        import paths
        root = paths.project_root()
        if not paths.has_knowledge(root):
            return
        with contextlib.redirect_stderr(io.StringIO()):
            mode = lib.load_config(root)["scribe"]["capture"]
        if mode == "off":
            return
        subprocess.Popen(
            ["python3", str(RUNNER), "--session", session, "--transcript", transcript,
             "--root", str(root), "--mode", mode],
            start_new_session=True, stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass


if __name__ == "__main__":
    main()
