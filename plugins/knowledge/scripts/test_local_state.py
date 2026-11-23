import importlib.util
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import adjudications
import ledger
import paths
import report
import skill_misses
import testkit
import usage

_spec = importlib.util.spec_from_file_location(
    "kb_queue", Path(__file__).resolve().parent / "kb" / "kb_queue.py")
kq = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(kq)


class LocalStateBase(unittest.TestCase):
    def setUp(self):
        self._saved = os.environ.pop("KNOWLEDGE_LOCAL_DIR", None)
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name).resolve()

    def tearDown(self):
        os.environ.pop("KNOWLEDGE_LOCAL_DIR", None)
        if self._saved is not None:
            os.environ["KNOWLEDGE_LOCAL_DIR"] = self._saved
        self.tmp.cleanup()


class TestLocalDir(LocalStateBase):
    def test_local_dir_self_ignoring(self):
        root = testkit.make_project(self.base)
        local = paths.local_dir(root)
        self.assertEqual((local / ".gitignore").read_text(), "*\n")
        kq.push("x", root=root)
        self.assertTrue((local / "queue.md").exists())
        self.assertEqual(testkit.git(root, "status", "--porcelain"), "")

    def test_worktree_uses_main_local_dir(self):
        root = testkit.make_project(self.base)
        wt = testkit.make_worktree(root, self.base / "wt")
        self.assertEqual(paths.local_dir(wt), paths.local_dir(root))

    def test_non_git_local_dir_under_root(self):
        root = testkit.make_project(self.base, git=False)
        self.assertEqual(paths.local_dir(root), root / ".claude/knowledge/.local")

    def test_unreachable_common_dir_falls_back(self):
        root = self.base / "orphan"
        root.mkdir()
        (root / ".git").write_text("gitdir: /nonexistent/x/.git/worktrees/orphan\n")
        self.assertEqual(paths.local_dir(root), root / ".claude/knowledge/.local")

    def test_env_override(self):
        root = testkit.make_project(self.base)
        target = self.base / "elsewhere"
        os.environ["KNOWLEDGE_LOCAL_DIR"] = str(target)
        self.assertEqual(paths.local_dir(root), target)
        self.assertTrue(target.is_dir())

    def test_create_false_makes_nothing(self):
        root = testkit.make_project(self.base, git=False)
        paths.local_dir(root, create=False)
        self.assertFalse((root / ".claude").exists())


class TestWritersUseLocalDir(LocalStateBase):
    def test_all_metrics_writers_use_local_dir(self):
        root = testkit.make_project(self.base)
        expected = paths.local_dir(root) / "metrics"
        for fn, name in [(ledger.default_path, "kb-ledger.jsonl"),
                         (usage.default_path, "kb-usage.jsonl"),
                         (adjudications.default_path, "kb-adjudications.jsonl"),
                         (skill_misses.default_path, "skill-misses.jsonl"),
                         (report.digest_rent_path, "kb-digest-rent.jsonl")]:
            self.assertEqual(fn(root), expected / name)
        self.assertFalse((root / ".claude" / "metrics").exists())


class TestQueue(LocalStateBase):
    def test_queue_push_lands_in_local(self):
        root = testkit.make_project(self.base)
        kq.push("hello", root=root)
        self.assertIn("hello", (paths.local_dir(root) / "queue.md").read_text())
        self.assertTrue((paths.local_dir(root) / "queue.lock").exists())
        self.assertFalse((root / "docs").exists())


if __name__ == "__main__":
    unittest.main()
