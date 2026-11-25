import json
import re
import subprocess
import unittest
from pathlib import Path

from testsupport import CliTestCase, fixture

SEQ = {"id": "flow", "type": "sequence", "title": "Flow", "rows": [["actor ui", "Page", "frontend"], ["actor api", "Server", "backend"], ["ui", "api", "ask"], ["api", "ui", "ok", "return"]]}
WF = {"id": "wf", "type": "workflow", "title": "WF", "rows": [["api", "Start", "backend"], ["db", "Store", "database"], ["api > db", "writes"]]}
ERD = {"id": "ent", "type": "erd", "title": "E", "rows": [["entity plan", "Plan"], ["entity task", "Task"], ["plan.id", "text", "pk"], ["task.id", "text", "pk"], ["task.plan_id", "text", "fk", "plan.id"], ["task > plan", "many:one", "belongs to"]]}
SKILL_DIR = Path(__file__).resolve().parent.parent
PLUGIN_DIR = SKILL_DIR.parent.parent
NEW_KINDS = {
    "state": [["initial s"], ["final e"], ["a", "A"], ["b", "B"], ["s > a"], ["a > b", "go"], ["b > e"]],
    "tree": [["root", "Root"], ["kid", "Kid"], ["root > kid"]],
    "timeline": [["track t", "Track"], ["2025-01", "Start", "t"], ["2025-02-01", "Next", "t"]],
    "architecture": [["group g", "Cloud"], ["web", "Web", "frontend"], ["api", "API", "backend", "g"], ["web > api", "HTTPS"]],
}


def renderer_types():
    """The kinds the bundled renderer supports, read from its TYPES export."""
    index = SKILL_DIR / "scripts" / "lib" / "diagram" / "index.mjs"
    out = subprocess.run(["node", "-e", f"import({json.dumps(index.as_uri())}).then(m => console.log(JSON.stringify(m.TYPES)))"],
                         capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


class DiagramTests(CliTestCase):
    def test_each_type_renders_with_node_ids(self):
        for spec, node in ((SEQ, "ui"), (WF, "api"), (ERD, "plan")):
            out = self.cli_json("diagram", self.write(spec))
            self.assertTrue(out["ok"])
            self.assertIn(f'data-node-id="{node}"', out["svg"])
            self.assertTrue(out["css"])
            self.assertIn(node, out["nodes"])

    def test_css_is_scoped_under_pl_diagram(self):
        out = self.cli_json("diagram", self.write(WF))
        self.assertIn(".pl-diagram", out["css"])
        self.assertNotRegex(out["css"], r"<style")

    def test_ids_are_prefixed_per_diagram_and_resolve_locally(self):
        a = self.cli_json("diagram", self.write({**WF, "id": "one"}))
        b = self.cli_json("diagram", self.write({**WF, "id": "two"}))
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

    def test_diagram_renders_a_bare_spec(self):
        out = self.cli_json("diagram", self.write(WF))
        self.assertTrue(out["ok"])
        self.assertIn("<svg", out["svg"])

    def test_bad_rows_fail_with_a_message(self):
        r = self.cli("diagram", self.write({**WF, "rows": [["api > missing", ""]]}))
        self.assertEqual(r.returncode, 1)
        self.assertTrue(json.loads(r.stdout)["error"])

    def test_other_types_are_rejected(self):
        r = self.cli("diagram", self.write({**WF, "type": "gantt"}))
        self.assertEqual(r.returncode, 1)
        self.assertFalse(json.loads(r.stdout)["ok"])

    def test_help_lists_diagram_first_on_its_line(self):
        r = self.cli("--help")
        self.assertEqual(r.returncode, 0)
        self.assertTrue(any(l.split()[:1] == ["diagram"] for l in r.stdout.splitlines()))

    def test_renderer_is_a_generated_copy_not_a_link(self):
        lib = SKILL_DIR / "scripts" / "lib" / "diagram"
        self.assertTrue(lib.is_dir())
        self.assertFalse(lib.is_symlink())
        self.assertTrue((lib / "GENERATED.json").is_file())
        for f in (PLUGIN_DIR.parent / "diagrams" / "lib").glob("*.mjs"):
            self.assertEqual((lib / f.name).read_bytes(), f.read_bytes(), f.name)

    def test_no_symlink_in_the_plugin(self):
        links = [str(p) for p in PLUGIN_DIR.rglob("*") if p.is_symlink()]
        self.assertEqual(links, [])

    def test_new_kinds_validate_and_render(self):
        for kind, rows in NEW_KINDS.items():
            spec = {"id": "d-" + kind, "type": kind, "title": kind, "rows": rows}
            s = fixture()
            s["domains"][0]["diagram"] = {k: spec[k] for k in ("type", "title", "rows")}
            r = self.cli("validate", self.write(s))
            self.assertEqual(r.returncode, 0, f"{kind}: {r.stdout}")
            self.assertEqual(json.loads(r.stdout)["diagnostics"], [], kind)
            out = self.cli_json("diagram", self.write(spec))
            self.assertTrue(out["ok"], kind)
            self.assertIn("<svg", out["svg"], kind)
            self.assertTrue(out["nodes"], kind)

    def test_new_kinds_cover_every_renderer_kind(self):
        self.assertEqual(set(renderer_types()) - set(NEW_KINDS) - {"sequence", "workflow", "erd"}, set())

    def test_diagram_type_message_lists_every_kind(self):
        s = fixture()
        s["domains"][0]["diagram"]["type"] = "gantt"
        r = self.cli("validate", self.write(s))
        self.assertEqual(r.returncode, 1)
        diag = [d for d in json.loads(r.stdout)["diagnostics"] if d["code"] == "diagram-type"]
        self.assertEqual(len(diag), 1)
        self.assertIn(", ".join(renderer_types()), diag[0]["message"])

    def test_no_vendored_renderer_is_left(self):
        self.assertFalse((SKILL_DIR / "vendor").exists())
        for p in PLUGIN_DIR.rglob("*"):
            if p.is_file() and "__pycache__" not in p.parts and p != Path(__file__).resolve():
                self.assertNotIn("archify", p.read_text(errors="ignore").lower(), str(p))

if __name__ == "__main__":
    unittest.main()
