import os
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock

import adjudications
import ledger
import lib
import report
import usage


def _rule(fqid, check=None, digest_only=False, sweep_only=False):
    scope, rest = fqid.split("/", 1)
    topic, rid = rest.split("#", 1)
    return lib.Rule(fqid=fqid, scope=scope, topic=topic, id=rid, title="t", check=check,
                    digest_only=digest_only, sweep_only=sweep_only)


class TestReport(unittest.TestCase):
    def test_aggregate_counts_outcomes_and_distinct_runs(self):
        rows = [
            {"run": "r1", "fqid": "m/api#a", "outcome": "fail", "ts": "2026-06-05T10:00:00", "service": None},
            {"run": "r1", "fqid": "m/api#a", "outcome": "fail", "ts": "2026-06-05T10:00:00", "service": None},
            {"run": "r2", "fqid": "m/api#a", "outcome": "pass", "ts": "2026-06-05T11:00:00", "service": None},
        ]
        rules = [_rule("m/api#a", check={"shell": "x", "flag_when": "> 0"}), _rule("m/api#z")]
        a = report.aggregate(rows, rules)["per_rule"]["m/api#a"]
        self.assertEqual(a["rows"], 3)
        self.assertEqual(a["runs"], 2)            # distinct runs, not rows
        self.assertEqual(a["fails"], 2)
        self.assertEqual(a["passes"], 1)
        self.assertAlmostEqual(a["violation_rate"], 2 / 3)

    def test_violated_row_flags_a_fqid_still_in_the_registry(self):
        rows = [{"run": "r1", "fqid": "m/api#a", "outcome": "fail", "ts": "2026-06-05T10:00:00"}]
        agg = report.aggregate(rows, [_rule("m/api#a")])
        self.assertTrue(agg["per_rule"]["m/api#a"]["in_registry"])
        self.assertTrue(agg["violated"][0]["in_registry"])

    def test_violated_row_flags_a_fqid_removed_from_the_registry(self):
        # the rule that produced this ledger history was since renamed, merged, or
        # deleted — the row is historical only, not something a rule edit can fix.
        rows = [{"run": "r1", "fqid": "m/api#gone", "outcome": "fail", "ts": "2026-06-05T10:00:00"}]
        agg = report.aggregate(rows, [])
        self.assertFalse(agg["per_rule"]["m/api#gone"]["in_registry"])
        self.assertFalse(agg["violated"][0]["in_registry"])

    def test_violated_row_flags_a_sweep_only_rule(self):
        # a sweep_only rule's check never runs at edit time (lib.file_matches excludes
        # it there), so any fails/passes recorded came from a review-sweep run only.
        rows = [{"run": "r1", "fqid": "m/api#a", "outcome": "fail", "ts": "2026-06-05T10:00:00"}]
        rules = [_rule("m/api#a", sweep_only=True)]
        agg = report.aggregate(rows, rules)
        self.assertTrue(agg["per_rule"]["m/api#a"]["sweep_only"])
        self.assertTrue(agg["violated"][0]["sweep_only"])

    def test_violated_row_flags_a_non_sweep_only_rule_as_false(self):
        rows = [{"run": "r1", "fqid": "m/api#a", "outcome": "fail", "ts": "2026-06-05T10:00:00"}]
        agg = report.aggregate(rows, [_rule("m/api#a")])
        self.assertFalse(agg["per_rule"]["m/api#a"]["sweep_only"])
        self.assertFalse(agg["violated"][0]["sweep_only"])

    def test_dead_rules_are_registry_minus_fired(self):
        rows = [{"run": "r1", "fqid": "m/api#a", "outcome": "reminder", "ts": "2026-06-05T10:00:00"}]
        rules = [_rule("m/api#a"), _rule("m/api#z")]
        self.assertEqual(report.aggregate(rows, rules)["dead"], ["m/api#z"])

    def test_digest_only_rules_are_not_dead(self):
        # lib.file_matches short-circuits digest_only, so these can never fire again;
        # listing one as dead is a false positive no amount of work can clear.
        rules = [_rule("m/api#a"), _rule("m/api#d", digest_only=True)]
        agg = report.aggregate([], rules)
        self.assertEqual(agg["dead"], ["m/api#a"])
        self.assertEqual(agg["totals"]["dead"], 1)
        self.assertEqual(agg["totals"]["digest_only"], 1)

    def test_digest_only_still_counts_as_fired_when_it_has_history(self):
        # the flag is the rule's state today; the ledger is history. A rule flagged after
        # it had already logged rows keeps them, so the counts overlap and never partition.
        rows = [{"run": "r1", "fqid": "m/api#d", "outcome": "reminder", "ts": "2026-06-05T10:00:00"}]
        agg = report.aggregate(rows, [_rule("m/api#d", digest_only=True)])
        self.assertEqual(agg["totals"]["fired"], 1)
        self.assertEqual(agg["totals"]["dead"], 0)
        self.assertEqual(agg["totals"]["digest_only"], 1)

    def test_noisy_excludes_rules_with_a_check(self):
        rows = [
            {"run": "r1", "fqid": "m/api#a", "outcome": "reminder", "ts": "2026-06-05T00:00:00"},
            {"run": "r2", "fqid": "m/api#b", "outcome": "reminder", "ts": "2026-06-05T00:00:00"},
        ]
        rules = [_rule("m/api#a"), _rule("m/api#b", check={"shell": "x", "flag_when": "> 0"})]
        noisy = [v["fqid"] for v in report.aggregate(rows, rules)["noisy"]]
        self.assertIn("m/api#a", noisy)
        self.assertNotIn("m/api#b", noisy)        # has a check -> not a check-synthesis candidate

    def test_by_day_series(self):
        rows = [
            {"run": "r1", "fqid": "m/api#a", "outcome": "fail", "ts": "2026-06-05T10:00:00"},
            {"run": "r2", "fqid": "m/api#a", "outcome": "pass", "ts": "2026-06-06T09:00:00"},
        ]
        by_day = report.aggregate(rows, [_rule("m/api#a")])["by_day"]
        self.assertEqual(by_day, [{"day": "2026-06-05", "runs": 1, "failing_runs": 1},
                                  {"day": "2026-06-06", "runs": 1, "failing_runs": 0}])

    def test_by_day_failing_runs_counts_distinct_runs_not_fail_rows(self):
        # one run tripping two rules on the same day must count once, not twice —
        # otherwise a single noisy run reads as several bad days worth of failures.
        rows = [
            {"run": "r1", "fqid": "m/api#a", "outcome": "fail", "ts": "2026-06-05T10:00:00"},
            {"run": "r1", "fqid": "m/api#b", "outcome": "fail", "ts": "2026-06-05T10:00:01"},
        ]
        by_day = report.aggregate(rows, [_rule("m/api#a"), _rule("m/api#b")])["by_day"]
        self.assertEqual(by_day, [{"day": "2026-06-05", "runs": 1, "failing_runs": 1}])

    def test_by_day_zero_fills_gaps_between_active_days(self):
        rows = [
            {"run": "r1", "fqid": "m/api#a", "outcome": "fail", "ts": "2026-06-05T10:00:00"},
            {"run": "r2", "fqid": "m/api#a", "outcome": "pass", "ts": "2026-06-08T09:00:00"},
        ]
        by_day = report.aggregate(rows, [_rule("m/api#a")])["by_day"]
        self.assertEqual(by_day, [
            {"day": "2026-06-05", "runs": 1, "failing_runs": 1},
            {"day": "2026-06-06", "runs": 0, "failing_runs": 0},
            {"day": "2026-06-07", "runs": 0, "failing_runs": 0},
            {"day": "2026-06-08", "runs": 1, "failing_runs": 0},
        ])

    def test_aggregate_empty_rows(self):
        agg = report.aggregate([], [_rule("m/api#a"), _rule("m/api#b")])
        self.assertEqual(agg["per_rule"], {})
        self.assertEqual(agg["dead"], ["m/api#a", "m/api#b"])
        self.assertEqual(agg["by_day"], [])
        self.assertEqual(agg["totals"],
                         {"registry": 2, "fired": 0, "dead": 2, "digest_only": 0, "runs": 0})

    def test_filter_rows_by_service_keeps_null(self):
        rows = [{"service": "billing-api", "ts": "t"}, {"service": None, "ts": "t"},
                {"service": "catalog-api", "ts": "t"}]
        self.assertEqual(len(report.filter_rows(rows, "billing-api", None)), 2)

    def test_filter_rows_by_days_drops_old(self):
        rows = [{"ts": "2000-01-01T00:00:00", "service": None},
                {"ts": "2999-01-01T00:00:00", "service": None}]
        out = report.filter_rows(rows, None, 1)
        self.assertEqual([r["ts"] for r in out], ["2999-01-01T00:00:00"])

    def test_filter_rows_by_since_is_an_inclusive_absolute_cutoff(self):
        rows = [{"ts": "2026-07-13T23:59:59", "service": None},
                {"ts": "2026-07-14T00:00:00", "service": None},
                {"ts": "2026-07-20T10:00:00", "service": None}]
        out = report.filter_rows(rows, None, None, since="2026-07-14")
        self.assertEqual([r["ts"] for r in out],
                         ["2026-07-14T00:00:00", "2026-07-20T10:00:00"])

    def test_filter_rows_since_accepts_full_iso_timestamp(self):
        rows = [{"ts": "2026-07-14T09:00:00", "service": None},
                {"ts": "2026-07-14T11:00:00", "service": None}]
        out = report.filter_rows(rows, None, None, since="2026-07-14T10:00:00")
        self.assertEqual([r["ts"] for r in out], ["2026-07-14T11:00:00"])

    def test_filter_rows_days_and_since_both_apply(self):
        rows = [{"ts": "2000-01-01T00:00:00", "service": None},   # fails days
                {"ts": "2999-01-01T00:00:00", "service": None}]   # passes both
        out = report.filter_rows(rows, None, 1, since="2026-07-14")
        self.assertEqual([r["ts"] for r in out], ["2999-01-01T00:00:00"])

    def test_normalize_since_rejects_garbage(self):
        self.assertIsNone(report.normalize_since(None))
        self.assertIsNone(report.normalize_since(""))
        with self.assertRaises(ValueError):
            report.normalize_since("last tuesday")

    def test_postcommit_markers_are_excluded_from_by_day_and_runs(self):
        # postcommit rows are markers ("a commit landed"), not check-engine activity —
        # they carry no fqid/outcome of their own (ledger.commit_rows()). Counting them
        # here would inflate both the by-day series and totals["runs"] with rows that
        # never ran a check.
        rows = [
            {"run": "r1", "fqid": "m/api#a", "outcome": "fail",
             "ts": "2026-06-05T10:00:00", "phase": "commit"},
            {"run": "r2", "fqid": None, "outcome": "committed",
             "ts": "2026-06-05T10:05:00", "phase": "postcommit"},
        ]
        agg = report.aggregate(rows, [_rule("m/api#a", check={"shell": "x", "flag_when": "> 0"})])
        self.assertEqual(agg["by_day"], [{"day": "2026-06-05", "runs": 1, "failing_runs": 1}])
        self.assertEqual(agg["totals"]["runs"], 1)

    def test_filter_rows_by_source(self):
        rows = [{"src": "hook", "ts": "2026-06-05T00:00:00"}, {"src": "skill", "ts": "2026-06-05T00:00:00"}]
        self.assertEqual(report.filter_rows(rows, None, None, "hook"),
                         [{"src": "hook", "ts": "2026-06-05T00:00:00"}])


