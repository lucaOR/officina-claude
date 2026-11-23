import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
K = HERE.parent
sys.path.insert(0, str(K / "scripts"))

import testkit  # noqa: E402

INSTALL = HERE / "install-git-hooks.sh"
MARKER = "knowledge pre-commit gate"
RULES = """scope: project
topic: gate
rules:
  - id: no-forbidden
    title: FORBIDDEN token is banned
    severity: blocking
    applies_to:
      globs: ['**/*.py']
    check:
      scope: file
      shell: grep -c FORBIDDEN {file} || true
      flag_when: "> 0"
"""


def run(cmd, cwd, env=None, **kw):
    return subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True, env=env, **kw)


class GateCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name).resolve()
        self.cfg = self.base / "claude-config"
        self.cfg.mkdir()
        self.env = dict(os.environ, CLAUDE_CONFIG_DIR=str(self.cfg))
        self.env.pop("KNOWLEDGE_PLUGIN_DIR", None)
        self.env.pop("KNOWLEDGE_LOCAL_DIR", None)
        self.sup = testkit.make_superproject(
            self.base / "w", ["svc"], {".claude/knowledge/gate.yaml": RULES})
        self.svc = self.sup / "svc"
        testkit.git(self.svc, "config", "user.name", "kb-test")
        testkit.git(self.svc, "config", "user.email", "kb@example.invalid")
        testkit.git(self.svc, "config", "commit.gpgsign", "false")

    def tearDown(self):
        self.tmp.cleanup()

    def install(self, repo=None):
        return run(["sh", str(INSTALL), str(repo or self.svc)], self.base, self.env)

    def stage(self, text, name="a.py"):
        (self.svc / name).write_text(text, encoding="utf-8")
        testkit.git(self.svc, "add", name)

    def commit(self):
        return run(["git", "commit", "-q", "-m", "change"], self.svc, self.env)

    def hooks_dir(self, repo=None):
        out = testkit.git(repo or self.svc, "rev-parse", "--path-format=absolute", "--git-path", "hooks")
        return Path(out.strip())

    def register(self, install_path, scope="user", project=None):
        entry = {"scope": scope, "installPath": str(install_path)}
        if project is not None:
            entry["projectPath"] = str(project)
        (self.cfg / "plugins").mkdir(exist_ok=True)
        (self.cfg / "plugins" / "installed_plugins.json").write_text(json.dumps(
            {"version": 2, "plugins": {"knowledge@officina-claude": [entry]}}))

    def moved_plugin(self, repo):
        """Install the gate from a plugin copy, delete that copy, return a second copy."""
        first, second = self.base / "k1", self.base / "k2"
        for dest in (first, second):
            shutil.copytree(K, dest, ignore=shutil.ignore_patterns("__pycache__"))
        proc = run(["sh", str(first / "githooks" / "install-git-hooks.sh"), str(repo)],
                   self.base, self.env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        shutil.rmtree(first)
        return second


class TestGate(GateCase):
    def test_gate_blocks_staged_violation(self):
        self.assertEqual(self.install().returncode, 0)
        self.stage("x = 'FORBIDDEN'\n")
        proc = self.commit()
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("no-forbidden", proc.stdout + proc.stderr)

    def test_gate_passes_clean_commit(self):
        self.install()
        self.stage("x = 1\n")
        proc = self.commit()
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_gate_works_with_space_in_path(self):
        spaced = self.base / "with space"
        spaced.mkdir()
        sup = testkit.make_superproject(spaced, ["svc"], {".claude/knowledge/gate.yaml": RULES})
        svc = sup / "svc"
        self.assertEqual(self.install(svc).returncode, 0)
        (svc / "a.py").write_text("x = 'FORBIDDEN'\n")
        testkit.git(svc, "add", "a.py")
        proc = run(["git", "-c", "user.name=t", "-c", "user.email=t@e.invalid",
                    "commit", "-q", "-m", "m"], svc, self.env)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("no-forbidden", proc.stdout + proc.stderr)

    def test_install_writes_marked_shims(self):
        self.assertEqual(self.install().returncode, 0)
        hooks = self.hooks_dir()
        for name in ("pre-commit", "post-commit"):
            text = (hooks / name).read_text()
            self.assertIn(MARKER, text)
            self.assertIn(str(K), text)
            self.assertTrue(os.access(hooks / name, os.X_OK))
        self.assertTrue((hooks / "knowledge-locate.py").is_file())

    def test_install_refuses_foreign_hook(self):
        hooks = self.hooks_dir()
        hooks.mkdir(parents=True, exist_ok=True)
        foreign = hooks / "pre-commit"
        foreign.write_text("#!/bin/sh\necho mine\n")
        proc = self.install()
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(foreign.read_text(), "#!/bin/sh\necho mine\n")

    def test_install_refuses_a_hooks_dir_inside_the_work_tree(self):
        # core.hooksPath pointing at a tracked directory (husky): a shim there would commit
        # this machine's absolute plugin path into the repository.
        testkit.git(self.svc, "config", "core.hooksPath", ".husky")
        proc = self.install()
        self.assertEqual(proc.returncode, 1, proc.stdout)
        self.assertIn("inside the work tree", proc.stderr)
        self.assertFalse((self.svc / ".husky").exists())

    def test_install_accepts_a_hooks_dir_outside_the_work_tree(self):
        outside = self.base / "shared-hooks"
        testkit.git(self.svc, "config", "core.hooksPath", str(outside))
        proc = self.install()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn(MARKER, (outside / "pre-commit").read_text())

    def test_reinstall_is_idempotent(self):
        self.install()
        hooks = self.hooks_dir()
        before = {n: (hooks / n).read_text() for n in ("pre-commit", "post-commit")}
        self.assertEqual(self.install().returncode, 0)
        self.assertEqual(before, {n: (hooks / n).read_text() for n in before})

    def test_shim_falls_back_to_locate(self):
        # Install from a copy of the plugin, delete it, point the registry at another copy.
        first = self.base / "k1"
        second = self.base / "k2"
        shutil.copytree(K, first, ignore=shutil.ignore_patterns("__pycache__"))
        shutil.copytree(K, second, ignore=shutil.ignore_patterns("__pycache__"))
        self.assertEqual(run(["sh", str(first / "githooks" / "install-git-hooks.sh"),
                              str(self.svc)], self.base, self.env).returncode, 0)
        shutil.rmtree(first)
        self.register(second)
        self.stage("x = 'FORBIDDEN'\n")
        proc = self.commit()
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("no-forbidden", proc.stdout + proc.stderr)

    def test_shim_finds_project_scoped_install_from_submodule(self):
        # projectPath is the superproject, the hook runs in the service repo below it.
        self.register(self.moved_plugin(self.svc), "project", self.sup)
        self.stage("x = 'FORBIDDEN'\n")
        proc = self.commit()
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("no-forbidden", proc.stdout + proc.stderr)

    def test_shim_finds_project_scoped_install_from_nested_repo(self):
        parent = self.base / "nested"
        (parent / ".claude" / "knowledge").mkdir(parents=True)
        (parent / ".claude" / "knowledge" / "gate.yaml").write_text(RULES)
        repo = parent / "svc"
        repo.mkdir()
        testkit._init_repo(repo)
        for k, v in (("user.name", "t"), ("user.email", "t@e.invalid")):
            testkit.git(repo, "config", k, v)
        self.register(self.moved_plugin(repo), "local", parent)
        (repo / "a.py").write_text("x = 'FORBIDDEN'\n")
        testkit.git(repo, "add", "a.py")
        proc = run(["git", "commit", "-q", "-m", "m"], repo, self.env)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("no-forbidden", proc.stdout + proc.stderr)

    def test_shim_finds_project_scoped_install_from_linked_worktree(self):
        # projectPath is the main checkout; the commit runs in a linked worktree of it, which
        # shares the main checkout's hooks dir.
        wt = testkit.make_worktree(self.sup, self.base / "sup-wt")
        self.register(self.moved_plugin(self.sup), "project", self.sup)
        (wt / "a.py").write_text("x = 'FORBIDDEN'\n", encoding="utf-8")
        testkit.git(wt, "add", "a.py")
        proc = run(["git", "-c", "user.name=t", "-c", "user.email=t@e.invalid", "commit",
                    "-q", "-m", "m"], wt, self.env)
        self.assertNotEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("no-forbidden", proc.stdout + proc.stderr)

    def test_shim_fails_open_when_plugin_gone(self):
        first = self.base / "k1"
        shutil.copytree(K, first, ignore=shutil.ignore_patterns("__pycache__"))
        run(["sh", str(first / "githooks" / "install-git-hooks.sh"), str(self.svc)],
            self.base, self.env)
        shutil.rmtree(first)
        self.stage("x = 'FORBIDDEN'\n")
        proc = self.commit()
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("re-run /knowledge:setup", proc.stderr)

    def test_postcommit_appends_ledger_marker(self):
        self.install()
        self.stage("x = 1\n")
        proc = self.commit()
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        ledger = self.sup / ".claude" / "knowledge" / ".local" / "metrics" / "kb-ledger.jsonl"
        self.assertTrue(ledger.is_file())
        self.assertIn("a.py", ledger.read_text())


if __name__ == "__main__":
    unittest.main()
