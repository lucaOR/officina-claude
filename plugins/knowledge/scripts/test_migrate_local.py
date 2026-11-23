import contextlib
import io
import os
import tempfile
import unittest
from pathlib import Path

import migrate_local
import testkit

NAMES = ["kb-ledger.jsonl", "kb-usage.jsonl", "skill-misses.jsonl", "kb-digest-rent.jsonl"]


class TestMigrateLocal(unittest.TestCase):
    def setUp(self):
        self._saved = os.environ.pop("KNOWLEDGE_LOCAL_DIR", None)
        self.tmp = tempfile.TemporaryDirectory()
        self.root = testkit.make_project(Path(self.tmp.name))
        (self.root / "docs").mkdir()
        (self.root / "docs/kb-queue.md").write_text("q\n")
        (self.root / ".claude/metrics").mkdir(parents=True)
        for n in NAMES:
            (self.root / ".claude/metrics" / n).write_text(n)
        self.local = self.root / ".claude/knowledge/.local"

    def tearDown(self):
        if self._saved is not None:
            os.environ["KNOWLEDGE_LOCAL_DIR"] = self._saved
        self.tmp.cleanup()

    def run_main(self, *extra):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = migrate_local.main(["--root", str(self.root), "--queue", "docs/kb-queue.md",
                                     "--metrics-dir", ".claude/metrics", *extra])
        return rc, out.getvalue()

    def test_dry_run_moves_nothing(self):
        rc, out = self.run_main()
        self.assertEqual(rc, 0)
        self.assertEqual(len(out.splitlines()), 5)
        self.assertTrue((self.root / "docs/kb-queue.md").exists())
        self.assertFalse((self.local / "queue.md").exists())

    def test_dry_run_creates_no_local_dir(self):
        self.run_main()
        self.assertFalse((self.root / ".claude/knowledge").exists())

    def test_apply_creates_the_self_ignoring_local_dir(self):
        self.run_main("--apply")
        self.assertEqual((self.local / ".gitignore").read_text(), "*\n")

    def test_missing_source_skipped(self):
        rc, out = self.run_main()
        self.assertEqual(rc, 0)
        self.assertNotIn("kb-adjudications", out)

    def test_apply_moves_queue_and_metrics(self):
        rc, _ = self.run_main("--apply")
        self.assertEqual(rc, 0)
        self.assertEqual((self.local / "queue.md").read_text(), "q\n")
        for n in NAMES:
            self.assertEqual((self.local / "metrics" / n).read_text(), n)
            self.assertFalse((self.root / ".claude/metrics" / n).exists())
        self.assertFalse((self.root / "docs/kb-queue.md").exists())

    def test_existing_target_not_overwritten(self):
        (self.local / "metrics").mkdir(parents=True)
        (self.local / "metrics/kb-usage.jsonl").write_text("keep")
        rc, _ = self.run_main("--apply")
        self.assertEqual(rc, 1)
        self.assertEqual((self.local / "metrics/kb-usage.jsonl").read_text(), "keep")
        self.assertEqual((self.root / ".claude/metrics/kb-usage.jsonl").read_text(), "kb-usage.jsonl")
        self.assertTrue((self.root / "docs/kb-queue.md").exists())
        self.assertFalse((self.local / "queue.md").exists())


if __name__ == "__main__":
    unittest.main()