class TestClassify(unittest.TestCase):
    def _row(self, key, phase, ts, outcome="fail", sev="recommended",
             fqid="hub/conventions#r", head="abc1234", dedup="d1",
             service="billing-api", label="app/A.php"):
        return {"event_key": key, "dedup_key": dedup, "phase": phase, "ts": ts,
                "outcome": outcome, "sev": sev, "fqid": fqid, "label": label,
                "branch": "main", "head": head, "service": service}

    def _marker(self, parent, ts, label="app/A.php", service="billing-api"):
        return {"phase": "postcommit", "ts": ts, "outcome": "committed", "fqid": None,
                "label": label, "service": service, "head": "def5678", "parent": parent}

    def test_edit_plus_commit_marker_is_caught(self):
        c = report.classify([self._row("k1", "edit", "2026-08-18T10:00:00"),
                             self._marker("abc1234", "2026-08-18T10:05:00")])
        self.assertEqual(c["k1"]["disposition"], "caught_at_edit")

    def test_edit_without_a_commit_marker_is_unresolved(self):
        # Abandoned, stashed, reverted, or still open. None of those is a catch.
        c = report.classify([self._row("k1", "edit", "2026-08-18T10:00:00")])
        self.assertEqual(c["k1"]["disposition"], "unresolved")

    def test_marker_for_another_file_does_not_credit_a_catch(self):
        c = report.classify([self._row("k1", "edit", "2026-08-18T10:00:00"),
                             self._marker("abc1234", "2026-08-18T10:05:00",
                                          label="app/Other.php")])
        self.assertEqual(c["k1"]["disposition"], "unresolved")

    def test_marker_on_another_parent_does_not_credit_a_catch(self):
        # The commit has to have landed on the HEAD the edit was judged against.
        c = report.classify([self._row("k1", "edit", "2026-08-18T10:00:00"),
                             self._marker("999zzzz", "2026-08-18T10:05:00")])
        self.assertEqual(c["k1"]["disposition"], "unresolved")

    def test_edit_then_commit_is_ignored(self):
        c = report.classify([self._row("k1", "edit", "2026-08-18T10:00:00"),
                             self._row("k1", "commit", "2026-08-18T10:05:00")])
        self.assertEqual(c["k1"]["disposition"], "landed_ignored")

    def test_commit_only_recommended_is_advisory(self):
        # check.py exits 0 for a recommended violation, so the commit always lands.
        c = report.classify([self._row("k1", "commit", "2026-08-18T10:05:00")])
        self.assertEqual(c["k1"]["disposition"], "landed_advisory")

    def test_commit_blocking_is_blocked(self):
        c = report.classify([self._row("k1", "commit", "2026-08-18T10:05:00",
                                       sev="blocking")])
        self.assertEqual(c["k1"]["disposition"], "blocked_at_commit")

    def test_sweep_only_is_ungated(self):
        c = report.classify([self._row("k1", "sweep", "2026-08-18T11:00:00")])
        self.assertEqual(c["k1"]["disposition"], "landed_ungated")

    def test_sweep_re_sighting_of_a_gated_violation_is_already_counted(self):
        # The sweep's baseline is the branch base, not HEAD, so the same violation gets
        # a fresh event_key under a later HEAD. dedup_key is what catches that. Counting
        # it again would report one violation as both landed_advisory and landed_ungated.
        rows = [self._row("k1", "commit", "2026-08-18T10:05:00", dedup="d1"),
                self._row("k2", "sweep", "2026-08-18T11:00:00", dedup="d1",
                          head="fff9999")]
        c = report.classify(rows)
        self.assertEqual(c["k1"]["disposition"], "landed_advisory")
        self.assertEqual(c["k2"]["disposition"], "already_counted")

    def test_sweep_before_any_gate_row_still_counts_as_ungated(self):
        # Suppression is ordered: only an EARLIER gate row means "already counted".
        rows = [self._row("k2", "sweep", "2026-08-18T09:00:00", dedup="d1"),
                self._row("k1", "commit", "2026-08-18T10:05:00", dedup="d1")]
        c = report.classify(rows)
        self.assertEqual(c["k2"]["disposition"], "landed_ungated")

    def test_dedup_is_branch_scoped_not_global(self):
        # Different branch => different dedup_key => no suppression. Guards against
        # someone "simplifying" dedup_key down to (fqid, file).
        rows = [self._row("k1", "commit", "2026-08-18T10:05:00", dedup="main:d"),
                self._row("k2", "sweep", "2026-08-18T11:00:00", dedup="feat:d")]
        self.assertEqual(report.classify(rows)["k2"]["disposition"], "landed_ungated")

    def test_legacy_rows_without_phase_are_skipped(self):
        self.assertEqual(report.classify([{"fqid": "hub/x#y", "outcome": "fail",
                                           "ts": "2026-06-05T10:00:00"}]), {})

    def test_rows_without_an_event_key_are_skipped(self):
        # Project-scope checks and root-repo runs. In the census, out of the model.
        row = self._row("k1", "commit", "2026-08-18T10:05:00")
        del row["event_key"]
        self.assertEqual(report.classify([row]), {})

    def test_non_fail_rows_are_not_instances(self):
        self.assertEqual(report.classify([self._row("k1", "edit", "2026-08-18T10:00:00",
                                                    outcome="pass")]), {})

    def test_replayed_runs_collapse_to_one_instance(self):
        # The 2026-08-18 spike was 16 violations replayed by 5 sweep runs. One key,
        # one instance, whatever the run count.
        rows = [self._row("k1", "sweep", "2026-08-18T1%d:00:00" % n) for n in range(5)]
        c = report.classify(rows)
        self.assertEqual(len(c), 1)
        self.assertEqual(c["k1"]["sweep"], "2026-08-18T10:00:00")


