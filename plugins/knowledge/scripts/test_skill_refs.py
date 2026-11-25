import os
import re
import unittest
from pathlib import Path

K = Path(__file__).resolve().parent.parent
SKILLS = K / "skills"

# Names of private projects are never allowed in any plugin file. They
# are not published: they come from a gitignored file, one term per line (`#` starts a comment),
# at $PROJECT_TERMS_FILE or else `.project-terms` at the repo root, and each term matches
# case-insensitively as a whole word. Without that file the check is skipped. A failure names
# the file and the line only, never the term, because the test output can reach a public log.
TERMS_FILE = Path(os.environ.get("PROJECT_TERMS_FILE") or K.parent.parent / ".project-terms")

# Paths and names of the in-project implementation the plugin replaced, and stack names the
# skills must not assume. Skill and reference text describes the plugin's own files; a
# project's specifics belong in its `.claude/knowledge/_index.md`, which the skills point at.
FORMER_IMPLEMENTATION = [
    r"kb-queue", r"\.claude/metrics", r"\.claude/rules", r"bin/install-git-hooks\.sh",
    r"(?<![\w/.-])githooks/pre-commit(?![\w-])", r"check\.py:\d", r"_registry_root",
    r"query\.py", r"CLAUDE_ROLE=scribe", r"(?i:memory routing)", r"pair ledger",
    r"(?i:sonar)", r"(?i:laravel)",
]


def project_terms():
    lines = TERMS_FILE.read_text(encoding="utf-8").splitlines()
    return [t for t in (line.split("#", 1)[0].strip() for line in lines) if t]


def plugin_files():
    return sorted(p for p in K.rglob("*") if p.is_file() and "__pycache__" not in p.parts)


def skill_files():
    return sorted(SKILLS.glob("*/SKILL.md"))


def plugin_text_files():
    return sorted([*SKILLS.glob("**/*.md"), *(K / "reference").glob("*.md"),
                   *(K / "agents").glob("*.md"), *(K / "templates").glob("*.md")])


