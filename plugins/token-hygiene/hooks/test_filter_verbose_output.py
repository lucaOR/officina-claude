"""Black-box tests for filter-verbose-output.py and squash-output.py. Plain stdlib unittest.

The rewrite tests run the rewritten command for real in bash, against a fake `pytest` on PATH,
so they check what actually lands in the agent's context and which exit status Claude Code
sees, not just the shape of the rewritten string.
"""
import os
import stat
import subprocess
import sys
import unittest
from pathlib import Path

from testkit import HOOKS, TempHome, clean_env, run_hook

HOOK = "filter-verbose-output.py"


def bash(command, **tool_input):
    return {"hook_event_name": "PreToolUse", "tool_name": "Bash",
            "tool_input": dict(command=command, **tool_input)}


class FilterVerboseOutputTest(unittest.TestCase):
    def setUp(self):
        self.home = TempHome(self).path
        self.bin = self.home / "bin"
        self.bin.mkdir()

    def fake_pytest(self, lines, status):
        script = self.bin / "pytest"
        script.write_text(
            "#!/usr/bin/env bash\n"
            "for i in $(seq 1 {n}); do echo \"tests/test_$i.py PASSED\"; done\n"
            "[ {n} -gt 10 ] && echo 'FAILED tests/test_boom.py::test_x - AssertionError' >&2\n"
            "for i in $(seq 1 {n}); do echo \"tests/more_$i.py PASSED\"; done\n"
            "exit {status}\n".format(n=lines // 2, status=status)
        )
        script.chmod(script.stat().st_mode | stat.S_IEXEC)

    def rewrite(self, command, **kw):
        out, proc = run_hook(HOOK, bash(command, **kw), self.home)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return out["hookSpecificOutput"]["updatedInput"]["command"] if out else None

    def execute(self, command):
        env = clean_env(self.home)
        env["PATH"] = "{0}:{1}".format(self.bin, os.environ["PATH"])
        return subprocess.run(["bash", "-c", command], capture_output=True, text=True,
                              env=env, timeout=30)

    def test_large_output_is_condensed_and_keeps_the_failure(self):
        self.fake_pytest(lines=2000, status=1)
        proc = self.execute(self.rewrite("pytest -q"))
        lines = proc.stdout.splitlines()
        self.assertLess(len(lines), 300)
        self.assertIn("FAILED tests/test_boom.py::test_x - AssertionError", proc.stdout)
        self.assertIn("tests/test_1.py PASSED", proc.stdout)        # head kept
        self.assertIn("tests/more_1000.py PASSED", proc.stdout)     # tail kept
        self.assertNotIn("tests/test_500.py PASSED", proc.stdout)   # middle elided

    def test_the_wrapped_command_keeps_its_exit_status(self):
        self.fake_pytest(lines=2000, status=3)
        self.assertEqual(self.execute(self.rewrite("pytest -q")).returncode, 3)

    def test_small_output_passes_through_verbatim(self):
        self.fake_pytest(lines=6, status=0)
        rewritten = self.execute(self.rewrite("pytest -q"))
        direct = self.execute("pytest -q")
        self.assertEqual(rewritten.stdout, direct.stdout)
        self.assertEqual(rewritten.returncode, 0)

    def test_an_ordinary_command_is_left_alone(self):
        self.assertIsNone(self.rewrite("ls -la"))

    def test_a_command_already_piped_into_a_filter_is_left_alone(self):
        self.assertIsNone(self.rewrite("pytest -q | tail -20"))

    def test_output_redirected_to_a_file_is_left_alone(self):
        self.assertIsNone(self.rewrite("pytest -q > pytest.log"))

    def test_no_squash_prefix_is_left_alone(self):
        self.assertIsNone(self.rewrite("NO_SQUASH=1 pytest -q"))

    def test_a_background_command_is_left_alone(self):
        self.assertIsNone(self.rewrite("pytest -q", run_in_background=True))

    def test_squash_disable_turns_it_off(self):
        out, _ = run_hook(HOOK, bash("pytest -q"), self.home, SQUASH_DISABLE=1)
        self.assertIsNone(out)

    def test_malformed_stdin_fails_open(self):
        out, proc = run_hook(HOOK, "{not json", self.home)
        self.assertEqual(proc.returncode, 0)
        self.assertIsNone(out)


class SquashOutputTest(unittest.TestCase):
    def squash(self, text):
        home = TempHome(self).path
        return subprocess.run([sys.executable, str(HOOKS / "squash-output.py")], input=text,
                              capture_output=True, text=True, env=clean_env(home), timeout=30)

    def test_it_never_exits_non_zero(self):
        self.assertEqual(self.squash("".join("l{0}\n".format(i) for i in range(5000))).returncode, 0)

    def test_a_signal_line_from_the_middle_survives(self):
        body = ["ok {0}\n".format(i) for i in range(1000)]
        body[500] = "ERROR: database unreachable\n"
        out = self.squash("".join(body)).stdout
        self.assertIn("ERROR: database unreachable", out)
        self.assertNotIn("ok 499\n", out)

    def test_the_marker_says_how_much_was_hidden_and_how_to_see_it(self):
        out = self.squash("".join("ok {0}\n".format(i) for i in range(1000))).stdout
        self.assertIn("1000 lines", out)
        self.assertIn("NO_SQUASH=1", out)


if __name__ == "__main__":
    unittest.main()