class TestEffectiveness(unittest.TestCase):
    def _c(self, fqid, disposition):
        return {"fqid": fqid, "disposition": disposition}

    def test_counts_and_rate(self):
        classified = {
            "a": self._c("hub/x#r", "caught_at_edit"),
            "b": self._c("hub/x#r", "blocked_at_commit"),
            "c": self._c("hub/x#r", "landed_ignored"),
            "d": self._c("hub/x#r", "landed_advisory"),
        }
        out = report.effectiveness(classified)
        self.assertEqual(len(out), 1)
        row = out[0]
        self.assertEqual(row["instances"], 4)
        self.assertEqual(row["catches"], 2)
        self.assertEqual(row["misses"], 2)
        self.assertEqual(row["landed_ignored"], 1)
        self.assertEqual(row["landed_advisory"], 1)
        self.assertEqual(row["landed_ungated"], 0)
        self.assertEqual(row["effectiveness"], 0.5)

    def test_non_counting_dispositions_stay_out_of_the_rate(self):
        # unresolved and already_counted are reported, never scored: one is an unknown
        # outcome, the other is a duplicate. Folding either in would move the rate on
        # evidence that says nothing about whether the rule worked.
        classified = {
            "a": self._c("hub/x#r", "caught_at_edit"),
            "b": self._c("hub/x#r", "landed_ignored"),
            "c": self._c("hub/x#r", "unresolved"),
            "d": self._c("hub/x#r", "already_counted"),
        }
        row = report.effectiveness(classified)[0]
        self.assertEqual(row["instances"], 2)
        self.assertEqual(row["effectiveness"], 0.5)
        self.assertEqual(row["unresolved"], 1)
        self.assertEqual(row["already_counted"], 1)

    def test_only_non_counting_instances_give_no_rate(self):
        row = report.effectiveness({"a": self._c("hub/x#r", "unresolved")})[0]
        self.assertEqual(row["instances"], 0)
        self.assertIsNone(row["effectiveness"])
        self.assertEqual(row["unresolved"], 1)

    def test_sorted_worst_first(self):
        classified = {
            "a": self._c("hub/x#good", "caught_at_edit"),
            "b": self._c("hub/x#bad", "landed_ignored"),
            "c": self._c("hub/x#bad", "landed_ungated"),
        }
        self.assertEqual([r["fqid"] for r in report.effectiveness(classified)],
                         ["hub/x#bad", "hub/x#good"])

    def test_empty_is_empty(self):
        self.assertEqual(report.effectiveness({}), [])


