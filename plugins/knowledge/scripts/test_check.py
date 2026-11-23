import subprocess
import tempfile, unittest
from pathlib import Path
import lib
import check


class TestCheck(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "app" / "Services").mkdir(parents=True)

    def tearDown(self):
        self.tmp.cleanup()

    def _php(self, name, returns):
        body = "<?php\nfunction f() {\n" + "    return 1;\n" * returns + "}\n"
        (self.root / "app" / "Services" / name).write_text(body)
        return f"app/Services/{name}"

    def _check_rule(self, scope="file"):
        target = "{files}" if scope == "project" else "{file}"
        return lib.Rule(fqid="hub/static-analysis#s1142", scope="hub",
                        topic="static-analysis", id="s1142", title="returns",
                        applies_to={"globs": ["app/**/*.php"]}, severity="blocking",
                        check={"scope": scope,
                               "shell": "awk '/^[[:space:]]*return /' " + target + " | wc -l",
                               "flag_when": "> 3"})

    def test_failing_check_is_fail_outcome(self):
        rel = self._php("Foo.php", 5)  # 5 > 3
        records = check.evaluate(self.root, [rel], None, [self._check_rule()])
        self.assertEqual(len(records), 1)
        rule, label, outcome = records[0]
        self.assertEqual(outcome, "fail")
        self.assertEqual(label, rel)
        violations, reminders = check.partition(records)
        self.assertEqual(len(violations), 1)
        self.assertEqual(reminders, [])

    def test_passing_check_is_pass_outcome(self):
        rel = self._php("Bar.php", 2)  # 2 <= 3
        records = check.evaluate(self.root, [rel], None, [self._check_rule()])
        self.assertEqual([o for _, _, o in records], ["pass"])
        self.assertEqual(check.partition(records)[0], [])

    def test_judgment_rule_is_reminder_outcome(self):
        rel = self._php("Baz.php", 1)
        rule = lib.Rule(fqid="hub/api#scope-lookup", scope="hub", topic="api",
                        id="scope-lookup", title="idor", applies_to={"globs": ["app/**/*.php"]},
                        severity="blocking", override_policy="binding", check=None)
        records = check.evaluate(self.root, [rel], None, [rule])
        self.assertEqual([o for _, _, o in records], ["reminder"])
        _, reminders = check.partition(records)
        self.assertEqual(reminders[0][0].id, "scope-lookup")

    def test_sweep_only_rule_needs_include_flag(self):
        rel = self._php("Qux.php", 1)
        rule = lib.Rule(fqid="hub/conventions#noisy", scope="hub", topic="conventions",
                        id="noisy", title="noisy judgment rule",
                        applies_to={"globs": ["app/**/*.php"]}, sweep_only=True, check=None)
        self.assertEqual(check.evaluate(self.root, [rel], None, [rule]), [])
        records = check.evaluate(self.root, [rel], None, [rule], include_sweep_only=True)
        self.assertEqual([o for _, _, o in records], ["reminder"])

    def test_project_check_one_record_over_matched_files(self):
        f1 = self._php("A.php", 2)
        f2 = self._php("B.php", 3)  # aggregate 5 > 3
        records = check.evaluate(self.root, [f1, f2], None, [self._check_rule("project")])
        self.assertEqual(len(records), 1)            # one project-level record, not per-file
        _, label, outcome = records[0]
        self.assertEqual(outcome, "fail")
        self.assertIn("A.php", label)
        self.assertIn("B.php", label)

    def test_project_check_passes_under_limit(self):
        f1 = self._php("C.php", 1)
        f2 = self._php("D.php", 1)  # aggregate 2 <= 3
        records = check.evaluate(self.root, [f1, f2], None, [self._check_rule("project")])
        self.assertEqual([o for _, _, o in records], ["pass"])

    def test_no_match_yields_empty_census(self):
        records = check.evaluate(self.root, ["README.md"], None, [self._check_rule()])
        self.assertEqual(records, [])

    def test_inconclusive_when_command_not_numeric(self):
        rel = self._php("E.php", 1)
        rule = lib.Rule(fqid="hub/static-analysis#bad", scope="hub",
                        topic="static-analysis", id="bad", title="t",
                        applies_to={"globs": ["app/**/*.php"]}, severity="recommended",
                        check={"scope": "file", "shell": "echo not-a-number", "flag_when": "> 3"})
        records = check.evaluate(self.root, [rel], None, [rule])
        self.assertEqual([o for _, _, o in records], ["inconclusive"])


