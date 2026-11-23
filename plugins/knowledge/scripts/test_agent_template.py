import os
import unittest
from pathlib import Path

import lib

K = Path(__file__).resolve().parents[1]


class AgentTemplateTest(unittest.TestCase):
    def test_scribe_frontmatter(self):
        text = (K / "agents" / "scribe.md").read_text(encoding="utf-8")
        self.assertTrue(text.startswith("---\n"))
        meta = lib.yaml.safe_load(text.split("---\n")[1])
        self.assertEqual(meta["name"], "scribe")
        self.assertEqual(meta["autoCompactWindow"], 200000)
        self.assertTrue(str(meta["description"]).strip())

    def test_scribe_says_it_is_a_session_agent(self):
        # A plugin agent is also offered as a subagent type, and the scribe gate refuses a
        # drain from a subagent, so the description must steer callers to a whole session.
        text = (K / "agents" / "scribe.md").read_text(encoding="utf-8")
        description = str(lib.yaml.safe_load(text.split("---\n")[1])["description"])
        for phrase in ("session agent", "not a subagent", "ccscribe", "--agent knowledge:scribe"):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, description)

    def test_ccscribe_template(self):
        path = K / "templates" / "ccscribe"
        self.assertTrue(os.access(path, os.X_OK))
        lines = path.read_text(encoding="utf-8").splitlines()
        self.assertEqual(lines[0], "#!/bin/sh")
        self.assertEqual(lines[-1], 'exec claude --agent knowledge:scribe -n kb-scribe "$@"')


if __name__ == "__main__":
    unittest.main()
