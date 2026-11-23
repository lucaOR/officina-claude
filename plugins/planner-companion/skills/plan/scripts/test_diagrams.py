import json
import re
import unittest
from pathlib import Path

from testsupport import CliTestCase

SEQ = {"id": "flow", "type": "sequence", "title": "Flow", "rows": [["actor ui", "Page", "frontend"], ["actor api", "Server", "backend"], ["ui", "api", "ask"], ["api", "ui", "ok", "return"]]}
WF = {"id": "wf", "type": "workflow", "title": "WF", "rows": [["api", "Start", "backend"], ["db", "Store", "database"], ["api > db", "writes"]]}
ERD = {"id": "ent", "type": "erd", "title": "E", "rows": [["entity plan", "Plan"], ["entity task", "Task"], ["plan.id", "text", "pk"], ["task.id", "text", "pk"], ["task.plan_id", "text", "fk", "plan.id"], ["task > plan", "many:one", "belongs to"]]}
VENDOR = Path(__file__).resolve().parent.parent / "vendor" / "archify"


class DiagramTests(CliTestCase):
    def cache(self):
        return str(self.tmp / "c")

    def test_each_type_renders_with_node_ids(self):
        for spec, node in ((SEQ, "ui"), (WF, "api"), (ERD, "plan")):
            out = self.cli_json("diagram", self.write(spec), "--cache", self.cache())
            self.assertTrue(out["ok"])
            self.assertIn(f'data-node-id="{node}"', out["svg"])
            self.assertTrue(out["css"])
            self.assertIn(node, out["nodes"])

    def test_css_is_scoped_under_pl_diagram(self):
        out = self.cli_json("diagram", self.write(WF), "--cache", self.cache())
        self.assertIn(".pl-diagram", out["css"])
        self.assertNotRegex(out["css"], r"<style")

    def test_ids_are_prefixed_per_diagram_and_resolve_locally(self):
        a = self.cli_json("diagram", self.write({**WF, "id": "one"}), "--cache", self.cache())
        b = self.cli_json("diagram", self.write({**WF, "id": "two"}), "--cache", self.cache())
        self.assertNotEqual(a["svg"], b["svg"])
        ids = {}
        for name, out in (("a", a), ("b", b)):
            ids[name] = set(re.findall(r'\sid="([^"]*)"', out["svg"]))
            self.assertTrue(ids[name])
            refs = re.findall(r'url\(#([^)]+)\)', out["svg"]) + re.findall(r'href="#([^"]+)"', out["svg"]) \
                + [i for v in re.findall(r'aria-(?:labelledby|describedby)="([^"]*)"', out["svg"]) for i in v.split()]
            self.assertTrue(refs)
            for ref in refs:
                self.assertIn(ref, ids[name])
        self.assertFalse(ids["a"] & ids["b"])
        self.assertIn('data-node-id="api"', a["svg"])
        self.assertIn("api", a["nodes"])

    def test_diagram_without_cache_flag_renders(self):
        out = self.cli_json("diagram", self.write(WF))
        self.assertTrue(out["ok"])
        self.assertIn("<svg", out["svg"])

    def test_bad_rows_fail_with_a_message(self):
        r = self.cli("diagram", self.write({**WF, "rows": [["api > missing", ""]]}), "--cache", self.cache())
        self.assertEqual(r.returncode, 1)
        self.assertTrue(json.loads(r.stdout)["error"])

    def test_other_types_are_rejected(self):
        r = self.cli("diagram", self.write({**WF, "type": "tree"}), "--cache", self.cache())
        self.assertEqual(r.returncode, 1)
        self.assertFalse(json.loads(r.stdout)["ok"])

    def test_second_render_is_cached(self):
        spec = self.write(WF)
        first = self.cli_json("diagram", spec, "--cache", self.cache())
        second = self.cli_json("diagram", spec, "--cache", self.cache())
        self.assertFalse(first["cached"])
        self.assertTrue(second["cached"])
        self.assertEqual(first["svg"], second["svg"])

    def test_help_lists_diagram_first_on_its_line(self):
        r = self.cli("--help")
        self.assertEqual(r.returncode, 0)
        self.assertTrue(any(l.split()[:1] == ["diagram"] for l in r.stdout.splitlines()))

    def test_vendor_keeps_licences_and_no_home_paths(self):
        for name in ("LICENSE", "LICENSE-MIT", "NOTICE", "THIRD_PARTY_NOTICES.md", "VENDORED"):
            self.assertTrue((VENDOR / name).is_file(), name)
        for p in VENDOR.rglob("*"):
            if p.is_file():
                self.assertNotIn(".claude/skills/archify", p.read_text(errors="ignore"), str(p))


if __name__ == "__main__":
    unittest.main()
