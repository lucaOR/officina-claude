"""Wiring and portability tests for token-hygiene. Plain stdlib unittest.

hooks.json is the contract with Claude Code: a guard that is not registered on the event it
expects never runs, and a command that names a missing script errors on every tool call.
The portability check keeps the plugin free of the project it was extracted from.
"""
import json
import os
import re
import unittest
from pathlib import Path

PLUGIN = Path(__file__).resolve().parent.parent
REPO = PLUGIN.parent.parent

EXPECTED = {
    ("SessionStart", "startup|clear|compact", "cap-large-reads.py"),
    ("SessionStart", "startup|clear|compact", "skip-redundant-reads.py"),
    ("PreToolUse", "*", "context-watchdog.py"),
    ("PreToolUse", "Read", "skip-redundant-reads.py"),
    ("PreToolUse", "Read", "block-external-reads.py"),
    ("PreToolUse", "Read", "cap-large-reads.py"),
    ("PreToolUse", "Bash", "filter-verbose-output.py"),
    ("PreToolUse", "Bash", "block-external-reads.py"),
    ("PreToolUse", "Agent", "guard-opus-agents.py"),
    ("PostToolUse", "Read", "skip-redundant-reads.py"),
    ("Stop", "", "context-watchdog.py"),
    ("SessionEnd", "", "record-session-metrics.js"),
}

# The project the hooks came from had its own skills, agents and knowledge base. None of them
# ship with this plugin, so no file may send the model looking for them.
FOREIGN = [
    r"\.claude/hooks/", r"\.claude/knowledge", r"monorepo/", r"cavecrew", r"CLAUDE_PAIR",
    r"docs/pair-", r"(?<![:\w])/handoff\b",
]

# Names of private projects, from the gitignored list the other plugins' tests read. A failure
# names the file and the line only, never the term, because test output can reach a public log.
TERMS_FILE = Path(os.environ.get("PROJECT_TERMS_FILE") or REPO / ".project-terms")


def registrations():
    hooks = json.loads((PLUGIN / "hooks" / "hooks.json").read_text())["hooks"]
    for event, groups in hooks.items():
        for group in groups:
            for hook in group["hooks"]:
                script = re.search(r"/hooks/([\w.-]+)", hook["command"]).group(1)
                yield event, group.get("matcher", ""), script, hook["command"]


def plugin_files():
    for path in sorted(PLUGIN.rglob("*")):
        if path.is_file() and "__pycache__" not in path.parts and not path.name.startswith("test_"):
            yield path


class WiringTest(unittest.TestCase):
    def test_every_hook_is_registered_on_its_event(self):
        self.assertEqual({(e, m, s) for e, m, s, _ in registrations()}, EXPECTED)

    def test_every_command_names_a_script_that_exists(self):
        for _, _, script, command in registrations():
            self.assertIn("${CLAUDE_PLUGIN_ROOT}/hooks/" + script, command)
            self.assertTrue((PLUGIN / "hooks" / script).is_file(), script)


class PortabilityTest(unittest.TestCase):
    def test_no_file_points_at_the_project_it_came_from(self):
        hits = []
        for path in plugin_files():
            for n, line in enumerate(path.read_text(errors="replace").splitlines(), 1):
                if any(re.search(p, line) for p in FOREIGN):
                    hits.append("{0}:{1}".format(path.relative_to(PLUGIN), n))
        self.assertEqual(hits, [])

    def test_no_file_names_a_private_project(self):
        if not TERMS_FILE.is_file():
            self.skipTest("no .project-terms file")
        terms = [t.strip() for t in TERMS_FILE.read_text().splitlines()
                 if t.strip() and not t.lstrip().startswith("#")]
        pattern = re.compile(r"(?i)\b(?:" + "|".join(map(re.escape, terms)) + r")\b")
        hits = []
        for path in plugin_files():
            for n, line in enumerate(path.read_text(errors="replace").splitlines(), 1):
                if pattern.search(line):
                    hits.append("{0}:{1}".format(path.relative_to(PLUGIN), n))
        self.assertEqual(hits, [], "private project names at these lines")


if __name__ == "__main__":
    unittest.main()
