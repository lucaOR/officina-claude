#!/usr/bin/env python3
"""Tests for the handoff title-inheritance hook. Plain stdlib unittest:
    python3 plugins/session/hooks/test_inherit_handoff_title.py
"""
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import session_title as st  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "inherit_handoff_title", Path(__file__).with_name("inherit-handoff-title.py"))
iht = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(iht)

PARENT = "11afcc13-257b-474e-ac82-9c25daaca682"
CHILD = "22bfcc13-257b-474e-ac82-9c25daaca682"


def write_transcript(d: Path, sid: str, *titles: str) -> None:
    lines = [json.dumps({"type": "user", "message": {"content": "hi"}})]
    lines += [json.dumps({"type": "custom-title", "customTitle": t, "sessionId": sid}) for t in titles]
    (d / f"{sid}.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")


class LastTitleTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())

    def test_last_rename_wins(self):
        write_transcript(self.dir, PARENT, "old", "kb-scribe")
        self.assertEqual(st.last_title(self.dir / f"{PARENT}.jsonl"), "kb-scribe")

    def test_unnamed_session_has_no_title(self):
        write_transcript(self.dir, PARENT)
        self.assertIsNone(st.last_title(self.dir / f"{PARENT}.jsonl"))

    def test_missing_transcript_has_no_title(self):
        self.assertIsNone(st.last_title(self.dir / "nope.jsonl"))


class TitleForTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        write_transcript(self.dir, PARENT, "kb-scribe")
        self.child = str(self.dir / f"{CHILD}.jsonl")

    def test_pointer_with_sentinel_inherits_parent_title(self):
        prompt = f"read /home/x/.claude/handoff/{PARENT}.md — HANDOFF v1 mode=mid parent={PARENT} depth=1"
        self.assertEqual(iht.title_for(prompt, self.child), "kb-scribe")

    def test_prompt_without_sentinel_is_ignored(self):
        self.assertIsNone(iht.title_for(f"what about {PARENT}?", self.child))

    def test_unknown_parent_is_ignored(self):
        self.assertIsNone(iht.title_for(f"HANDOFF v1 mode=mid parent={CHILD}", self.child))


if __name__ == "__main__":
    unittest.main()