class TestPrecisionJoin(unittest.TestCase):
    def _c(self, fqid, disposition):
        return {"fqid": fqid, "disposition": disposition}

    def test_precision_from_verdicts(self):
        classified = {"a": self._c("hub/x#r", "landed_advisory"),
                      "b": self._c("hub/x#r", "landed_advisory"),
                      "c": self._c("hub/x#r", "caught_at_edit")}
        adjudicated = {"a": {"verdict": "true_positive"},
                       "b": {"verdict": "false_positive"}}
        row = report.effectiveness(classified, adjudicated)[0]
        self.assertEqual(row["true_positive"], 1)
        self.assertEqual(row["false_positive"], 1)
        self.assertEqual(row["unadjudicated"], 1)
        self.assertEqual(row["precision"], 0.5)

    def test_precision_is_none_when_nothing_adjudicated(self):
        # Not 1.0. An unverified rule is unverified, and reporting it as perfect is how
        # a 100%-false-positive rule ends up recommended for promotion to blocking.
        classified = {"a": self._c("hub/x#r", "landed_advisory")}
        row = report.effectiveness(classified, {})[0]
        self.assertIsNone(row["precision"])
        self.assertEqual(row["unadjudicated"], 1)

    def test_irrelevant_does_not_count_toward_precision(self):
        classified = {"a": self._c("hub/x#r", "landed_advisory"),
                      "b": self._c("hub/x#r", "landed_advisory")}
        adjudicated = {"a": {"verdict": "irrelevant"}, "b": {"verdict": "irrelevant"}}
        row = report.effectiveness(classified, adjudicated)[0]
        self.assertIsNone(row["precision"])

    def test_false_negatives_lower_recall_and_leave_precision_alone(self):
        classified = {"a": self._c("hub/x#r", "landed_advisory")}
        adjudicated = {"a": {"verdict": "true_positive"}}
        misses = {("hub/x#r", "app/A.php", "abc1234"): {"fqid": "hub/x#r"},
                  ("hub/x#r", "app/B.php", "abc1234"): {"fqid": "hub/x#r"}}
        row = report.effectiveness(classified, adjudicated, misses)[0]
        self.assertEqual(row["precision"], 1.0)      # it was right about what it found
        self.assertEqual(row["false_negative"], 2)
        self.assertAlmostEqual(row["recall"], 1 / 3)  # and it found one of three

    def test_a_rule_with_only_misses_still_gets_a_row(self):
        # The rule that never fires is invisible to the event pipeline. A recorded
        # false negative is the only evidence it is broken, so it must not be dropped
        # for having no classified instances.
        misses = {("hub/x#r", "app/A.php", "abc1234"): {"fqid": "hub/x#r"}}
        row = report.effectiveness({}, {}, misses)[0]
        self.assertEqual(row["fqid"], "hub/x#r")
        self.assertEqual(row["instances"], 0)
        self.assertIsNone(row["effectiveness"])
        self.assertEqual(row["recall"], 0.0)

    def test_effectiveness_still_works_without_adjudications(self):
        classified = {"a": self._c("hub/x#r", "caught_at_edit")}
        row = report.effectiveness(classified)[0]
        self.assertEqual(row["catches"], 1)
        self.assertIsNone(row["precision"])
        self.assertIsNone(row["recall"])

    def test_recall_is_none_with_a_backlog_and_no_confirmed_catch(self):
        # true_positive=0, one recorded false_negative, and an unadjudicated finding for
        # the same fqid still sitting in the backlog: that unjudged finding could turn
        # out to be a true positive, so recall must not read as a confident 0%.
        classified = {"a": self._c("hub/x#r", "landed_advisory")}
        misses = {("hub/x#r", "app/A.php", "abc1234"): {"fqid": "hub/x#r"}}
        row = report.effectiveness(classified, {}, misses)[0]
        self.assertEqual(row["true_positive"], 0)
        self.assertGreater(row["unadjudicated"], 0)
        self.assertIsNone(row["recall"])

    def test_recall_is_zero_once_the_backlog_is_fully_judged(self):
        # Same shape, but nothing is left unadjudicated: every produced finding has been
        # judged one way or another, so a real 0% is now the honest answer.
        classified = {"a": self._c("hub/x#r", "landed_advisory")}
        adjudicated = {"a": {"verdict": "false_positive"}}
        misses = {("hub/x#r", "app/A.php", "abc1234"): {"fqid": "hub/x#r"}}
        row = report.effectiveness(classified, adjudicated, misses)[0]
        self.assertEqual(row["true_positive"], 0)
        self.assertEqual(row["unadjudicated"], 0)
        self.assertEqual(row["recall"], 0.0)


