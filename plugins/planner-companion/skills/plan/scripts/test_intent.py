"""Black-box tests for `init --intent` and `intent-check`."""
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from testsupport import CliTestCase


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class IntentInitTests(CliTestCase):
    def init(self, *extra):
        return self.cli("init", "demo", "--title", "T", "--date", "2026-11-27", "--project", self.tmp, *extra)

    def working(self, r):
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        return json.loads((Path(r.stdout.strip()) / "working.json").read_text())

    def test_init_records_relative_path_and_hash(self):
        f = self.tmp / ".claude" / "intents" / "x.md"
        f.parent.mkdir(parents=True)
        f.write_bytes(b"hello\n")
        working = self.working(self.init("--intent", f))
        self.assertEqual(working["intent"], {"path": ".claude/intents/x.md", "sha256": sha(b"hello\n")})

    def test_init_outside_project_stores_absolute_path(self):
        with tempfile.TemporaryDirectory(prefix="with space ") as other:
            f = Path(other) / "i.md"
            f.write_bytes(b"x")
            working = self.working(self.init("--intent", f))
            self.assertEqual(working["intent"]["path"], str(f.resolve()))

    def test_init_unreadable_intent_creates_no_folder(self):
        r = self.init("--intent", self.tmp / "nope.md")
        self.assertEqual(r.returncode, 1)
        lines = r.stdout.strip().splitlines()
        self.assertEqual(len(lines), 1)
        out = json.loads(lines[0])
        self.assertIs(out["ok"], False)
        self.assertIn("cannot read intent", out["error"])
        self.assertFalse((self.tmp / "docs" / "plans").exists())

    def test_init_without_intent_has_no_intent_field(self):
        self.assertNotIn("intent", self.working(self.init()))


if __name__ == "__main__":
    unittest.main()
