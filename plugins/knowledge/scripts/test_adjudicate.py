import argparse
import tempfile
import unittest
from pathlib import Path

import adjudicate
import adjudications
import ledger


class TestPending(unittest.TestCase):
    def _inst(self, fqid, disposition):
        return {"fqid": fqid, "disposition": disposition, "label": "app/A.php",
                "branch": "main", "sev": "recommended", "edit": None,
                "commit": "2026-08-18T10:00:00", "sweep": None}

    def test_unadjudicated_only(self):
        classified = {"k1": self._inst("hub/x#a", "landed_advisory"),
                      "k2": self._inst("hub/x#b", "caught_at_edit")}
        pending = adjudicate.pending(classified, {"k2": {"verdict": "true_positive"}})
        self.assertEqual([p["event_key"] for p in pending], ["k1"])

    def test_misses_come_before_catches(self):
        # A miss is the expensive kind of wrong to leave unverified: it is what drives
        # "promote to blocking", which is exactly the advice that was wrong before.
        classified = {"k1": self._inst("hub/x#a", "caught_at_edit"),
                      "k2": self._inst("hub/x#b", "landed_ignored")}
        self.assertEqual([p["event_key"] for p in adjudicate.pending(classified, {})],
                         ["k2", "k1"])

    def test_false_negative_rows_do_not_mark_an_event_adjudicated(self):
        # The two shapes share one file. latest() is what feeds `adjudicated`, and it
        # must not let a miss row silently retire an unrelated pending finding.
        rows = [adjudications.build_miss_row("hub/x#a", "app/A.php", "abc1234",
                                             "2026-08-18T10:00:00", "luca")]
        classified = {"k1": self._inst("hub/x#a", "landed_advisory")}
        pending = adjudicate.pending(classified, adjudications.latest(rows))
        self.assertEqual([p["event_key"] for p in pending], ["k1"])

    def test_empty(self):
        self.assertEqual(adjudicate.pending({}, {}), [])


class TestRecordMiss(unittest.TestCase):
    def _args(self, **overrides):
        base = {"fqid": "hub/x#y", "file": "app/A.php", "head": "abc1234",
                "service": "billing-api", "note": ""}
        base.update(overrides)
        return argparse.Namespace(**base)

    def test_miss_without_service_errors(self):
        # Same shape as the pre-existing fqid/file/head guard: --miss without --service
        # must not silently record a row with no service to filter the join on.
        err = adjudicate._record_miss(self._args(service=None), None)
        self.assertEqual(err, "--miss requires --fqid, --file, --head and --service")

    def test_miss_with_service_records_it_in_the_store(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = Path(tmp) / "kb-adjudications.jsonl"
            err = adjudicate._record_miss(self._args(), store)
            self.assertIsNone(err)
            rows = ledger.load_ledger(store)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["service"], "billing-api")