class TestAggregateAdjudicationJoin(unittest.TestCase):
    """`aggregate()`'s join against the adjudication store: it must re-read the store on
    every call (no cross-call cache) and scope it to the same service/days/since window
    the caller filtered `rows` to, exactly like `report.main()` and `dashboard.py`
    already do for `rows` itself."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.patcher = mock.patch.dict(os.environ, {"CLAUDE_PROJECT_DIR": str(self.root)})
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        self.addCleanup(self.tmp.cleanup)

    def _write(self, *rows):
        ledger.append(adjudications.default_path(self.root), list(rows))

    def _event_row(self, event_key, fqid="hub/x#r", service="billing-api"):
        return {"event_key": event_key, "dedup_key": "d1", "phase": "commit",
                "ts": "2026-08-18T10:00:00", "outcome": "fail", "sev": "recommended",
                "fqid": fqid, "label": "app/A.php", "branch": "main", "head": "abc1234",
                "service": service}

    def test_join_respects_service_and_days_window(self):
        now = datetime.now().isoformat(timespec="seconds")
        old = "2000-01-01T00:00:00"
        self._write(
            adjudications.build_miss_row("hub/x#in", "app/A.php", "abc1234", now,
                                         "luca", service="billing-api"),
            adjudications.build_miss_row("hub/x#wrong-service", "app/B.php",
                                         "abc1234", now, "luca",
                                         service="catalog-api"),
            adjudications.build_miss_row("hub/x#stale", "app/C.php", "abc1234",
                                         old, "luca", service="billing-api"),
        )
        agg = report.aggregate([], [], service="billing-api", days=7)
        fqids = {e["fqid"] for e in agg["effectiveness"]}
        self.assertIn("hub/x#in", fqids)
        self.assertNotIn("hub/x#wrong-service", fqids)
        self.assertNotIn("hub/x#stale", fqids)

    def test_aggregate_does_not_cache_the_adjudication_store(self):
        # Locks in fc82c2a: aggregate() must re-read the store fresh every call, because
        # dashboard.py is a long-lived process polled every 5s. A reintroduced cache
        # would freeze this at "no verdict yet" forever.
        rows = [self._event_row("k1")]
        agg1 = report.aggregate(rows, [])
        row1 = next(e for e in agg1["effectiveness"] if e["fqid"] == "hub/x#r")
        self.assertIsNone(row1["precision"])

        self._write(adjudications.build_row("k1", "hub/x#r", "true_positive",
                                            "2026-08-18T10:05:00", "luca",
                                            service="billing-api"))

        agg2 = report.aggregate(rows, [])
        row2 = next(e for e in agg2["effectiveness"] if e["fqid"] == "hub/x#r")
        self.assertEqual(row2["precision"], 1.0)

    def test_join_wires_verdicts_and_misses_to_the_right_fqid(self):
        # Black-box check that adjudications.latest(adj) and adjudications.misses(adj)
        # are wired to the right parameter slots in effectiveness(), and that both draw
        # from the same filtered `adj` rather than two independent reads.
        rows = [self._event_row("kA", fqid="hub/x#a")]
        self._write(
            adjudications.build_row("kA", "hub/x#a", "true_positive",
                                    "2026-08-18T10:05:00", "luca",
                                    service="billing-api"),
            adjudications.build_miss_row("hub/x#b", "app/B.php", "abc1234",
                                         "2026-08-18T10:05:00", "luca",
                                         service="billing-api"),
        )
        agg = report.aggregate(rows, [])
        by_fqid = {e["fqid"]: e for e in agg["effectiveness"]}
        self.assertEqual(by_fqid["hub/x#a"]["true_positive"], 1)
        self.assertEqual(by_fqid["hub/x#a"]["false_negative"], 0)
        self.assertEqual(by_fqid["hub/x#b"]["true_positive"], 0)
        self.assertEqual(by_fqid["hub/x#b"]["false_negative"], 1)


class TestRetireCandidates(unittest.TestCase):
    def _rule(self, rid, **kw):
        base = dict(fqid=f"hub/t#{rid}", scope="hub", topic="t", id=rid,
                    title="T")
        base.update(kw)
        return lib.Rule(**base)

    def test_delivered_never_used_is_a_candidate(self):
        rules = [self._rule("a")]
        per_rule = {"hub/t#a": {"fqid": "hub/t#a", "fails": 0, "rows": 40}}
        by_rule = {"hub/t#a": {"jit_delivered": 40}}
        got = report.retire_candidates(per_rule, by_rule, rules)
        self.assertEqual([c["fqid"] for c in got], ["hub/t#a"])
        self.assertEqual(got[0]["delivered"], 40)
        self.assertEqual(got[0]["cited"], 0)

    def test_cited_rule_is_not_a_candidate(self):
        rules = [self._rule("a")]
        per_rule = {"hub/t#a": {"fqid": "hub/t#a", "fails": 0, "rows": 40}}
        by_rule = {"hub/t#a": {"jit_delivered": 40, "cited": 3}}
        self.assertEqual(report.retire_candidates(per_rule, by_rule, rules), [])

    def test_rule_with_failures_is_not_a_candidate(self):
        # It caught something. Delivery volume is a cost, not a verdict.
        rules = [self._rule("a")]
        per_rule = {"hub/t#a": {"fqid": "hub/t#a", "fails": 2, "rows": 40}}
        self.assertEqual(report.retire_candidates(per_rule, {"hub/t#a":
                                                             {"jit_delivered": 40}},
                                                  rules), [])

    def test_never_delivered_rule_is_not_a_candidate(self):
        # Zero deliveries means zero evidence either way, and calling that useless is
        # the mistake this whole report exists to stop. It belongs in DEAD, which
        # already says it may be an untouched area.
        rules = [self._rule("a")]
        self.assertEqual(report.retire_candidates({}, {}, rules), [])

    def test_sorted_by_delivery_cost(self):
        rules = [self._rule("a"), self._rule("b")]
        per_rule = {"hub/t#a": {"fqid": "hub/t#a", "fails": 0, "rows": 1},
                    "hub/t#b": {"fqid": "hub/t#b", "fails": 0, "rows": 1}}
        by_rule = {"hub/t#a": {"jit_delivered": 3},
                   "hub/t#b": {"jit_delivered": 30}}
        self.assertEqual([c["fqid"] for c in
                          report.retire_candidates(per_rule, by_rule, rules)],
                         ["hub/t#b", "hub/t#a"])

    def test_sorted_by_delivery_cost_ties_break_ascending_by_fqid(self):
        # reverse=True previously applied to the whole tuple, so a tie on `delivered`
        # sorted fqid descending (z before a). The fix negates delivered instead, so
        # ties break ascending.
        rules = [self._rule("z"), self._rule("a")]
        per_rule = {"hub/t#z": {"fqid": "hub/t#z", "fails": 0, "rows": 1},
                    "hub/t#a": {"fqid": "hub/t#a", "fails": 0, "rows": 1}}
        by_rule = {"hub/t#z": {"jit_delivered": 10},
                   "hub/t#a": {"jit_delivered": 10}}
        self.assertEqual([c["fqid"] for c in
                          report.retire_candidates(per_rule, by_rule, rules)],
                         ["hub/t#a", "hub/t#z"])


class TestResidentUsage(unittest.TestCase):
    def _rule(self, rid, resident=False, sweep_only=False):
        return lib.Rule(fqid=f"hub/t#{rid}", scope="hub", topic="t", id=rid,
                        title="T", resident=resident, sweep_only=sweep_only)

    def test_only_resident_rules_are_included(self):
        rules = [self._rule("a", resident=True), self._rule("b", resident=False)]
        got = report.resident_usage({}, rules)
        self.assertEqual([r["fqid"] for r in got], ["hub/t#a"])

    def test_sweep_only_is_joined_in_from_the_rule(self):
        rules = [self._rule("a", resident=True, sweep_only=True),
                 self._rule("b", resident=True, sweep_only=False)]
        got = {r["fqid"]: r["sweep_only"] for r in report.resident_usage({}, rules)}
        self.assertTrue(got["hub/t#a"])
        self.assertFalse(got["hub/t#b"])

    def test_cited_count_is_joined_in_from_usage_rows(self):
        rules = [self._rule("a", resident=True)]
        got = report.resident_usage({"hub/t#a": {"cited": 5}}, rules)
        self.assertEqual(got[0]["cited"], 5)

    def test_missing_usage_row_defaults_cited_to_zero(self):
        # registry membership, not a ledger derivation — a resident rule with no
        # citation history is still listed, just at zero.
        rules = [self._rule("a", resident=True)]
        got = report.resident_usage({}, rules)
        self.assertEqual(got[0]["cited"], 0)

    def test_sorted_by_cited_desc_ties_break_ascending_by_fqid(self):
        rules = [self._rule("z", resident=True), self._rule("a", resident=True)]
        usage_rows = {"hub/t#z": {"cited": 2}, "hub/t#a": {"cited": 2}}
        got = report.resident_usage(usage_rows, rules)
        self.assertEqual([r["fqid"] for r in got], ["hub/t#a", "hub/t#z"])


class TestAggregateMostDeliveredAndCited(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.patcher = mock.patch.dict(os.environ, {"CLAUDE_PROJECT_DIR": str(self.root)})
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        self.addCleanup(self.tmp.cleanup)

    def _write_usage(self, *rows):
        ledger.append(usage.default_path(self.root), list(rows))

    def test_most_delivered_ranks_by_jit_delivered_desc(self):
        now = datetime.now().isoformat(timespec="seconds")
        self._write_usage(
            usage.build_row("hub/t#a", "jit_delivered", now, "s1", count=3),
            usage.build_row("hub/t#b", "jit_delivered", now, "s1", count=9),
        )
        rules = [_rule("hub/t#a"), _rule("hub/t#b")]
        agg = report.aggregate([], rules)
        self.assertEqual([r["fqid"] for r in agg["most_delivered"]],
                         ["hub/t#b", "hub/t#a"])

    def test_most_delivered_excludes_rules_with_no_jit_delivered_row(self):
        # cited-only usage must not leak into the jit_delivered ranking.
        now = datetime.now().isoformat(timespec="seconds")
        self._write_usage(usage.build_row("hub/t#a", "cited", now, "s1", count=1))
        agg = report.aggregate([], [_rule("hub/t#a")])
        self.assertEqual(agg["most_delivered"], [])

    def test_most_cited_ranks_by_cited_desc(self):
        now = datetime.now().isoformat(timespec="seconds")
        self._write_usage(
            usage.build_row("hub/t#a", "cited", now, "s1", count=1),
            usage.build_row("hub/t#b", "cited", now, "s1", count=4),
        )
        rules = [_rule("hub/t#a"), _rule("hub/t#b")]
        agg = report.aggregate([], rules)
        self.assertEqual([r["fqid"] for r in agg["most_cited"]],
                         ["hub/t#b", "hub/t#a"])

    def test_most_delivered_flags_a_sweep_only_rule(self):
        now = datetime.now().isoformat(timespec="seconds")
        self._write_usage(usage.build_row("hub/t#a", "jit_delivered", now, "s1", count=3))
        agg = report.aggregate([], [_rule("hub/t#a", sweep_only=True)])
        self.assertTrue(agg["most_delivered"][0]["sweep_only"])

    def test_most_cited_flags_a_sweep_only_rule(self):
        now = datetime.now().isoformat(timespec="seconds")
        self._write_usage(usage.build_row("hub/t#a", "cited", now, "s1", count=1))
        agg = report.aggregate([], [_rule("hub/t#a", sweep_only=True)])
        self.assertTrue(agg["most_cited"][0]["sweep_only"])

    def test_most_delivered_flags_a_fqid_removed_from_the_registry(self):
        now = datetime.now().isoformat(timespec="seconds")
        self._write_usage(usage.build_row("hub/t#gone", "jit_delivered", now, "s1", count=2))
        agg = report.aggregate([], [])   # the rule that used to exist is gone from the registry
        self.assertFalse(agg["most_delivered"][0]["in_registry"])

    def test_most_cited_flags_a_fqid_removed_from_the_registry(self):
        now = datetime.now().isoformat(timespec="seconds")
        self._write_usage(usage.build_row("hub/t#gone", "cited", now, "s1", count=1))
        agg = report.aggregate([], [])
        self.assertFalse(agg["most_cited"][0]["in_registry"])


class TestAggregateJitByDay(unittest.TestCase):
    """jit_by_day: distinct fqids actually jit_delivered per day. digest_resident carries
    no per-day signal at all (usage.py: no writer), so this series is jit_delivered-only
    by design, not an oversight."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.patcher = mock.patch.dict(os.environ, {"CLAUDE_PROJECT_DIR": str(self.root)})
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        self.addCleanup(self.tmp.cleanup)

    def _write_usage(self, *rows):
        ledger.append(usage.default_path(self.root), list(rows))

    def test_counts_distinct_fqids_delivered_that_day(self):
        self._write_usage(
            usage.build_row("hub/t#a", "jit_delivered", "2026-06-05T10:00:00", "s1"),
            usage.build_row("hub/t#b", "jit_delivered", "2026-06-05T11:00:00", "s1"),
        )
        agg = report.aggregate([], [])
        self.assertEqual(agg["jit_by_day"], [{"day": "2026-06-05", "unique_jit_rules": 2}])

    def test_same_fqid_delivered_twice_the_same_day_counts_once(self):
        self._write_usage(
            usage.build_row("hub/t#a", "jit_delivered", "2026-06-05T10:00:00", "s1"),
            usage.build_row("hub/t#a", "jit_delivered", "2026-06-05T14:00:00", "s2"),
        )
        agg = report.aggregate([], [])
        self.assertEqual(agg["jit_by_day"], [{"day": "2026-06-05", "unique_jit_rules": 1}])

    def test_excludes_other_usage_channels(self):
        self._write_usage(usage.build_row("hub/t#a", "cited", "2026-06-05T10:00:00", "s1"))
        agg = report.aggregate([], [])
        self.assertEqual(agg["jit_by_day"], [])

    def test_zero_fills_gaps_between_active_days(self):
        self._write_usage(
            usage.build_row("hub/t#a", "jit_delivered", "2026-06-05T10:00:00", "s1"),
            usage.build_row("hub/t#a", "jit_delivered", "2026-06-08T10:00:00", "s1"),
        )
        agg = report.aggregate([], [])
        self.assertEqual(agg["jit_by_day"], [
            {"day": "2026-06-05", "unique_jit_rules": 1},
            {"day": "2026-06-06", "unique_jit_rules": 0},
            {"day": "2026-06-07", "unique_jit_rules": 0},
            {"day": "2026-06-08", "unique_jit_rules": 1},
        ])

    def test_empty_when_no_usage_rows(self):
        agg = report.aggregate([], [])
        self.assertEqual(agg["jit_by_day"], [])


