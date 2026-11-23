#!/usr/bin/env python3
"""Tests for the handoff-note consumed-marker hook. Plain stdlib unittest:
    python3 plugins/session/hooks/test_mark_handoff_consumed.py
"""
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_spec = importlib.util.spec_from_file_location(
    "mark_handoff_consumed", Path(__file__).with_name("mark-handoff-consumed.py"))
mhc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mhc)


class IsHandoffNoteTest(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        self.repo = Path(tempfile.mkdtemp())
        (self.repo / ".claude").mkdir()
        self._env = mock.patch.dict(os.environ, {
            "HOME": str(self.home), "CLAUDE_PROJECT_DIR": str(self.repo)})
        self._env.start()

    def tearDown(self):
        self._env.stop()

    def test_matches_a_home_handoff_note(self):
        p = self.home / ".claude" / "handoff" / "abc123.md"
        self.assertTrue(mhc.is_handoff_note(str(p)))

    def test_matches_a_repo_local_note(self):
        p = self.repo / ".claude" / "handoff.local.worker.md"
        self.assertTrue(mhc.is_handoff_note(str(p)))

    def test_rejects_a_non_md_file(self):
        p = self.home / ".claude" / "handoff" / "abc123.md.consumed"
        self.assertFalse(mhc.is_handoff_note(str(p)))

    def test_rejects_an_unrelated_repo_file(self):
        p = self.repo / ".claude" / "backlog.yaml"
        self.assertFalse(mhc.is_handoff_note(str(p)))

    def test_rejects_a_local_looking_name_outside_dotclaude(self):
        p = self.repo / "handoff.local.worker.md"
        self.assertFalse(mhc.is_handoff_note(str(p)))


class MainTest(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        self.repo = Path(tempfile.mkdtemp())
        self._env = mock.patch.dict(os.environ, {
            "HOME": str(self.home), "CLAUDE_PROJECT_DIR": str(self.repo)})
        self._env.start()

    def tearDown(self):
        self._env.stop()

    def run_main(self, payload):
        with mock.patch.object(sys, "stdin", io.StringIO(json.dumps(payload))):
            mhc.main()

    def test_writes_a_consumed_marker_on_a_successful_read(self):
        d = self.home / ".claude" / "handoff"
        d.mkdir(parents=True)
        note = d / "abc123.md"
        note.write_text("HANDOFF v1", encoding="utf-8")
        self.run_main({"tool_name": "Read", "tool_input": {"file_path": str(note)},
                        "tool_response": {"is_error": False}})
        self.assertTrue(note.with_name(note.name + ".consumed").exists())

    def test_skips_a_failed_read(self):
        d = self.home / ".claude" / "handoff"
        d.mkdir(parents=True)
        note = d / "abc123.md"
        note.write_text("HANDOFF v1", encoding="utf-8")
        self.run_main({"tool_name": "Read", "tool_input": {"file_path": str(note)},
                        "tool_response": {"is_error": True}})
        self.assertFalse(note.with_name(note.name + ".consumed").exists())

    def test_ignores_a_read_of_an_unrelated_file(self):
        other = self.repo / "README.md"
        other.write_text("hi", encoding="utf-8")
        self.run_main({"tool_name": "Read", "tool_input": {"file_path": str(other)},
                        "tool_response": {"is_error": False}})
        self.assertFalse(other.with_name(other.name + ".consumed").exists())

    def test_ignores_a_non_read_tool(self):
        d = self.home / ".claude" / "handoff"
        d.mkdir(parents=True)
        note = d / "abc123.md"
        note.write_text("HANDOFF v1", encoding="utf-8")
        self.run_main({"tool_name": "Grep", "tool_input": {"file_path": str(note)},
                        "tool_response": {"is_error": False}})
        self.assertFalse(note.with_name(note.name + ".consumed").exists())


class WiringTest(unittest.TestCase):
    """A hook not registered in the plugin's hooks/hooks.json never runs."""

    def settings(self) -> dict:
        return json.loads((Path(__file__).resolve().parent / "hooks.json").read_text(encoding="utf-8"))

    def test_registered_as_a_posttooluse_read_hook(self):
        entries = self.settings()["hooks"]["PostToolUse"]
        mine = [e for e in entries
                if any("mark-handoff-consumed.py" in h.get("command", "")
                       for h in e.get("hooks", []))]
        self.assertEqual(len(mine), 1, "must be registered exactly once under PostToolUse")
        self.assertEqual(mine[0].get("matcher"), "Read")


if __name__ == "__main__":
    unittest.main()