class TestBaseline(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "app").mkdir()
        self._git("init", "-q")
        self._git("config", "user.email", "t@t")
        self._git("config", "user.name", "t")

    def tearDown(self):
        self.tmp.cleanup()

    def _git(self, *args):
        subprocess.run(["git", "-C", str(self.root), *args], check=True, capture_output=True)

    def _php(self, name, returns):
        (self.root / "app" / name).write_text("<?php\n" + "return 1;\n" * returns)
        return f"app/{name}"

    def _rule(self):
        return lib.Rule(fqid="hub/static-analysis#r", scope="hub",
                        topic="static-analysis", id="r", title="t",
                        applies_to={"globs": ["app/**/*.php"]}, severity="blocking",
                        check={"scope": "file", "flag_when": "> 3",
                               "shell": "awk '/^[[:space:]]*return /' {file} | wc -l"})

    def _get_outcome(self, rel):
        recs = check.evaluate(self.root, [rel], None, [self._rule()], baseline="HEAD")
        return recs[0][2]

    def test_introduced_is_fail(self):
        self._php("A.php", 2)
        self._git("add", "-A"); self._git("commit", "-q", "-m", "b")
        (self.root / "app" / "A.php").write_text("<?php\n" + "return 1;\n" * 5)
        self.assertEqual(self._get_outcome("app/A.php"), "fail")

    def test_preexisting_unchanged_is_pass(self):
        self._php("B.php", 5)
        self._git("add", "-A"); self._git("commit", "-q", "-m", "b")
        self.assertEqual(self._get_outcome("app/B.php"), "pass")

    def test_worsened_is_fail(self):
        self._php("C.php", 4)
        self._git("add", "-A"); self._git("commit", "-q", "-m", "b")
        (self.root / "app" / "C.php").write_text("<?php\n" + "return 1;\n" * 6)
        self.assertEqual(self._get_outcome("app/C.php"), "fail")

    def test_reduced_but_still_over_is_pass(self):
        self._php("D.php", 6)
        self._git("add", "-A"); self._git("commit", "-q", "-m", "b")
        (self.root / "app" / "D.php").write_text("<?php\n" + "return 1;\n" * 4)
        self.assertEqual(self._get_outcome("app/D.php"), "pass")

    def test_new_file_is_gated(self):
        # E.php is never committed, and setUp makes no initial commit, so `git show HEAD:..`
        # fails -> baseline 0 -> the 5 returns are all "introduced".
        self._php("E.php", 5)
        self.assertEqual(self._get_outcome("app/E.php"), "fail")

    def test_non_repo_falls_back_to_absolute(self):
        with tempfile.TemporaryDirectory() as dname:
            root = Path(dname)
            (root / "app").mkdir()
            (root / "app" / "F.php").write_text("<?php\n" + "return 1;\n" * 5)
            recs = check.evaluate(root, ["app/F.php"], None, [self._rule()], baseline="HEAD")
            self.assertEqual(recs[0][2], "fail")   # no repo -> absolute -> flags

    def test_baseline_none_is_absolute(self):
        self._php("G.php", 5)
        self._git("add", "-A"); self._git("commit", "-q", "-m", "b")
        recs = check.evaluate(self.root, ["app/G.php"], None, [self._rule()])
        self.assertEqual(recs[0][2], "fail")


class TestBuildCmd(unittest.TestCase):
    def test_substitutes_uc_web_and_file(self):
        cmd = check._build_cmd("tool --rule {uc_web}/r.yml {file}", ["app/A.php"], "file", Path("/proj"))
        self.assertEqual(cmd, "tool --rule /proj/r.yml app/A.php")

    def test_substitutes_files_for_project_scope(self):
        cmd = check._build_cmd("tool {files}", ["a.php", "b.php"], "project", Path("/proj"))
        self.assertEqual(cmd, "tool a.php b.php")


