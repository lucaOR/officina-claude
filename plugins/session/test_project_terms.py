#!/usr/bin/env python3
"""No file of the public session plugin may name a private project. Plain stdlib unittest:
    cd plugins/session && python3 -m unittest test_project_terms

The names come from the gitignored list the other plugins' tests read: $PROJECT_TERMS_FILE, or
else `.project-terms` at the repo root, one term per line, `#` starting a comment. Each term
matches case-insensitively as a whole word. Without that file the check is skipped. A failure
names the file and the line only, never the term, because test output can reach a public log.
Test files and fixtures are checked too, because they ship with the plugin.
"""
import os
import re
import unittest
from pathlib import Path

PLUGIN = Path(__file__).resolve().parent
TERMS_FILE = Path(os.environ.get("PROJECT_TERMS_FILE") or PLUGIN.parents[1] / ".project-terms")


def plugin_files():
    for path in sorted(PLUGIN.rglob("*")):
        if path.is_file() and "__pycache__" not in path.parts and path.name != Path(__file__).name:
            yield path


class ProjectTermsTest(unittest.TestCase):
    def test_no_file_names_a_private_project(self):
        if not TERMS_FILE.is_file():
            self.skipTest("no .project-terms file")
        terms = [t for t in (line.split("#", 1)[0].strip()
                             for line in TERMS_FILE.read_text(encoding="utf-8").splitlines()) if t]
        if not terms:
            self.skipTest("empty .project-terms file")
        pattern = re.compile(r"(?i)\b(?:" + "|".join(map(re.escape, terms)) + r")\b")
        hits = []
        for path in plugin_files():
            for n, line in enumerate(path.read_text(errors="replace").splitlines(), 1):
                if pattern.search(line):
                    hits.append(f"{path.relative_to(PLUGIN)}:{n}")
        self.assertEqual(hits, [], "private project names at these lines")


if __name__ == "__main__":
    unittest.main()