class TestAggregateWindowZeroFill(unittest.TestCase):
    """by_day and jit_by_day must zero-fill back to the header's requested days/since
    window, not just the earliest day that happened to have a row. Otherwise a sparse
    channel like jit_delivered silently shrinks its chart to its own tiny active range
    while a dense channel like the ledger's run rows coincidentally looks unaffected —
    the header sets the same window for both, so both must honor it the same way."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.patcher = mock.patch.dict(os.environ, {"CLAUDE_PROJECT_DIR": str(self.root)})
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        self.addCleanup(self.tmp.cleanup)

    def _write_usage(self, *rows):
        ledger.append(usage.default_path(self.root), list(rows))

    def test_jit_by_day_extends_back_to_the_requested_days_window(self):
        now = datetime.now().isoformat(timespec="seconds")
        self._write_usage(usage.build_row("hub/t#a", "jit_delivered", now, "s1"))
        agg = report.aggregate([], [], days=5)
        self.assertEqual(len(agg["jit_by_day"]), 6)   # today plus 5 zero-filled days back
        self.assertEqual(agg["jit_by_day"][0]["unique_jit_rules"], 0)
        self.assertEqual(agg["jit_by_day"][-1]["unique_jit_rules"], 1)

    def test_by_day_extends_back_to_the_requested_days_window(self):
        now = datetime.now().isoformat(timespec="seconds")
        rows = [{"ts": now, "run": "r1", "fqid": "hub/t#a", "outcome": "pass"}]
        agg = report.aggregate(rows, [], days=5)
        self.assertEqual(len(agg["by_day"]), 6)
        self.assertEqual(agg["by_day"][0]["runs"], 0)
        self.assertEqual(agg["by_day"][-1]["runs"], 1)

    def test_blank_header_keeps_the_natural_earliest_active_day(self):
        old = "2026-06-05T10:00:00"
        self._write_usage(usage.build_row("hub/t#a", "jit_delivered", old, "s1"))
        agg = report.aggregate([], [])
        self.assertEqual(agg["jit_by_day"][0]["day"], "2026-06-05")

    def test_blank_header_jit_by_day_follows_by_days_older_span(self):
        # jit_delivered logging shipped weeks after the ledger itself, so under a blank
        # header jit_by_day must not clip to its own newer earliest row — it should
        # follow by_day's older span, the same window the header visually represents.
        self._write_usage(usage.build_row("hub/t#a", "jit_delivered",
                                          "2026-06-08T10:00:00", "s1"))
        rows = [
            {"ts": "2026-06-05T09:00:00", "run": "r0", "fqid": "hub/t#x", "outcome": "pass"},
            {"ts": "2026-06-08T09:00:00", "run": "r1", "fqid": "hub/t#x", "outcome": "pass"},
        ]
        agg = report.aggregate(rows, [])
        self.assertEqual(agg["by_day"][0]["day"], "2026-06-05")
        self.assertEqual(agg["jit_by_day"], [
            {"day": "2026-06-05", "unique_jit_rules": 0},
            {"day": "2026-06-06", "unique_jit_rules": 0},
            {"day": "2026-06-07", "unique_jit_rules": 0},
            {"day": "2026-06-08", "unique_jit_rules": 1},
        ])


class TestAggregateUsageWindow(unittest.TestCase):
    """usage_rows (and the rent/retire signals derived from it) must be windowed by the
    same service/days/since the caller already filtered `rows` to. Otherwise a rule
    whose only catch happened outside the window reads fails=0 (per_rule is windowed
    via `rows`) while its all-time jit_delivered/cited counts still make it look like a
    retire candidate, when really it just fired outside the selected window."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.patcher = mock.patch.dict(os.environ, {"CLAUDE_PROJECT_DIR": str(self.root)})
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        self.addCleanup(self.tmp.cleanup)

    def _write_usage(self, *rows):
        ledger.append(usage.default_path(self.root), list(rows))

    def test_usage_rows_are_windowed_by_days(self):
        now = datetime.now().isoformat(timespec="seconds")
        old = "2000-01-01T00:00:00"
        self._write_usage(
            usage.build_row("hub/t#in", "jit_delivered", now, "s1"),
            usage.build_row("hub/t#old", "jit_delivered", old, "s2"),
        )
        rules = [_rule("hub/t#in"), _rule("hub/t#old")]
        agg = report.aggregate([], rules, days=7)
        self.assertIn("hub/t#in", agg["usage"])
        self.assertNotIn("hub/t#old", agg["usage"])

    def test_retire_candidates_exclude_usage_outside_the_window(self):
        # Before the fix, this fqid would land on the retire list: rows=[] means
        # per_rule={} so fails=0, and the unwindowed usage store still shows
        # jit_delivered=40/cited=0 from outside the window.
        old = "2000-01-01T00:00:00"
        self._write_usage(usage.build_row("hub/t#old", "jit_delivered", old, "s1",
                                          count=40))
        rules = [_rule("hub/t#old")]
        agg = report.aggregate([], rules, days=7)
        self.assertNotIn("hub/t#old", agg["usage"])
        self.assertEqual(agg["retire"], [])


