"""Offline tests for eval_reviewer.py: the reviewer is stubbed, no model call."""
import json
import tempfile
import unittest
from pathlib import Path

import eval_reviewer as ev

FIXTURES = Path(ev.FIXTURES)


def finding(kind):
    return {"kind": kind, "quote": "q", "evidence": "e", "reason": "r"}


class EvalTest(unittest.TestCase):
    def test_eval_scores_expectations(self):
        drift = {"findings_min": 1, "kinds": ["purpose-shift"]}
        clean = {"findings_max": 0}
        self.assertTrue(ev.meets(drift, [finding("purpose-shift")]))
        self.assertTrue(ev.meets(drift, [finding("purpose-shift"), finding("unput-change")]))
        self.assertFalse(ev.meets(drift, []))
        self.assertFalse(ev.meets(drift, [finding("misattributed")]))
        self.assertTrue(ev.meets(clean, []))
        self.assertFalse(ev.meets(clean, [finding("purpose-shift")]))

    def test_every_fixture_is_complete_and_has_a_valid_expectation(self):
        dirs = [d for d in FIXTURES.iterdir() if d.is_dir()]
        self.assertEqual(len(dirs), 10)
        for d in dirs:
            for name in ("snapshot.md", "draft.md", "users.md", "claude.md", "expect.json"):
                self.assertTrue((d / name).is_file(), f"{d.name}/{name}")
            expect = json.loads((d / "expect.json").read_text())
            if d.name.startswith("clean-"):
                self.assertEqual(expect, {"findings_max": 0})
                continue
            self.assertGreaterEqual(expect["findings_min"], 1)
            self.assertTrue(set(expect["kinds"]) <= set(ev.review.KINDS))

    def test_run_case_uses_stubbed_reviewer_and_counts_passes(self):
        calls = []

        def stub(payload):
            calls.append(payload)
            return {"findings": [finding("purpose-shift")], "meta": {"cost_usd": 0.01, "duration_ms": 2000}}

        expect, results = ev.run_case(FIXTURES / "drift-purpose-shift", 3, run=stub)
        self.assertEqual(len(calls), 3)
        self.assertEqual([r["ok"] for r in results], [True] * 3)
        self.assertIn("a fitness judge for ideas", calls[0])
        self.assertIn("I noticed that you fill gaps", calls[0])

    def test_run_case_counts_unavailable_as_failure(self):
        def stub(payload):
            raise ev.review.ReviewerUnavailable("down")

        _, results = ev.run_case(FIXTURES / "clean-user-edit", 2, run=stub)
        self.assertEqual([r["ok"] for r in results], [False, False])


if __name__ == "__main__":
    unittest.main()
