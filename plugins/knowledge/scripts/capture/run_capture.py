#!/usr/bin/env python3
"""Detached capture runner: transcript -> extractor -> queue. Always exits 0.

Spawned by hooks/capture-session-end.py. Any failure is appended to
<local dir>/capture.log and never surfaces to a session.
"""
import argparse
import re
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(SCRIPTS / "kb"))

from capture.confidence import theme_vocab  # noqa: E402
from capture.enqueue import enqueue  # noqa: E402
from capture.extract import extract  # noqa: E402
from capture.prepare import prepare_input  # noqa: E402


def _log(root, text):
    if root is None:
        return
    try:
        import paths
        log = paths.local_dir(Path(root)) / "capture.log"
        with open(log, "a", encoding="utf-8") as f:
            f.write(f"{datetime.now(timezone.utc).isoformat()} {text}\n")
    except Exception:
        pass


def main(argv):
    root = None
    try:
        ap = argparse.ArgumentParser()
        ap.add_argument("--session", required=True)
        ap.add_argument("--transcript", required=True)
        ap.add_argument("--root", required=True)
        ap.add_argument("--mode", default="auto")
        args = ap.parse_args(argv)
        root = args.root
        if not re.fullmatch(r"[A-Za-z0-9_-]+", args.session):
            return 0
        from kb import kb_queue
        handoff = Path.home() / ".claude" / "handoff" / f"{args.session}.md"
        _, text = prepare_input(args.transcript, handoff if handoff.is_file() else None,
                                args.mode)
        if not text:
            return 0
        queued, _skipped = kb_queue.scan(root)
        rows = extract(text, theme_vocab(queued))
        enqueue(rows, args.session, root)
    except BaseException:
        _log(root, traceback.format_exc().strip().replace("\n", " | "))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
