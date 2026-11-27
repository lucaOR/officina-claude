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


class IntentCheckTests(CliTestCase):
    def setUp(self):
        super().setUp()
        self.file = self.tmp / ".claude" / "intents" / "x.md"
        self.file.parent.mkdir(parents=True)
        self.file.write_bytes(b"hello\n")

    def init(self, intent=None, project=None):
        extra = ["--intent", intent] if intent else []
        r = self.cli("init", "demo", "--title", "T", "--date", "2026-11-27", "--project", project or self.tmp, *extra)
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        return r.stdout.strip()

    def check(self, plan, project=None):
        r = self.cli("intent-check", plan, "--project", project or self.tmp)
        return r.returncode, json.loads(r.stdout)

    def test_unchanged(self):
        code, out = self.check(self.init(self.file))
        self.assertEqual(code, 0)
        self.assertIs(out["ok"], True)
        self.assertIs(out["intent"]["changed"], False)
        self.assertIs(out["intent"]["missing"], False)

    def test_changed_after_edit(self):
        plan = self.init(self.file)
        self.file.write_bytes(b"edited\n")
        code, out = self.check(plan)
        self.assertEqual(code, 1)
        self.assertIs(out["ok"], True)
        self.assertIs(out["intent"]["changed"], True)
        self.assertIs(out["intent"]["missing"], False)
        self.assertEqual(out["intent"]["current"], sha(b"edited\n"))

    def test_missing_file(self):
        plan = self.init(self.file)
        self.file.unlink()
        code, out = self.check(plan)
        self.assertEqual(code, 1)
        self.assertIs(out["intent"]["missing"], True)
        self.assertIs(out["intent"]["changed"], True)
        self.assertIsNone(out["intent"]["current"])

    def test_plan_without_intent(self):
        r = self.cli("intent-check", self.init(), "--project", self.tmp)
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout.strip(), '{"ok":true,"intent":null}')

    def test_absolute_path_outside_project_resolves(self):
        with tempfile.TemporaryDirectory(prefix="with space ") as other:
            f = Path(other) / "i.md"
            f.write_bytes(b"x")
            plan = self.init(f)
            code, out = self.check(plan, project=other)
            self.assertEqual(code, 0)
            self.assertIs(out["intent"]["changed"], False)


class IntentPatchTests(CliTestCase):
    def test_patch_cannot_set_intent(self):
        f = self.tmp / "i.md"
        f.write_bytes(b"hello\n")
        r = self.cli("init", "demo", "--title", "T", "--date", "2026-11-27", "--project", self.tmp, "--intent", f)
        plan = Path(r.stdout.strip())
        before = (plan / "working.json").read_bytes()
        for kind in ("author", "change"):
            with self.subTest(kind=kind):
                r = self.cli("apply", plan, self.write({"set": {"intent": None}}), "--kind", kind, "--summary", "x")
                self.assertEqual(r.returncode, 1, r.stderr + r.stdout)
                codes = [d["code"] for d in json.loads(r.stdout)["diagnostics"]]
                self.assertEqual(codes, ["intent-by-patch"])
                self.assertEqual((plan / "working.json").read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
