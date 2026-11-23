import paths
import tempfile
import unittest
from pathlib import Path

import ledger
import usage


class TestUsage(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_default_path(self):
        self.assertEqual(usage.default_path(self.root),
                         paths.local_dir(self.root) / "metrics" / "kb-usage.jsonl")

    def test_build_row(self):
        row = usage.build_row("hub/x#y", "jit_delivered",
                              "2026-08-18T10:00:00", "sess-1")
        self.assertEqual(row, {"ts": "2026-08-18T10:00:00", "session": "sess-1",
                               "fqid": "hub/x#y", "channel": "jit_delivered",
                               "count": 1})

    def test_build_row_rejects_unknown_channel(self):
        with self.assertRaises(ValueError):
            usage.build_row("hub/x#y", "telepathy", "2026-08-18T10:00:00", "s")

    def test_record_appends(self):
        usage.record(self.root, [usage.build_row("hub/x#y", "cited",
                                                 "2026-08-18T10:00:00", "s")])
        self.assertEqual(len(ledger.load_ledger(usage.default_path(self.root))), 1)

    def test_record_is_fail_silent(self):
        # The JIT injector calls this inside a PreToolUse hook. A raise here would
        # block the edit that triggered it, so a broken store must cost telemetry
        # and nothing else.
        usage.record(self.root / "no" / "such" / "\0bad", [{"ts": "x"}])

    def test_by_rule_totals_per_channel(self):
        rows = [usage.build_row("hub/x#y", "jit_delivered", "t", "s"),
                usage.build_row("hub/x#y", "jit_delivered", "t", "s2"),
                usage.build_row("hub/x#y", "cited", "t", "s"),
                usage.build_row("hub/x#z", "cited", "t", "s")]
        self.assertEqual(usage.by_rule(rows),
                         {"hub/x#y": {"jit_delivered": 2, "cited": 1},
                          "hub/x#z": {"cited": 1}})

    def test_by_rule_honours_count(self):
        rows = [usage.build_row("hub/x#y", "cited", "t", "s", count=5)]
        self.assertEqual(usage.by_rule(rows), {"hub/x#y": {"cited": 5}})


if __name__ == "__main__":
    unittest.main()
