#!/usr/bin/env python3
"""Tests for the shared lineage module. Plain stdlib unittest:
    cd plugins/session/lib && python3 -m unittest test_lineage
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
import lineage  # noqa: E402

PARENT = "11afcc13-257b-474e-ac82-9c25daaca682"
SID = "22bfcc13-257b-474e-ac82-9c25daaca682"


class ParentFromPromptTest(unittest.TestCase):
    def test_pointer_yields_parent(self):
        prompt = f"read ~/.claude/handoff/{PARENT}.md -- HANDOFF v1 mode=mid parent={PARENT}"
        self.assertEqual(lineage.parent_from_prompt(prompt), PARENT)

    def test_prompt_without_pointer_has_no_parent(self):
        self.assertIsNone(lineage.parent_from_prompt(f"look at {PARENT}"))
        self.assertIsNone(lineage.parent_from_prompt(None))

    def test_pointer_must_sit_on_the_sentinel_line(self):
        self.assertIsNone(lineage.parent_from_prompt(f"HANDOFF v1 mode=mid\nparent={PARENT}"))


class FindTranscriptTest(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        self.projects = self.home / ".claude" / "projects"
        for name in ("-repo", "-repo-worktree"):
            (self.projects / name).mkdir(parents=True)
        env = {"HOME": str(self.home), "CLAUDE_PROJECT_DIR": "/repo"}
        self._env = mock.patch.dict(os.environ, env)
        self._env.start()
        os.environ.pop("HANDOFF_TRANSCRIPT_DIR", None)
        self.addCleanup(self._env.stop)

    def test_current_project_directory_comes_first(self):
        dirs = lineage.search_dirs()
        self.assertEqual(dirs[0], self.projects / "-repo")
        self.assertIn(self.projects / "-repo-worktree", dirs)

    def test_finds_a_transcript_in_another_directory_by_id(self):
        f = self.projects / "-repo-worktree" / f"{SID}.jsonl"
        f.write_text("{}\n", encoding="utf-8")
        self.assertEqual(lineage.find_transcript(SID), f)

    def test_unknown_or_malformed_id_finds_nothing(self):
        self.assertIsNone(lineage.find_transcript(SID))
        self.assertIsNone(lineage.find_transcript("../../etc/passwd"))


if __name__ == "__main__":
    unittest.main()
