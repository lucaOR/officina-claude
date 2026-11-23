import copy
import json
import subprocess
import unittest
from pathlib import Path

from testsupport import CLI, HERE, CliTestCase, fixture
import testsupport


class ChangesTestCase(CliTestCase):
    def setUp(self):
        super().setUp()
        self.project = self.tmp / "project"
        self.project.mkdir()
        self.dir = self.init_plan()
        src = fixture()
        patch = {"set": {k: v for k, v in src.items() if k not in ("decisions", "tasks", "scenarios", "slug")},
                 "upsert": src["decisions"] + src["tasks"] + src["scenarios"]}
        self.apply(patch, kind="author")

    def init_plan(self, slug="demo", env_extra=None):
        r = self.cli("init", slug, "--title", "Demo", "--date", "2026-11-19", "--project", self.project)
        self.assertEqual(r.returncode, 0, r.stderr)
        return Path(r.stdout.strip())

    def apply(self, patch, kind="change", summary="edit", check=True):
        r = self.cli("apply", self.dir, self.write(patch), "--kind", kind, "--summary", summary)
        if check:
            self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        return r

    def popen_apply(self, patch):
        return subprocess.Popen(["node", str(CLI), "apply", str(self.dir), self.write(patch), "--kind", "change",
                                 "--summary", "x"], env=self.env(), cwd=self.tmp, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def read(self, name):
        return json.loads((self.dir / name).read_text())

    def working(self): return self.read("working.json")
    def changes(self): return self.read("changes.json")
    def working_bytes(self): return (self.dir / "working.json").read_bytes()

    def el(self, coll, code): return next(e for e in self.working()[coll] if e["id"] == code)
    def decision(self, code): return self.el("decisions", code)
    def task(self, code): return self.el("tasks", code)
    def scenario(self, code): return self.el("scenarios", code)

    def without_slot(self, code, slot):
        d = copy.deepcopy(self.decision(code))
        del d["slots"][slot]
        return d


class ChangesTest(ChangesTestCase):
    def test_init_layout(self):
        self.assertEqual(self.dir, self.project / "docs" / "plans" / "2026-11-19-demo")
        for name in ("working.json", "changes.json", "threads.json", "questions.jsonl", "handled.jsonl"):
            self.assertTrue((self.dir / name).exists(), name)
        self.assertFalse((self.dir / "plan.json").exists())
        self.assertEqual(self.read("threads.json"), {"next": 1, "threads": []})
        self.assertEqual((self.dir / "questions.jsonl").read_text(), "")

    def test_init_skeleton(self):
        d = self.init_plan("other")
        w = json.loads((d / "working.json").read_text())
        self.assertEqual(w["counters"], {"D": 0, "T": 0, "S": 0})
        self.assertEqual(w["decisions"], [])
        self.assertEqual(json.loads((d / "changes.json").read_text()), {"next": 1, "log": []})

    def test_plans_dir_env(self):
        import os
        old = os.environ.get("PLANNING_PLANS_DIR")
        os.environ["PLANNING_PLANS_DIR"] = "plans/x"
        try:
            d = self.init_plan("envd")
        finally:
            if old is None: del os.environ["PLANNING_PLANS_DIR"]
            else: os.environ["PLANNING_PLANS_DIR"] = old
        self.assertEqual(d, self.project / "plans" / "x" / "2026-11-19-envd")

    def test_state_dir_matches_python(self):
        py = self.state_dir(self.dir)
        js = subprocess.run(["node", "-e", "import('./lib/store.mjs').then(m => console.log(m.stateDir(process.argv[1])))", str(self.dir)],
                            capture_output=True, text=True, env=self.env(), cwd=HERE, check=True).stdout.strip()
        self.assertEqual(str(py), js)
        self.assertFalse(py.exists())

    def test_author_writes_are_not_changes(self):
        self.assertEqual(self.changes()["log"], [])
        self.assertEqual(self.working()["counters"], {"D": 4, "T": 2, "S": 2})

    def test_author_apply_returns_null_change_and_sets_no_flags(self):
        r = self.apply({"upsert": [{**self.decision("D1"), "title": "Reject blank questions"}]}, kind="author")
        self.assertIsNone(json.loads(r.stdout)["change"])
        self.assertFalse(self.task("T1")["recheck"])

    def diagnostics(self, r):
        self.assertEqual(r.returncode, 1, r.stderr + r.stdout)
        return [(d["code"], d["path"]) for d in json.loads(r.stdout)["diagnostics"]]

    def test_stale_author_upsert_cannot_revert_a_pick(self):
        stale = copy.deepcopy(self.decision("D4"))  # the open D4 the session last wrote
        self.cli_json("pick", self.dir, "D4", "b")
        before = self.working_bytes()
        stale["more"] = {"related": ["D2"]}
        r = self.apply({"upsert": [stale]}, kind="author", check=False)
        self.assertEqual(self.diagnostics(r), [("pick-by-author", "decisions[D4].state"),
                                               ("pick-by-author", "decisions[D4].pick"),
                                               ("pick-by-author", "decisions[D4].whyPick")])
        self.assertEqual(self.working_bytes(), before)
        d = self.decision("D4")
        self.assertEqual((d["state"], d["pick"], d["whyPick"]), ("settled", "b", "Bounded size."))

    def test_author_cannot_edit_a_settled_why_pick_but_a_change_can(self):
        r = self.apply({"upsert": [{**self.decision("D1"), "whyPick": "new"}]}, kind="author", check=False)
        self.assertEqual(self.diagnostics(r), [("pick-by-author", "decisions[D1].whyPick")])
        self.apply({"upsert": [{**self.decision("D1"), "whyPick": "new"}]}, kind="change")  # no --question needed
        self.assertEqual(self.decision("D1")["whyPick"], "new")
        self.assertEqual(self.changes()["log"][0]["kind"], "change")

    def test_author_may_repeat_a_pick_and_set_one_on_a_new_decision(self):
        self.cli_json("pick", self.dir, "D4", "b")
        self.apply({"upsert": [{**self.decision("D4"), "more": {"related": ["D2"]}}]}, kind="author")
        self.assertEqual(self.decision("D4")["more"], {"related": ["D2"]})
        fresh = {**self.decision("D1"), "id": "D5", "title": "Settled in the interview", "whyPick": "The user said so."}
        self.apply({"upsert": [fresh]}, kind="author")
        self.assertEqual(self.decision("D5")["state"], "settled")

    def test_upsert_without_a_string_id_is_refused(self):
        before = self.working_bytes()
        no_id = {k: v for k, v in self.decision("D4").items() if k != "id"}
        for element in (no_id, {**no_id, "id": 5}, None):
            with self.subTest(element=element):
                r = self.apply({"upsert": [self.decision("D1"), element]}, kind="author", check=False)
                self.assertEqual(self.diagnostics(r), [("id-missing", "upsert[1]")])
                self.assertEqual(self.working_bytes(), before)

    def test_domain_id_must_be_a_slug(self):
        before = self.working_bytes()
        for bad in ("Task 1", "D-5", "5xx", "a.b", ""):
            with self.subTest(id=bad):
                r = self.apply({"upsert": [{"id": bad, "title": "Phantom?", "checks": []}]}, kind="author", check=False)
                self.assertIn(("domain-id-format", f"domains[{bad}].id"), self.diagnostics(r))
                self.assertEqual(self.working_bytes(), before)
        self.apply({"upsert": [{"id": "retry-2", "title": "How often do we retry?", "checks": []}]}, kind="author")
        self.assertEqual([d["id"] for d in self.working()["domains"]], ["ask", "store", "retry-2"])

    def test_counters_bump_for_new_ids(self):
        d = {**self.decision("D4"), "id": "D7", "title": "New"}
        self.apply({"upsert": [d]}, kind="author")
        self.assertEqual(self.working()["counters"]["D"], 7)

    def test_change_records_before_and_after_and_flags_links(self):
        self.apply({"upsert": [{**self.decision("D1"), "whyPick": "new"}]}, kind="change")
        c = self.changes()["log"][0]
        self.assertEqual({t["code"] for t in c["touched"]}, {"D1", "T1", "S1"})
        d1 = next(t for t in c["touched"] if t["code"] == "D1")
        self.assertEqual(d1["before"]["whyPick"], "Callers learn about mistakes early.")
        self.assertEqual(d1["after"]["whyPick"], "new")
        self.assertEqual(c["id"], "c1")
        self.assertTrue(self.task("T1")["recheck"])
        self.assertTrue(self.scenario("S1")["recheck"])
        self.assertFalse(self.task("T2")["recheck"])

    def test_noop_change_logs_nothing(self):
        r = self.apply({"upsert": [self.decision("D1")]}, kind="change")
        self.assertIsNone(json.loads(r.stdout)["change"])
        self.assertEqual(self.changes()["log"], [])

    def test_invalid_patch_leaves_working_untouched(self):
        before = self.working_bytes()
        r = self.apply({"upsert": [self.without_slot("D1", "scale")]}, kind="change", check=False)
        self.assertEqual(r.returncode, 1)
        self.assertEqual(json.loads(r.stdout)["diagnostics"][0]["code"], "slot-missing")
        self.assertEqual(self.working_bytes(), before)
        self.assertEqual(self.changes()["log"], [])

    def test_pick_settles_and_is_idempotent(self):
        self.cli("pick", self.dir, "D4", "b")
        self.cli("pick", self.dir, "D4", "b")
        d = self.decision("D4")
        self.assertEqual((d["state"], d["pick"], d["whyPick"]), ("settled", "b", "Bounded size."))
        self.assertEqual(len(self.changes()["log"]), 1)
        self.assertEqual(self.changes()["log"][0]["kind"], "pick")
        self.assertTrue(self.task("T2")["recheck"])

    def test_pick_unknown_option_is_a_diagnostic(self):
        r = self.cli("pick", self.dir, "D4", "z")
        self.assertEqual(r.returncode, 1)
        self.assertEqual(self.changes()["log"], [])

    def test_undo_restores_before(self):
        self.cli("pick", self.dir, "D4", "b")
        r = self.cli_json("undo", self.dir, "c1", )
        self.assertEqual(r["undone"], ["c1"])
        d = self.decision("D4")
        self.assertEqual(d["state"], "open")
        self.assertNotIn("pick", d)
        self.assertFalse(self.task("T2")["recheck"])
        self.assertEqual(self.changes()["log"], [])

    def test_undo_conflict_names_later_change(self):
        self.cli("pick", self.dir, "D4", "b")
        self.apply({"upsert": [{**self.decision("D4"), "whyPick": "x"}]}, kind="change")
        before = self.working_bytes()
        r = self.cli("undo", self.dir, "c1")
        self.assertEqual(r.returncode, 3)
        self.assertEqual(json.loads(r.stdout)["conflict"][0]["id"], "c2")
        self.assertEqual(self.working_bytes(), before)

    def test_undo_with_later_undoes_both(self):
        self.cli("pick", self.dir, "D4", "b")
        self.apply({"upsert": [{**self.decision("D4"), "whyPick": "x"}]}, kind="change")
        r = self.cli_json("undo", self.dir, "c1", "--with-later")
        self.assertEqual(r["undone"], ["c2", "c1"])
        self.assertEqual(self.decision("D4")["state"], "open")
        self.assertEqual(self.changes()["log"], [])

    def test_undo_of_creation_deletes_element(self):
        d = {**self.decision("D4"), "id": "D5", "title": "Fresh"}
        self.apply({"upsert": [d]}, kind="change")
        self.cli_json("undo", self.dir, "c1")
        self.assertFalse(any(e["id"] == "D5" for e in self.working()["decisions"]))
        self.assertEqual(self.working()["counters"]["D"], 5)

    def test_undo_aborts_when_deletion_breaks_references(self):
        d = {**self.decision("D4"), "id": "D5", "title": "Fresh"}
        self.apply({"upsert": [d]}, kind="change")
        t = {**self.task("T1"), "decisions": ["D1", "D5"]}
        self.apply({"upsert": [t]}, kind="author")
        before = self.working_bytes()
        r = self.cli("undo", self.dir, "c1")
        self.assertEqual(r.returncode, 1)
        self.assertEqual(self.working_bytes(), before)
        self.assertEqual(len(self.changes()["log"]), 1)

    def test_undo_unknown_change(self):
        self.assertEqual(self.cli("undo", self.dir, "c9").returncode, 1)

    def test_change_ids_never_reused(self):
        self.cli("pick", self.dir, "D4", "b")
        self.cli_json("undo", self.dir, "c1")
        self.cli("pick", self.dir, "D4", "a")
        self.assertEqual(self.changes()["log"][0]["id"], "c2")
        self.assertEqual(self.changes()["next"], 3)

    def test_set_field_is_touched_and_undoable(self):
        self.apply({"set": {"goal": "Another goal."}}, kind="change")
        self.assertEqual(self.changes()["log"][0]["touched"][0]["code"], "field:goal")
        self.cli_json("undo", self.dir, "c1")
        self.assertEqual(self.working()["goal"], "Answer a question and store the answer.")

    def test_update_real_writes_plan_and_md_and_clears_log(self):
        self.cli("pick", self.dir, "D4", "b")
        self.cli_json("update", self.dir)
        self.assertEqual(self.read("plan.json"), self.working())
        self.assertTrue((self.dir / "plan.md").read_text().startswith("# "))
        self.assertEqual(self.changes(), {"next": 2, "log": []})

    def test_update_refuses_a_plan_without_its_header(self):
        fresh = self.init_plan("bare")
        before = (fresh / "changes.json").read_bytes()
        r = self.cli("update", fresh)
        self.assertEqual(r.returncode, 1, r.stderr + r.stdout)
        found = [(d["code"], d["path"]) for d in json.loads(r.stdout)["diagnostics"]]
        self.assertEqual(found, [("header-missing", "goal"), ("header-missing", "architecture"), ("header-missing", "techStack")])
        self.assertFalse((fresh / "plan.json").exists())
        self.assertFalse((fresh / "plan.md").exists())
        self.assertEqual((fresh / "changes.json").read_bytes(), before)
        self.apply({"set": {"techStack": " "}}, kind="author")
        r = self.cli("update", self.dir)
        self.assertEqual([d["path"] for d in json.loads(r.stdout)["diagnostics"]], ["techStack"])
        self.assertFalse((self.dir / "plan.md").exists())

    def test_concurrent_applies_are_both_recorded(self):
        d1 = {**self.decision("D1"), "whyPick": "one"}
        d2 = {**self.decision("D2"), "whyPick": "two"}
        procs = [self.popen_apply({"upsert": [d]}) for d in (d1, d2)]
        for p in procs:
            _, err = p.communicate()
            self.assertEqual(p.returncode, 0, err)
        self.assertEqual(len(self.changes()["log"]), 2)
        self.assertEqual(self.decision("D1")["whyPick"], "one")
        self.assertEqual(self.decision("D2")["whyPick"], "two")

    def test_help_lists_new_commands(self):
        out = self.cli("--help").stdout
        for name in ("init", "apply", "pick", "undo", "update"):
            self.assertTrue(any(l.startswith(name) for l in out.splitlines()), name)

    def test_runtime_errors_print_one_json_line(self):
        again = self.cli("init", "demo", "--title", "Demo", "--date", "2026-11-19", "--project", self.project)
        missing = self.cli("next", self.tmp / "no-such-plan")
        for r in (again, missing):
            with self.subTest(args=r.args[2:4]):
                self.assertEqual(r.returncode, 1)
                self.assertEqual(r.stderr, "")
                self.assertEqual(len(r.stdout.splitlines()), 1)
                out = json.loads(r.stdout)
                self.assertFalse(out["ok"])
                self.assertNotIn("    at ", out["error"])
        self.assertIn("plan folder already exists", json.loads(again.stdout)["error"])

    def test_usage_errors_exit_2(self):
        self.assertEqual(self.cli("apply", self.dir).returncode, 2)
        self.assertEqual(self.cli("init").returncode, 2)


if __name__ == "__main__":
    unittest.main()
