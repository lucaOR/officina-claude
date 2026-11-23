import paths
import tempfile
import unittest
from pathlib import Path

import ledger
import skill_misses


class TestSkillMisses(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_default_path(self):
        self.assertEqual(skill_misses.default_path(self.root),
                          paths.local_dir(self.root) / "metrics" / "skill-misses.jsonl")

    def test_build_row(self):
        row = skill_misses.build_row("knowledge-capture", "already-covered-guard", "self",
                                      "2026-08-19T00:00:00", "sess-1",
                                      description="dropped a candidate without opening the "
                                                   "existing entry",
                                      artifact_refs=["report.py:120"])
        self.assertEqual(row, {
            "ts": "2026-08-19T00:00:00", "session": "sess-1",
            "skill": "knowledge-capture", "rule": "already-covered-guard",
            "caught_by": "self",
            "description": "dropped a candidate without opening the existing entry",
            "artifact_refs": ["report.py:120"],
        })

    def test_build_row_defaults(self):
        row = skill_misses.build_row("x", "y", "user", "t", "s")
        self.assertEqual(row["description"], "")
        self.assertEqual(row["artifact_refs"], [])

    def test_build_row_rejects_unknown_caught_by(self):
        with self.assertRaises(ValueError):
            skill_misses.build_row("x", "y", "hook", "t", "s")

    def test_record_appends(self):
        skill_misses.record(self.root, [
            skill_misses.build_row("knowledge-capture", "already-covered-guard", "self",
                                    "t", "s")])
        self.assertEqual(len(ledger.load_ledger(skill_misses.default_path(self.root))), 1)

    def test_record_is_not_fail_silent(self):
        # Unlike usage.record, this is never on a hook's critical path — a broken store
        # must raise, not silently lose the one incident this module exists to keep.
        with self.assertRaises(Exception):
            skill_misses.record(self.root / "no" / "such" / "\0bad", [{"ts": "x"}])

    def test_by_skill_counts_per_rule(self):
        rows = [
            skill_misses.build_row("knowledge-capture", "already-covered-guard", "self", "t", "s"),
            skill_misses.build_row("knowledge-capture", "already-covered-guard", "user", "t", "s"),
            skill_misses.build_row("knowledge-capture", "failure-lens", "self", "t", "s"),
            skill_misses.build_row("knowledge-check", "baseline-flag", "self", "t", "s"),
        ]
        self.assertEqual(skill_misses.by_skill(rows), {
            "knowledge-capture": {"already-covered-guard": 2, "failure-lens": 1},
            "knowledge-check": {"baseline-flag": 1},
        })

    def test_by_skill_ignores_rows_missing_skill_or_rule(self):
        self.assertEqual(skill_misses.by_skill([{"skill": "x"}, {"rule": "y"}, {}]), {})


if __name__ == "__main__":
    unittest.main()