class TestSkillRefs(unittest.TestCase):
    def test_skills_present(self):
        names = {p.parent.name for p in skill_files()}
        self.assertEqual(names, {"kb", "knowledge-capture", "knowledge-check", "knowledge-route", "setup"})

    def test_every_referenced_script_exists(self):
        found = 0
        for p in skill_files():
            for rel in re.findall(r"\$\{CLAUDE_SKILL_DIR\}/\.\./\.\./([\w./-]+\.\w+)", p.read_text()):
                found += 1
                with self.subTest(skill=p.parent.name, ref=rel):
                    self.assertTrue((p.parent / ".." / ".." / rel).resolve().is_file())
        self.assertGreater(found, 0)

    def test_no_project_script_paths(self):
        for p in skill_files():
            text = p.read_text()
            for bad in (".claude/scripts/", ".claude/hooks/"):
                with self.subTest(skill=p.parent.name, bad=bad):
                    self.assertNotIn(bad, text)

    def test_skill_names_namespaced(self):
        for p in skill_files():
            for n, line in enumerate(p.read_text().splitlines(), 1):
                with self.subTest(skill=p.parent.name, line=n):
                    self.assertIsNone(re.search(r"(?<![\w.:-])/kb\b(?![/_])", line), line)
                    if line.startswith("name:"):
                        continue
                    self.assertIsNone(
                        re.search(r"(?<![\w:/-])knowledge-(check|capture|route)\b", line), line)

    def test_no_knowledge_audit_skill(self):
        self.assertFalse((SKILLS / "knowledge-audit").exists())
        for p in skill_files():
            for n, line in enumerate(p.read_text().splitlines(), 1):
                if "knowledge-audit" in line:
                    with self.subTest(skill=p.parent.name, line=n):
                        self.assertRegex(line, r"\(formerly [^)]*knowledge-audit")

    def test_setup_default_sources_include_memory(self):
        # A run that takes the defaults seeds from instruction files and memory alike, and the
        # retire step then has copied memory files to move.
        text = (SKILLS / "setup" / "SKILL.md").read_text()
        call_a = text[text.index("**Call A, sources.**"):text.index("**Call B, settings.**")]
        for option in ("Instruction files (N)", "Memory files (N)"):
            with self.subTest(option=option):
                self.assertIn(f'"{option}" labelled "(Recommended)"', call_a)
        self.assertNotIn('"Other markdown" labelled', call_a)

    def test_no_former_implementation_names_in_plugin_text(self):
        files = plugin_text_files()
        self.assertIn(K / "reference" / "schema.md", files)
        for p in files:
            for n, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
                for name in FORMER_IMPLEMENTATION:
                    with self.subTest(file=str(p.relative_to(K)), name=name):
                        self.assertIsNone(re.search(name, line), f"line {n}: {line}")

    @unittest.skipUnless(TERMS_FILE.is_file(), f"no project terms file at {TERMS_FILE}")
    def test_no_project_names_in_plugin_files(self):
        res = [re.compile(r"\b" + re.escape(t) + r"\b", re.I | re.A) for t in project_terms()]
        hits = []
        for p in plugin_files():
            text = p.read_text(encoding="utf-8", errors="replace")
            for n, line in enumerate(text.splitlines(), 1):
                if any(r.search(line) for r in res):
                    hits.append(f"{p.relative_to(K).as_posix()}:{n}")
        self.assertEqual(hits, [], "project terms found; open these lines to see which")

    def test_skills_defer_project_specifics_to_the_index(self):
        for name in ("knowledge-check", "knowledge-capture", "knowledge-route", "kb"):
            with self.subTest(skill=name):
                self.assertIn(".claude/knowledge/_index.md",
                              (SKILLS / name / "SKILL.md").read_text(encoding="utf-8"))
        template = (K / "templates" / "_index.md").read_text(encoding="utf-8")
        for heading in ("## Scope heuristics", "## Project-specific checks"):
            with self.subTest(heading=heading):
                self.assertIn(heading, template)

    def test_scribe_role_is_knowledge_role(self):
        for name in ("knowledge-capture", "knowledge-route"):
            with self.subTest(skill=name):
                self.assertIn("KNOWLEDGE_ROLE=scribe",
                              (SKILLS / name / "SKILL.md").read_text(encoding="utf-8"))

    def test_kb_run_covers_no_git_and_stage_mode(self):
        text = (SKILLS / "kb" / "SKILL.md").read_text(encoding="utf-8")
        self.assertEqual(text.count("**Without git.**"), 1)
        self.assertIn("skips step 0 and step 8", text)
        self.assertIn("git half of the abort-time\nrollback", text)
        step10 = text[text.index("10. **"):text.index("## Health triage")]
        self.assertIn("in `stage` mode, after the staged-files check", step10)
        self.assertIn("the next run's step 0 refuses", step10)

    def test_staleness_pass_is_bounded(self):
        text = (SKILLS / "kb" / "SKILL.md").read_text(encoding="utf-8")
        para = text[text.index("**Staleness"):text.index("**Verify clean.**")]
        self.assertIn("full run only", para)
        self.assertIn("no longer exists", para)

    def test_digest_guard_step_starts_with_python3_and_is_conditional(self):
        text = (SKILLS / "knowledge-route" / "SKILL.md").read_text(encoding="utf-8")
        self.assertNotIn("KNOWLEDGE_REAL_PROJECT", text)
        self.assertIn('`python3 "${CLAUDE_SKILL_DIR}/../../scripts/test_build_digest.py" --root <repo-root>`',
                      text)
        self.assertIn("if `.claude/knowledge/config.yaml` sets `digest_guard`", text)

    def test_queue_path_is_local(self):
        text = (SKILLS / "kb" / "SKILL.md").read_text()
        self.assertNotIn("docs/kb-queue.md", text)
        self.assertIn(".claude/knowledge/.local/queue.md", text)

    def test_kb_learn_calls_run_capture(self):
        text = (SKILLS / "kb" / "SKILL.md").read_text()
        self.assertIn("/knowledge:kb learn", text)
        self.assertIn('python3 "${CLAUDE_SKILL_DIR}/../../scripts/capture/run_capture.py" '
                      '--root {root}', text)
        self.assertTrue((K / "scripts" / "capture" / "run_capture.py").is_file())
        self.assertIn("Auto-captured candidates", text)


if __name__ == "__main__":
    unittest.main()
