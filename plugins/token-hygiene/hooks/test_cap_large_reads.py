"""Black-box tests for cap-large-reads.py. Plain stdlib unittest."""
import os
import unittest

from testkit import TempHome, decision, run_hook

HOOK = "cap-large-reads.py"
DEFAULT_CAP = 24576


def read(path, session="s1", **tool_input):
    return {"hook_event_name": "PreToolUse", "tool_name": "Read", "session_id": session,
            "tool_input": dict(file_path=str(path), **tool_input)}


class CapLargeReadsTest(unittest.TestCase):
    def setUp(self):
        self.home = TempHome(self).path
        self.project = self.home / "project"
        self.project.mkdir()
        # 1,000 lines of 40 bytes: 40,000 bytes, well past the default cap.
        self.big = self.project / "big.py"
        self.big.write_text("x = 'padding padding padding padding'\n" * 1000)
        self.small = self.project / "small.py"
        self.small.write_text("x = 1\n" * 10)

    def hook(self, payload, **env):
        out, proc = run_hook(HOOK, payload, self.home, CLAUDE_PROJECT_DIR=self.project, **env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return out

    def test_an_unbounded_read_of_a_large_file_is_denied(self):
        out = self.hook(read(self.big))
        self.assertEqual(decision(out), "deny")
        self.assertIn(str(self.big), out["hookSpecificOutput"]["permissionDecisionReason"])

    def test_the_identical_second_attempt_is_allowed(self):
        self.hook(read(self.big))
        out = self.hook(read(self.big))
        self.assertIsNone(decision(out))

    def test_a_ranged_read_passes(self):
        self.assertIsNone(self.hook(read(self.big, limit=50)))
        self.assertIsNone(self.hook(read(self.big, offset=200)))

    def test_a_file_at_the_cap_passes(self):
        at_cap = self.project / "at_cap.txt"
        at_cap.write_text("y" * (DEFAULT_CAP - 1) + "\n")
        self.assertEqual(at_cap.stat().st_size, DEFAULT_CAP)
        self.assertIsNone(self.hook(read(at_cap)))

    def test_a_small_file_passes(self):
        self.assertIsNone(self.hook(read(self.small)))

    def test_read_cap_bytes_lowers_the_cap(self):
        medium = self.project / "medium.txt"
        medium.write_text("z" * 2047 + "\n")
        self.assertIsNone(self.hook(read(medium)))
        self.assertEqual(decision(self.hook(read(medium, session="s2"), READ_CAP_BYTES=1024)),
                         "deny")

    def test_a_rewritten_file_is_denied_afresh(self):
        self.hook(read(self.big))
        with self.big.open("a") as fh:
            fh.write("y = 2\n")
        self.assertEqual(decision(self.hook(read(self.big))), "deny")

    def test_sessions_do_not_share_the_relent(self):
        self.hook(read(self.big, session="a"))
        self.assertEqual(decision(self.hook(read(self.big, session="b"))), "deny")

    def test_images_and_pdfs_are_ignored(self):
        image = self.project / "shot.png"
        image.write_bytes(b"\x89PNG" + b"\0" * 40000)
        self.assertIsNone(self.hook(read(image)))

    def test_a_missing_file_is_left_to_the_tool(self):
        self.assertIsNone(self.hook(read(self.project / "nope.py")))

    def test_read_cap_disable_turns_it_off(self):
        self.assertIsNone(self.hook(read(self.big), READ_CAP_DISABLE=1))

    def test_malformed_stdin_fails_open(self):
        self.assertIsNone(self.hook("{not json"))


if __name__ == "__main__":
    unittest.main()
