import paths
import tempfile
import unittest
from pathlib import Path

import adjudications


class TestAdjudications(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_default_path(self):
        self.assertEqual(adjudications.default_path(self.root),
                         paths.local_dir(self.root) / "metrics" / "kb-adjudications.jsonl")

    def test_build_row(self):
        row = adjudications.build_row("k1", "hub/conventions#dto", "false_positive",
                                      "2026-08-18T10:00:00", "luca", "readonly class",
                                      service="billing-api")
        self.assertEqual(row, {"ts": "2026-08-18T10:00:00", "event_key": "k1",
                               "fqid": "hub/conventions#dto",
                               "verdict": "false_positive", "by": "luca",
                               "note": "readonly class", "service": "billing-api"})

    def test_build_row_service_defaults_to_none(self):
        row = adjudications.build_row("k1", "hub/conventions#dto", "false_positive",
                                      "2026-08-18T10:00:00", "luca", "readonly class")
        self.assertIsNone(row["service"])

    def test_build_row_rejects_unknown_verdict(self):
        # A free-text verdict silently poisons every precision number downstream, so
        # this is the one place in the KB tooling that fails loud rather than open.
        with self.assertRaises(ValueError):
            adjudications.build_row("k1", "hub/x#y", "probably_fine",
                                    "2026-08-18T10:00:00", "luca")

    def test_build_row_rejects_false_negative(self):
        # There is no event_key for a finding that was never produced. Accepting one
        # here would attach a miss to some unrelated finding and drag its precision
        # down, when a miss cannot change precision at all.
        with self.assertRaises(ValueError):
            adjudications.build_row("k1", "hub/x#y", "false_negative",
                                    "2026-08-18T10:00:00", "luca")

    def test_build_miss_row(self):
        row = adjudications.build_miss_row("hub/x#y", "app/A.php", "abc1234",
                                           "2026-08-18T10:00:00", "luca", "missed it",
                                           service="billing-api")
        self.assertEqual(row, {"ts": "2026-08-18T10:00:00", "event_key": None,
                               "fqid": "hub/x#y", "file": "app/A.php",
                               "head": "abc1234", "verdict": "false_negative",
                               "by": "luca", "note": "missed it",
                               "service": "billing-api"})

    def test_build_miss_row_service_defaults_to_none(self):
        row = adjudications.build_miss_row("hub/x#y", "app/A.php", "abc1234",
                                           "2026-08-18T10:00:00", "luca", "missed it")
        self.assertIsNone(row["service"])

    def test_latest_wins_per_event(self):
        rows = [adjudications.build_row("k1", "hub/x#y", "true_positive",
                                        "2026-08-18T10:00:00", "luca"),
                adjudications.build_row("k1", "hub/x#y", "false_positive",
                                        "2026-08-18T12:00:00", "luca"),
                adjudications.build_row("k2", "hub/x#y", "irrelevant",
                                        "2026-08-18T11:00:00", "luca")]
        latest = adjudications.latest(rows)
        self.assertEqual(latest["k1"]["verdict"], "false_positive")
        self.assertEqual(latest["k2"]["verdict"], "irrelevant")

    def test_latest_ignores_rows_without_event_key(self):
        self.assertEqual(adjudications.latest([{"verdict": "true_positive"}]), {})

    def test_latest_ignores_miss_rows(self):
        # The two shapes share one file. latest() must not pick up a miss row, whose
        # event_key is None by construction.
        rows = [adjudications.build_miss_row("hub/x#y", "app/A.php", "abc1234",
                                             "2026-08-18T10:00:00", "luca")]
        self.assertEqual(adjudications.latest(rows), {})

    def test_misses_keyed_by_rule_file_and_head(self):
        rows = [adjudications.build_miss_row("hub/x#y", "app/A.php", "abc1234",
                                             "2026-08-18T10:00:00", "luca"),
                adjudications.build_miss_row("hub/x#y", "app/A.php", "abc1234",
                                             "2026-08-18T12:00:00", "luca", "again"),
                adjudications.build_miss_row("hub/x#y", "app/B.php", "abc1234",
                                             "2026-08-18T11:00:00", "luca")]
        m = adjudications.misses(rows)
        self.assertEqual(len(m), 2)
        self.assertEqual(m[("hub/x#y", "app/A.php", "abc1234")]["note"], "again")

    def test_misses_ignores_event_rows(self):
        rows = [adjudications.build_row("k1", "hub/x#y", "true_positive",
                                        "2026-08-18T10:00:00", "luca")]
        self.assertEqual(adjudications.misses(rows), {})


if __name__ == "__main__":
    unittest.main()
