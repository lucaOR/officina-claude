import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import paths
import testkit

HERE = Path(__file__).resolve().parent


class _Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()

    def env(self, project_dir):
        env = {k: v for k, v in os.environ.items() if k != "CLAUDE_PROJECT_DIR"}
        if project_dir is not None:
            env["CLAUDE_PROJECT_DIR"] = str(project_dir)
        return mock.patch.dict(os.environ, env, clear=True)


class TestProjectRoot(_Base):
    def test_explicit_root_wins(self):
        repo = testkit.make_project(self.base)
        with self.env(self.base / "elsewhere"):
            self.assertEqual(paths.project_root(repo), repo.resolve())

    def test_plain_repo_needs_no_subprocess(self):
        repo = testkit.make_project(self.base)
        with self.env(repo), mock.patch.object(
                paths.subprocess, "run", side_effect=AssertionError("spawned")):
            self.assertEqual(paths.project_root(), repo.resolve())

    def test_submodule_climbs_to_superproject(self):
        sup = testkit.make_superproject(self.base, ["svc"])
        with self.env(sup / "svc"):
            self.assertEqual(paths.project_root(), sup.resolve())

    def test_worktree_is_its_own_root(self):
        repo = testkit.make_project(self.base)
        wt = testkit.make_worktree(repo, self.base / "wt")
        with self.env(wt):
            self.assertEqual(paths.project_root(), wt.resolve())

    def test_subdir_resolves_to_toplevel(self):
        repo = testkit.make_project(self.base)
        sub = repo / "a" / "b"
        sub.mkdir(parents=True)
        with self.env(sub):
            self.assertEqual(paths.project_root(), repo.resolve())

    def test_cwd_used_when_env_unset(self):
        repo = testkit.make_project(self.base)
        old = os.getcwd()
        self.addCleanup(os.chdir, old)
        os.chdir(repo)
        with self.env(None):
            self.assertEqual(paths.project_root(), repo.resolve())

    def test_non_git_returns_start(self):
        plain = self.base / "plain"
        plain.mkdir()
        with self.env(plain):
            self.assertEqual(paths.project_root(), plain.resolve())

    def test_has_knowledge(self):
        with_kb = testkit.make_project(self.base, {"r.yaml": "[]\n"}, git=False)
        self.assertTrue(paths.has_knowledge(with_kb))
        self.assertFalse(paths.has_knowledge(self.base))


class TestGitContext(_Base):
    def test_git_context_submodule(self):
        sup = testkit.make_superproject(self.base, ["svc"])
        self.assertEqual(paths.git_context(sup / "svc"), (sup.resolve(), "svc"))

    def test_git_context_parent_holds_knowledge(self):
        parent = testkit.make_project(self.base, {"r.yaml": "[]\n"}, git=False)
        sat = parent / "sat"
        sat.mkdir()
        testkit._init_repo(sat)
        self.assertEqual(paths.git_context(sat), (parent.resolve(), "sat"))

    def test_git_context_plain_repo(self):
        repo = testkit.make_project(self.base)
        self.assertEqual(paths.git_context(repo), (repo.resolve(), None))

    def test_cli_git_context_prints_tab_separated(self):
        sup = testkit.make_superproject(self.base, ["svc"])
        proc = subprocess.run(["python3", str(HERE / "paths.py"), "git-context"],
                              cwd=sup / "svc", capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout, f"{sup.resolve()}\tsvc\n")

    def test_cli_git_context_outside_git_is_silent_exit_1(self):
        proc = subprocess.run(["python3", str(HERE / "paths.py"), "git-context"],
                              cwd=self.base, capture_output=True, text=True)
        self.assertEqual((proc.returncode, proc.stdout), (1, ""))


if __name__ == "__main__":
    unittest.main()
