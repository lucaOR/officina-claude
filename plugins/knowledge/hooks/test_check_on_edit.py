import contextlib
import importlib.util
import io
import json
import subprocess
import os
import sys
import tempfile
import unittest
from pathlib import Path

_HOOK = Path(__file__).resolve().parent / "check-on-edit.py"
_spec = importlib.util.spec_from_file_location("check_on_edit", _HOOK)
coe = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(coe)


def _init_repo(root):
    """Real `git init` fixture repo — _gate_installed shells out to `git rev-parse`,
    which needs a real repo to answer; a hand-made `.git/` directory would make it
    silently return False for a reason unrelated to what a test is checking."""
    root.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-q", str(root)], check=True)


def _install_gate(root):
    """Write a pre-commit hook carrying the default gate marker, so _gate_installed
    finds it via the real git dir."""
    git_dir = Path(subprocess.run(
        ["git", "-C", str(root), "rev-parse", "--absolute-git-dir"],
        capture_output=True, text=True, check=True).stdout.strip())
    hooks = git_dir / "hooks"
    hooks.mkdir(parents=True, exist_ok=True)
    (hooks / "pre-commit").write_text(
        "#!/bin/sh\n# knowledge pre-commit gate — installed by the knowledge plugin.\n")


class TestResolve(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.uc = Path(self.tmp.name)
        _init_repo(self.uc)                              # the project itself is a git repo
        _init_repo(self.uc / "svc")                       # gated service repo
        _install_gate(self.uc / "svc")
        (self.uc / "svc" / "app").mkdir()
        (self.uc / ".claude" / "scripts").mkdir(parents=True)
        (self.uc / ".claude" / "knowledge").mkdir(parents=True)
        _init_repo(self.uc / "other")                       # nested repo, gate NOT installed
        (self.uc / "other" / "app").mkdir()
        (self.uc / "svc" / "nested").mkdir()   # nested repo two levels deep
        _init_repo(self.uc / "svc" / "nested")  # own .git, no gate installed
        (self.uc / "svc" / "nested" / "src").mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def test_service_file(self):
        self.assertEqual(coe.resolve(str(self.uc / "svc" / "app" / "Foo.php"), self.uc),
                         ("svc", "app/Foo.php"))

    def test_cross_service_file(self):
        self.assertEqual(coe.resolve(str(self.uc / ".claude" / "scripts" / "x.py"), self.uc),
                         (None, ".claude/scripts/x.py"))

    def test_outside_tree_is_none(self):
        self.assertIsNone(coe.resolve("/etc/passwd", self.uc))

    def test_uncheckable_extension_is_none(self):
        self.assertIsNone(coe.resolve(str(self.uc / "svc" / "app" / "README.md"), self.uc))

    def test_nested_repo_without_gate_is_unkeyed(self):
        # A nested git repo whose KB gate was never installed. Nothing
        # could have caught this at commit time, so it must resolve the same way as
        # a root-repo file — unkeyed, not a spurious "other" service.
        self.assertEqual(coe.resolve(str(self.uc / "other" / "app" / "Foo.php"), self.uc),
                         (None, "other/app/Foo.php"))

    def test_nested_repo_two_levels_deep_without_gate_is_unkeyed(self):
        # A repo nested inside a service: its own git repo, no gate installed.
        # Must resolve relative to the NEAREST repo root (nested), and
        # since that repo has no gate, it is unkeyed rather than misattributed to "svc".
        self.assertEqual(
            coe.resolve(str(self.uc / "svc" / "nested" / "src" / "x.php"), self.uc),
            (None, "svc/nested/src/x.php"))


class TestDecide(unittest.TestCase):
    def test_blocking_returns_block(self):
        out = coe.decide("VIOLATIONS:\n  [blocking] m/s#x — app/A.php\n      do x\n")
        self.assertEqual(out["decision"], "block")
        self.assertIn("app/A.php", out["reason"])

    def test_recommended_returns_additional_context(self):
        out = coe.decide("VIOLATIONS:\n  [recommended] m/s#y — app/B.php\n      do y\n")
        self.assertIn("hookSpecificOutput", out)
        self.assertNotIn("decision", out)

    def test_no_violations_returns_none(self):
        self.assertIsNone(coe.decide(""))
        self.assertIsNone(coe.decide("No matching rules for the given files.\n"))


class TestMain(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        _init_repo(self.root)
        (self.root / ".claude" / "knowledge").mkdir(parents=True)
        self.prev = os.environ.get("CLAUDE_PROJECT_DIR")
        os.environ["CLAUDE_PROJECT_DIR"] = str(self.root)

    def tearDown(self):
        if self.prev is None:
            os.environ.pop("CLAUDE_PROJECT_DIR", None)
        else:
            os.environ["CLAUDE_PROJECT_DIR"] = self.prev
        self.tmp.cleanup()

    def _run_main(self, stdin_text):
        out = io.StringIO()
        old = sys.stdin
        sys.stdin = io.StringIO(stdin_text)
        try:
            with contextlib.redirect_stdout(out):
                coe.main()
        finally:
            sys.stdin = old
        return out.getvalue()

    def test_empty_stdin_is_silent(self):
        self.assertEqual(self._run_main(""), "")           # bad JSON -> fail-open, no output

    def test_missing_file_path_is_silent(self):
        self.assertEqual(self._run_main('{"tool_input": {}}'), "")

    def test_uncheckable_extension_is_silent(self):
        p = str(self.root / "README.md")            # .md -> resolve() returns None
        self.assertEqual(self._run_main(json.dumps({"tool_input": {"file_path": p}})), "")


class TestBuildCmd(unittest.TestCase):
    def test_service_file_argv(self):
        cmd = coe.build_cmd("/e/check.py", "some-service", "app/Foo.php", "/proj")
        self.assertEqual(cmd[1:], ["/e/check.py", "--checks-only", "--baseline", "HEAD",
                                   "--source", "hook", "--phase", "edit",
                                   "--root", "/proj",
                                   "--service", "some-service", "app/Foo.php"])

    def test_cross_service_file_omits_service(self):
        cmd = coe.build_cmd("/e/check.py", None, ".claude/scripts/x.py", "/proj")
        self.assertNotIn("--service", cmd)
        self.assertEqual(cmd[-1], ".claude/scripts/x.py")

    def test_phase_is_edit_not_commit(self):
        # src=hook covers both git hooks; only --phase separates the edit-time hook
        # from the pre-commit gate, and the caught-vs-landed split depends on it.
        cmd = coe.build_cmd("/e/check.py", None, "x.py", "/proj")
        self.assertEqual(cmd[cmd.index("--phase") + 1], "edit")

    def test_root_is_passed_to_the_engine(self):
        cmd = coe.build_cmd("/e/check.py", None, "x.py", "/proj")
        self.assertEqual(cmd[cmd.index("--root") + 1], "/proj")


if __name__ == "__main__":
    unittest.main()
