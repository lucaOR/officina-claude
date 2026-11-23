"""Checks on the /planner-companion:plan skill text: frontmatter, the files it names, the CLI calls it makes."""
import re
import subprocess
import unittest

from testsupport import CLI, HERE

SKILL_DIR = HERE.parent
SKILL = SKILL_DIR / "SKILL.md"
INVOCATION = 'node "${CLAUDE_SKILL_DIR}/scripts/planning.mjs" '


def docs():
    """SKILL.md plus every reference doc a session may open from it."""
    return [SKILL, *sorted((SKILL_DIR / "reference").glob("*.md"))]


def frontmatter(text):
    m = re.match(r"---\n(.*?)\n---\n", text, re.S)
    if not m:
        return {}
    pairs = (re.match(r"([\w-]+):\s*(.*)", line) for line in m.group(1).splitlines())
    return {p.group(1): p.group(2).strip().strip('"') for p in pairs if p}


def help_commands():
    r = subprocess.run(["node", str(CLI), "--help"], capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    return {line.split()[0] for line in r.stdout.split("Commands:\n", 1)[1].splitlines() if line.strip()}


class SkillTests(unittest.TestCase):
    def skill_text(self):
        self.assertTrue(SKILL.is_file(), f"missing {SKILL}")
        return SKILL.read_text()

    def test_frontmatter(self):
        meta = frontmatter(self.skill_text())
        self.assertEqual(meta.get("name"), "plan")
        self.assertTrue(meta.get("description", "").startswith("Use when the user invokes /planner-companion:plan"),
                        meta.get("description"))

    def test_referenced_files_exist(self):
        self.assertIn("${CLAUDE_SKILL_DIR}/", self.skill_text())
        for doc in docs():
            for ref in re.findall(r"\$\{CLAUDE_SKILL_DIR\}/([^\s\"'`)]+)", doc.read_text()):
                ref = ref.rstrip(".,;:")
                with self.subTest(doc=doc.name, ref=ref):
                    self.assertTrue((SKILL_DIR / ref).exists(), f"{doc.name} names a missing file: {ref}")

    def test_subcommands_exist(self):
        known = help_commands()
        text = self.skill_text()
        calls = re.findall(re.escape(INVOCATION) + r"([a-z][\w-]*)", text)
        self.assertTrue(calls, "SKILL.md calls no planning.mjs subcommand")
        self.assertEqual(len(calls), text.count("planning.mjs"),
                         f"every planning.mjs mention in SKILL.md is a full call: {INVOCATION}<sub>")
        for doc in docs():
            for sub in re.findall(r'planning\.mjs"?\s+([a-z][\w-]*)', doc.read_text()):
                with self.subTest(doc=doc.name, sub=sub):
                    self.assertIn(sub, known)

    def test_every_ask_target_form_is_documented(self):
        """Each target the page can send (page.mjs askAttrs, client.js openPopover) is named in SKILL.md."""
        page = (HERE / "lib" / "page.mjs").read_text()
        client = (HERE / "page" / "client.js").read_text()
        forms = re.findall(r"askAttrs\(c,\s*([^,]+),", page) + re.findall(r"(?<!function )openPopover\([^,]+,\s*([^,]+),", client)
        self.assertGreaterEqual(len(forms), 8, forms)
        text = self.skill_text()
        prefixes = set()
        for form in forms:
            form = form.strip()
            prefix = re.match(r"`([a-z]+):\$\{", form)
            if prefix:
                prefixes.add(prefix.group(1))
            elif re.fullmatch(r"([dts])\.id", form):
                self.assertTrue(f"`{form[0].upper()}<n>`" in text, f"SKILL.md does not name `{form[0].upper()}<n>`")
            else:
                self.assertEqual(form, "host.dataset.askTarget", f"undocumented ask target form: {form}")
        self.assertEqual(prefixes, {"check", "summary", "focus", "rule", "node"})
        for prefix in sorted(prefixes):
            with self.subTest(prefix=prefix):
                self.assertTrue(f"`{prefix}:" in text, f"SKILL.md does not name the `{prefix}:` target")
        self.assertTrue("counts from 1" in text, "SKILL.md does not say that target numbers count from 1")

    def test_every_question_kind_is_handled(self):
        """Each question kind the queue or the server writes has its own bullet in the listening loop."""
        sources = (HERE / "lib" / "queue.mjs").read_text() + (HERE / "server.mjs").read_text()
        kinds = {"comment", "change", *re.findall(r"kind: '(\w+)'", sources)}
        self.assertEqual(kinds, {"comment", "change", "pick", "undo", "update"})
        text = self.skill_text()
        for kind in sorted(kinds):
            with self.subTest(kind=kind):
                self.assertTrue(re.search(rf"(?m)^- `{kind}`: ", text), f"SKILL.md has no `- `{kind}`:` bullet")

    def test_every_diagnostic_code_is_in_the_codes_table(self):
        emitted = set()
        for f in (HERE / "planning.mjs", *sorted((HERE / "lib").glob("*.mjs"))):
            emitted |= set(re.findall(r"code: '([a-z]+(?:-[a-z]+)+)'", f.read_text()))
        table = set(re.findall(r"(?m)^\| `([a-z-]+)` \|", (SKILL_DIR / "reference" / "source-format.md").read_text()))
        self.assertGreaterEqual(len(emitted), 20)
        self.assertEqual(emitted - table, set(), "diagnostic codes missing from reference/source-format.md")

    def test_diagram_call_takes_only_the_spec(self):
        self.assertFalse("--cache" in self.skill_text(), "SKILL.md's diagram call still passes --cache")
        r = subprocess.run(["node", str(CLI), "--help"], capture_output=True, text=True, timeout=60)
        self.assertIn("diagram <spec.json>", r.stdout)
        self.assertNotIn("--cache", r.stdout)

    def test_init_call_passes_the_project(self):
        call = re.search(re.escape(INVOCATION) + r"init [^`]*", self.skill_text()).group(0)
        self.assertIn('--project "<primary working directory>"', call)

    def test_no_runtime_reads_outside_the_plugin(self):
        self.skill_text()
        for doc in docs():
            text = doc.read_text()
            for path in ("~/.claude", "plugins/cache"):
                with self.subTest(doc=doc.name, path=path):
                    self.assertNotIn(path, text)


if __name__ == "__main__":
    unittest.main()