class TestLedgerRecordFilter(unittest.TestCase):
    def _rec(self, outcome):
        rule = lib.Rule(fqid="hub/x#y", scope="hub", topic="x", id="y",
                        title="t")
        return (rule, "app/A.php", outcome)

    def test_hook_phases_drop_reminders(self):
        # edit and commit fire per keystroke and per commit. Persisting their reminder
        # rows would add one row per matched checkless rule every time -- the ledger
        # would grow with the size of the registry instead of with the work.
        records = [self._rec("reminder"), self._rec("fail"), self._rec("pass")]
        for phase in ("edit", "commit"):
            kept = check._ledger_records(records, phase)
            self.assertEqual([o for _, _, o in kept], ["fail", "pass"], phase)

    def test_sweep_and_adhoc_keep_reminders(self):
        # The sweep's reminder census IS the signal for the 327 checkless rules; it runs
        # rarely enough that the volume is fine.
        records = [self._rec("reminder"), self._rec("fail")]
        for phase in ("sweep", "adhoc"):
            self.assertEqual(len(check._ledger_records(records, phase)), 2, phase)

    def test_filter_is_independent_of_checks_only(self):
        # Regression guard for the coupling this task removes: the decision is the
        # phase's write frequency, not whether the caller asked for quiet output.
        records = [self._rec("reminder")]
        self.assertEqual(len(check._ledger_records(records, "adhoc")), 1)
        self.assertEqual(len(check._ledger_records(records, "edit")), 0)


class TestGitState(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_non_repo_is_none_none(self):
        check._git_state.cache_clear()
        check._is_git_repo.cache_clear()
        self.assertEqual(check._git_state(self.root), (None, None))

    def test_repo_reports_branch_and_head(self):
        check._git_state.cache_clear()
        check._is_git_repo.cache_clear()
        for args in (["init", "-q", "-b", "trunk"],
                     ["config", "user.email", "t@t"],
                     ["config", "user.name", "t"]):
            subprocess.run(["git", "-C", str(self.root)] + args, check=True,
                           capture_output=True)
        (self.root / "f.txt").write_text("x")
        subprocess.run(["git", "-C", str(self.root), "add", "f.txt"], check=True,
                       capture_output=True)
        subprocess.run(["git", "-C", str(self.root), "commit", "-qm", "c"], check=True,
                       capture_output=True)
        branch, head = check._git_state(self.root)
        self.assertEqual(branch, "trunk")
        self.assertRegex(head, r"^[0-9a-f]{7,}$")


class TestRegistryRoot(unittest.TestCase):
    CONFIG = {"registry_fallbacks": ["umbrella/{service}", "umbrella/libs/{service}"]}

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.config = {**lib.CONFIG_DEFAULTS, **self.CONFIG}

    def tearDown(self):
        self.tmp.cleanup()

    def _kb(self, *parts):
        (self.root.joinpath(*parts) / ".claude" / "knowledge").mkdir(parents=True)

    def test_direct_service_root_wins(self):
        self._kb("search-api")
        self.assertEqual(lib.registry_root(self.root, "search-api", self.config), self.root / "search-api")

    def test_falls_back_to_first_template(self):
        self._kb("umbrella", "shared")
        self.assertEqual(lib.registry_root(self.root, "shared", self.config),
                         self.root / "umbrella" / "shared")

    def test_falls_back_to_later_template(self):
        self._kb("umbrella", "libs", "some-lib")
        self.assertEqual(lib.registry_root(self.root, "some-lib", self.config),
                         self.root / "umbrella" / "libs" / "some-lib")

    def test_no_match_is_none(self):
        self.assertIsNone(lib.registry_root(self.root, "nowhere", self.config))

    def test_no_fallbacks_configured_means_direct_only(self):
        self._kb("umbrella", "shared")
        self.assertIsNone(lib.registry_root(self.root, "shared", lib.CONFIG_DEFAULTS))

    def test_direct_wins_over_fallback(self):
        # A fallback registry named after an existing top-level dir resolves to that dir's
        # registry, not its own. Refusing the name is lint's job, not this function's.
        self._kb("search-api")
        self._kb("umbrella", "libs", "search-api")
        self.assertEqual(lib.registry_root(self.root, "search-api", self.config), self.root / "search-api")


if __name__ == "__main__":
    unittest.main()
