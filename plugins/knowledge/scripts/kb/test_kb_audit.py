import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(SCRIPTS))

import kb_audit  # noqa: E402
import lib  # noqa: E402
import testkit  # noqa: E402

NOW = datetime(2026, 11, 23, 10, 0, tzinfo=timezone.utc)
RULES = """scope: project
topic: t
rules:
  - id: a
    title: Rule A
    rule: first body
  - id: b
    title: Rule B
    rule: second body
"""
A, B = "project/t#a", "project/t#b"


class AuditTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.local = self.base / "local"
        self.root = testkit.make_project(self.base, {"r.yaml": RULES})
        self.env = dict(os.environ, KNOWLEDGE_LOCAL_DIR=str(self.local))
        os.environ["KNOWLEDGE_LOCAL_DIR"] = str(self.local)
        self.addCleanup(lambda: os.environ.pop("KNOWLEDGE_LOCAL_DIR", None))

    def tearDown(self):
        self.tmp.cleanup()

    def set_last_full(self, when):
        self.local.mkdir(parents=True, exist_ok=True)
        (self.local / "audit-state.json").write_text(
            json.dumps({"last_full": when.isoformat(), "kept": []}))

    def cli(self, script, *args):
        proc = subprocess.run([sys.executable, str(script), "--root", str(self.root), *args],
                              env=self.env, capture_output=True, text=True, timeout=120)
        return proc

    def plan(self, *args):
        proc = self.cli(HERE / "kb_audit.py", "plan", *args)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return json.loads(proc.stdout)

    def test_due_when_never_run(self):
        self.assertTrue(kb_audit.due(self.root, now=NOW))

    def test_not_due_within_window(self):
        self.set_last_full(NOW - timedelta(days=6))
        self.assertFalse(kb_audit.due(self.root, now=NOW))

    def test_due_after_window(self):
        self.set_last_full(NOW - timedelta(days=8))
        self.assertTrue(kb_audit.due(self.root, now=NOW))

    def test_every_days_zero_always_due(self):
        (self.root / ".claude/knowledge/config.yaml").write_text("scribe:\n  audit_every_days: 0\n")
        kb_audit.mark_full(self.root, now=NOW)
        self.assertTrue(kb_audit.due(self.root, now=NOW))

    def test_kept_finding_filtered_until_rule_changes(self):
        finding = {"category": "CANDIDATE", "fqids": [A, B], "text": "x"}
        self.assertEqual(kb_audit.filter_kept(self.root, [finding]), [finding])
        kb_audit.keep(self.root, "CANDIDATE", [B, A])
        self.assertEqual(kb_audit.filter_kept(self.root, [finding]), [])
        path = self.root / ".claude/knowledge/r.yaml"
        path.write_text(path.read_text().replace("second body", "second body, reworded"))
        self.assertEqual(kb_audit.filter_kept(self.root, [finding]), [finding])

    def test_error_never_filtered(self):
        finding = {"category": "ERROR", "fqids": [A], "text": "x"}
        kb_audit.keep(self.root, "ERROR", [A])
        self.assertEqual(kb_audit.filter_kept(self.root, [finding]), [finding])

    def test_finding_key(self):
        self.assertEqual(kb_audit.finding_key("CANDIDATE", [B, A]), f"CANDIDATE|{A},{B}")

    def test_plan_not_full_runs_only_validate(self):
        kb_audit.mark_full(self.root)
        plan = self.plan()
        self.assertFalse(plan["full"])
        cats = {f["category"] for f in plan["findings"]}
        self.assertTrue(cats <= {"ERROR", "CANDIDATE", "FAN-OUT", "WARN"}, cats)
        self.assertIn("CANDIDATE", cats)

    def test_plan_force_runs_full(self):
        kb_audit.mark_full(self.root)
        plan = self.plan("--force")
        self.assertTrue(plan["full"])
        self.assertIn("DEAD", {f["category"] for f in plan["findings"]})

    def test_plan_filters_kept(self):
        self.plan()
        kb_audit.keep(self.root, "CANDIDATE", [A, B])
        self.assertNotIn("CANDIDATE", {f["category"] for f in self.plan()["findings"]})

    def test_plan_accepts_lease(self):
        proc = self.cli(HERE / "kb_audit.py", "plan", "--lease", "nope")
        self.assertEqual(proc.returncode, 0)
        for sub in (["keep", "--category", "WARN", "--fqid", A], ["mark-full"]):
            self.assertEqual(self.cli(HERE / "kb_audit.py", sub[0], "--lease", "nope",
                                      *sub[1:]).returncode, 0)

    def test_state_lives_in_local(self):
        kb_audit.mark_full(self.root)
        kb_audit.keep(self.root, "WARN", [A])
        state = json.loads((self.local / "audit-state.json").read_text())
        self.assertEqual(set(state), {"last_full", "kept"})
        self.assertEqual(set(state["kept"][0]), {"key", "hash", "at"})
        self.assertFalse(list(self.root.rglob("audit-state.json")))

    def test_json_flag_leaves_text_output_unchanged(self):
        for script in ("validate.py", "report.py"):
            path = SCRIPTS / script
            before = self.cli(path)
            js = self.cli(path, "--json" if script == "validate.py" else "--findings")
            after = self.cli(path)
            self.assertEqual(before.stdout, after.stdout)
            self.assertEqual(before.returncode, after.returncode)
            self.assertEqual(js.returncode, before.returncode)
            findings = json.loads(js.stdout)
            self.assertIsInstance(findings, list)
            for f in findings:
                self.assertEqual(set(f), {"category", "fqids", "text"})
                if f["category"] != "CANDIDATE":     # text mode prints these only with --focus
                    for line in f["text"].split("\n"):
                        self.assertIn(line, before.stdout)
        report = json.loads(self.cli(SCRIPTS / "report.py", "--findings").stdout)
        self.assertEqual({(f["category"], tuple(f["fqids"])) for f in report},
                         {("DEAD", (A,)), ("DEAD", (B,))})

    def test_report_json_is_still_the_aggregate(self):
        agg = json.loads(self.cli(SCRIPTS / "report.py", "--json").stdout)
        self.assertIsInstance(agg, dict)
        self.assertIn("totals", agg)
        self.assertEqual(sorted(agg["dead"]), [A, B])


if __name__ == "__main__":
    unittest.main()
