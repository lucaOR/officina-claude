import paths
import tempfile, unittest
from pathlib import Path
import lib
import ledger


def _rule(fqid="hub/api#x", sev="recommended"):
    scope, rest = fqid.split("/", 1)
    topic, rid = rest.split("#", 1)
    return lib.Rule(fqid=fqid, scope=scope, topic=topic, id=rid, title="t", severity=sev)


class TestLedger(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_default_path(self):
        self.assertEqual(ledger.default_path(self.root),
                         paths.local_dir(self.root) / "metrics" / "kb-ledger.jsonl")

    def test_build_rows_one_per_record(self):
        records = [(_rule("hub/api#a", "blocking"), "app/A.php", "fail"),
                   (_rule("hub/api#b"), "app/B.php", "reminder")]
        rows = ledger.build_rows(records, "billing-api", "hook",
                                 "2026-06-05T10:00:00", "run1",
                                 phase="commit", branch="main", head="abc1234",
                                 baseline="HEAD")
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0], {
            "ts": "2026-06-05T10:00:00", "run": "run1", "src": "hook",
            "service": "billing-api", "fqid": "hub/api#a", "sev": "blocking",
            "outcome": "fail", "label": "app/A.php", "phase": "commit",
            "branch": "main", "head": "abc1234", "baseline": "HEAD",
            "event_key": ledger.event_key("hub/api#a", "app/A.php", "abc1234"),
            "dedup_key": ledger.dedup_key("hub/api#a", "app/A.php", "main"),
        })
        self.assertEqual(rows[1]["outcome"], "reminder")

    def test_reminder_rows_carry_no_keys(self):
        # A reminder is not a violation instance, so there is nothing to pair across
        # phases and a key would only invent identity that does not exist.
        rows = ledger.build_rows([(_rule(), "app/B.php", "reminder")], None, "skill",
                                 "2026-08-18T10:00:00", "r", head="abc1234")
        self.assertNotIn("event_key", rows[0])
        self.assertNotIn("dedup_key", rows[0])

    def test_build_rows_defaults_are_backwards_compatible(self):
        rows = ledger.build_rows([(_rule(), "app/B.php", "pass")], None, "adhoc",
                                 "2026-08-18T10:00:00", "r")
        self.assertEqual(rows[0]["phase"], "adhoc")
        self.assertIsNone(rows[0]["branch"])
        self.assertIsNone(rows[0]["head"])
        self.assertIsNone(rows[0]["baseline"])

    def test_event_key_pairs_across_phases_and_splits_across_heads(self):
        # Same violation seen by the edit hook and again by the commit gate: HEAD has
        # not moved between them, so the key matches and the two rows pair up.
        edit = ledger.event_key("hub/api#a", "app/A.php", "abc1234")
        commit = ledger.event_key("hub/api#a", "app/A.php", "abc1234")
        self.assertEqual(edit, commit)
        # Once the commit lands, HEAD moves and a surviving violation is a new instance
        # rather than a second sighting of the old one.
        self.assertNotEqual(edit, ledger.event_key("hub/api#a", "app/A.php", "def5678"))
        self.assertNotEqual(edit, ledger.event_key("hub/api#b", "app/A.php", "abc1234"))
        self.assertNotEqual(edit, ledger.event_key("hub/api#a", "app/B.php", "abc1234"))

    def test_dedup_key_is_head_independent_and_branch_scoped(self):
        # The sweep's baseline is the branch base, not HEAD, so a violation it reports
        # may already have a commit-phase row under an older HEAD. dedup_key is what
        # spots that; it must therefore NOT vary with head, and must vary with branch.
        at_commit = ledger.dedup_key("hub/api#a", "app/A.php", "feat/x")
        at_sweep = ledger.dedup_key("hub/api#a", "app/A.php", "feat/x")
        self.assertEqual(at_commit, at_sweep)
        self.assertNotEqual(at_commit, ledger.dedup_key("hub/api#a", "app/A.php", "main"))
        self.assertNotEqual(at_commit, ledger.dedup_key("hub/api#b", "app/A.php", "feat/x"))

    def test_project_scope_check_rows_carry_no_keys(self):
        # label is ", ".join(matched), which differs per caller: one file at edit time,
        # the staged set at commit time, the branch diff at sweep time. No pairing is
        # possible, so no key is emitted rather than a key that never matches.
        rule = _rule("hub/infrastructure#p")
        rule.check = {"shell": "true", "flag_when": "> 0", "scope": "project"}
        rows = ledger.build_rows([(rule, "a.php, b.php", "fail")], None, "skill",
                                 "2026-08-18T10:00:00", "r", head="abc1234",
                                 branch="main")
        self.assertNotIn("event_key", rows[0])
        self.assertNotIn("dedup_key", rows[0])
        self.assertEqual(rows[0]["outcome"], "fail")   # still in the census

    def test_keyed_false_suppresses_keys(self):
        # The project's root repo has neither hook wired, so its rows must not enter the
        # event model at all -- otherwise every KB edit reads as a coverage failure.
        rows = ledger.build_rows([(_rule(), "app/A.php", "fail")], None, "adhoc",
                                 "2026-08-18T10:00:00", "r", head="abc1234",
                                 branch="main", keyed=False)
        self.assertNotIn("event_key", rows[0])
        self.assertNotIn("dedup_key", rows[0])

    def test_append_then_load_round_trip(self):
        path = ledger.default_path(self.root)
        ledger.append(path, [{"fqid": "x", "outcome": "pass"}])
        ledger.append(path, [{"fqid": "y", "outcome": "fail"}])
        self.assertEqual([r["fqid"] for r in ledger.load_ledger(path)], ["x", "y"])

    def test_load_missing_file_is_empty(self):
        self.assertEqual(ledger.load_ledger(self.root / "nope.jsonl"), [])

    def test_load_skips_malformed_lines(self):
        path = self.root / "l.jsonl"
        path.write_text('{"fqid":"ok"}\nnot-json\n{"fqid":"ok2"}\n')
        self.assertEqual([r["fqid"] for r in ledger.load_ledger(path)], ["ok", "ok2"])

    def test_append_empty_is_noop(self):
        path = ledger.default_path(self.root)
        ledger.append(path, [])
        self.assertFalse(path.exists())

    def test_append_creates_missing_parents(self):
        path = self.root / "deep" / "nested" / "l.jsonl"
        ledger.append(path, [{"fqid": "x"}])
        self.assertTrue(path.exists())


class TestCommitRows(unittest.TestCase):
    def test_one_marker_per_file_carrying_the_parent(self):
        rows = ledger.commit_rows(["app/A.php", "app/B.php"], "billing-api",
                                  "2026-08-18T10:00:00", "run1", "main",
                                  "def5678", "abc1234")
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0], {
            "ts": "2026-08-18T10:00:00", "run": "run1", "src": "hook",
            "service": "billing-api", "fqid": None, "sev": None,
            "outcome": "committed", "label": "app/A.php", "phase": "postcommit",
            "branch": "main", "head": "def5678", "parent": "abc1234",
            "baseline": None,
        })

    def test_marker_fqid_is_none_so_the_rule_census_skips_it(self):
        # report.py:61 guards its per-rule aggregation with `if fqid:`. A marker is not
        # a rule hit and must not appear as one.
        rows = ledger.commit_rows(["app/A.php"], None, "t", "r", "main", "d", "a")
        self.assertIsNone(rows[0]["fqid"])

    def test_no_files_no_rows(self):
        self.assertEqual(ledger.commit_rows([], None, "t", "r", "main", "d", "a"), [])


if __name__ == "__main__":
    unittest.main()