class TestAggregateSweepSurfaced(unittest.TestCase):
    """sweep_surfaced has no store producer; it's derived from ledger rows already
    passed to aggregate() (phase=sweep, outcome=reminder)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.patcher = mock.patch.dict(os.environ, {"CLAUDE_PROJECT_DIR": str(self.root)})
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        self.addCleanup(self.tmp.cleanup)

    def test_sweep_reminder_rows_count_as_delivered_with_no_usage_store_row(self):
        rows = [{"run": "r1", "fqid": "hub/t#a", "outcome": "reminder",
                 "phase": "sweep", "ts": "2026-08-18T10:00:00", "service": None}]
        rules = [_rule("hub/t#a")]
        agg = report.aggregate(rows, rules)
        self.assertEqual(agg["usage"]["hub/t#a"]["sweep_surfaced"], 1)
        candidate = next((c for c in agg["retire"] if c["fqid"] == "hub/t#a"), None)
        self.assertIsNotNone(candidate)
        self.assertEqual(candidate["delivered"], 1)

    def test_no_sweep_surfaced_key_when_there_is_no_matching_row(self):
        # usage.by_rule's contract: absent channels are absent, not zero.
        agg = report.aggregate([], [_rule("hub/t#a")])
        self.assertNotIn("hub/t#a", agg["usage"])


if __name__ == "__main__":
    unittest.main()
