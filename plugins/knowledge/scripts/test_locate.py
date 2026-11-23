import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import locate

ID = "knowledge@officina-claude"
GIT = ["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid",
       "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"]


def linked_worktree(base: Path, name: str = "main") -> tuple:
    """(main checkout, linked worktree) of a fresh one-commit repository under `base`."""
    main, wt = base / name, base / f"{name}-wt"
    main.mkdir()
    subprocess.run(GIT + ["-C", str(main), "init", "-q"], check=True)
    subprocess.run(GIT + ["-C", str(main), "commit", "-q", "--allow-empty", "-m", "init"],
                   check=True)
    subprocess.run(GIT + ["-C", str(main), "worktree", "add", "-q", "-b", f"{name}-wt", str(wt)],
                   check=True, capture_output=True)
    return main.resolve(), wt.resolve()


class TestLocate(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name).resolve()
        self.cfg = self.base / "config"
        self.cfg.mkdir()
        self.project = self.base / "proj"
        self.project.mkdir()
        env = {"CLAUDE_CONFIG_DIR": str(self.cfg)}
        patcher = mock.patch.dict(os.environ, env)
        patcher.start()
        self.addCleanup(patcher.stop)
        os.environ.pop("KNOWLEDGE_PLUGIN_DIR", None)

    def tearDown(self):
        self.tmp.cleanup()

    def _install(self, name):
        path = self.base / name
        path.mkdir()
        return path

    def _registry(self, entries):
        (self.cfg / "plugins").mkdir(exist_ok=True)
        (self.cfg / "plugins" / "installed_plugins.json").write_text(
            json.dumps({"version": 2, "plugins": {ID: entries}}), encoding="utf-8")

    def test_env_override_wins(self):
        target = self._install("override")
        self._registry([{"scope": "user", "installPath": str(self._install("reg"))}])
        with mock.patch.dict(os.environ, {"KNOWLEDGE_PLUGIN_DIR": str(target)}):
            self.assertEqual(locate.plugin_dir(self.project), target)

    def test_env_override_missing_dir_is_none(self):
        with mock.patch.dict(os.environ, {"KNOWLEDGE_PLUGIN_DIR": str(self.base / "nope")}):
            self.assertIsNone(locate.plugin_dir(self.project))

    def test_no_json_is_none(self):
        self.assertIsNone(locate.plugin_dir(self.project))

    def test_bad_json_is_none(self):
        (self.cfg / "plugins").mkdir()
        (self.cfg / "plugins" / "installed_plugins.json").write_text("{not json")
        self.assertIsNone(locate.plugin_dir(self.project))

    def test_project_entry_for_this_checkout_beats_user(self):
        user, proj = self._install("user"), self._install("proj-install")
        self._registry([
            {"scope": "user", "installPath": str(user)},
            {"scope": "project", "installPath": str(proj), "projectPath": str(self.project)},
        ])
        self.assertEqual(locate.plugin_dir(self.project), proj)

    def test_local_scope_counts_as_project(self):
        user, loc = self._install("user"), self._install("local-install")
        self._registry([
            {"scope": "user", "installPath": str(user)},
            {"scope": "local", "installPath": str(loc), "projectPath": str(self.project)},
        ])
        self.assertEqual(locate.plugin_dir(self.project), loc)

    def test_project_entry_for_other_checkout_ignored(self):
        user, other = self._install("user"), self._install("other-install")
        self._registry([
            {"scope": "project", "installPath": str(other),
             "projectPath": str(self.base / "elsewhere")},
            {"scope": "user", "installPath": str(user)},
        ])
        self.assertEqual(locate.plugin_dir(self.project), user)

    def test_stale_install_path_skipped(self):
        user = self._install("user")
        self._registry([
            {"scope": "project", "installPath": str(self.base / "gone"),
             "projectPath": str(self.project)},
            {"scope": "user", "installPath": str(user)},
        ])
        self.assertEqual(locate.plugin_dir(self.project), user)


class TestLinkedWorktree(unittest.TestCase):
    """A project-scope install is recorded under the projectPath of the checkout it was
    installed from, usually the main one. A linked worktree of that repository is the same
    project, so its entry must match there too."""

    setUp, tearDown = TestLocate.setUp, TestLocate.tearDown
    _install, _registry = TestLocate._install, TestLocate._registry

    def test_main_checkout_entry_matches_its_linked_worktree(self):
        main, wt = linked_worktree(self.base)
        user, proj = self._install("user"), self._install("proj-install")
        self._registry([
            {"scope": "user", "installPath": str(user)},
            {"scope": "project", "installPath": str(proj), "projectPath": str(main)},
        ])
        self.assertEqual(locate.plugin_dir(wt), proj)
        self.assertEqual(locate.plugin_dir(main), proj)

    def test_entry_for_the_worktree_itself_wins(self):
        main, wt = linked_worktree(self.base)
        for_main, for_wt = self._install("for-main"), self._install("for-wt")
        self._registry([
            {"scope": "project", "installPath": str(for_main), "projectPath": str(main)},
            {"scope": "local", "installPath": str(for_wt), "projectPath": str(wt)},
        ])
        self.assertEqual(locate.plugin_dir(wt), for_wt)

    def test_another_repository_s_main_checkout_does_not_match(self):
        _, wt = linked_worktree(self.base)
        other, _ = linked_worktree(self.base, "other")
        self._registry([{"scope": "project", "installPath": str(self._install("x")),
                         "projectPath": str(other)}])
        self.assertIsNone(locate.plugin_dir(wt))

    def test_without_git_the_lookup_is_unchanged(self):
        main, wt = linked_worktree(self.base)
        user, proj = self._install("user"), self._install("proj-install")
        self._registry([
            {"scope": "project", "installPath": str(proj), "projectPath": str(main)},
            {"scope": "user", "installPath": str(user)},
        ])
        with mock.patch.dict(os.environ, {"PATH": str(self.base / "no-bin")}):
            self.assertEqual(locate.plugin_dir(wt), user)


if __name__ == "__main__":
    unittest.main()
