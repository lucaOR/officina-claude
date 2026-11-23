"""Black-box tests for skip-redundant-reads.py. Plain stdlib unittest."""
import unittest

from testkit import TempHome, decision, run_hook

HOOK = "skip-redundant-reads.py"


def read(event, path, session="s1", agent=None, error=False, **tool_input):
    payload = {"hook_event_name": event, "tool_name": "Read", "session_id": session,
               "tool_input": dict(file_path=str(path), **tool_input)}
    if agent:
        payload["agent_id"] = agent
    if event == "PostToolUse":
        payload["tool_response"] = {"is_error": True} if error else {"type": "text"}
    return payload


class SkipRedundantReadsTest(unittest.TestCase):
    def setUp(self):
        self.home = TempHome(self).path
        self.project = self.home / "project"
        self.project.mkdir()
        self.file = self.project / "service.py"
        self.file.write_text("line\n" * 500)

    def hook(self, payload, **env):
        out, proc = run_hook(HOOK, payload, self.home, CLAUDE_PROJECT_DIR=self.project, **env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return out

    def received(self, **kw):
        """A Read the guard let through and the tool delivered."""
        self.assertIsNone(decision(self.hook(read("PreToolUse", self.file, **kw))))
        self.hook(read("PostToolUse", self.file, **kw))

    def attempt(self, **kw):
        return decision(self.hook(read("PreToolUse", self.file, **kw)))

    def test_a_first_read_passes(self):
        self.assertIsNone(self.attempt())

    def test_rereading_a_delivered_range_is_denied(self):
        self.received()
        self.assertEqual(self.attempt(), "deny")

    def test_the_identical_second_attempt_is_allowed(self):
        self.received()
        self.attempt()
        self.assertIsNone(self.attempt())

    def test_a_range_not_yet_delivered_passes(self):
        self.received(offset=1, limit=100)
        self.assertIsNone(self.attempt(offset=101, limit=50))

    def test_a_range_covered_by_two_earlier_reads_is_denied(self):
        self.received(offset=1, limit=100)
        self.received(offset=101, limit=100)
        self.assertEqual(self.attempt(offset=50, limit=100), "deny")

    def test_a_range_that_overhangs_the_delivered_ones_passes(self):
        self.received(offset=1, limit=100)
        self.assertIsNone(self.attempt(offset=50, limit=100))

    def test_a_changed_file_passes(self):
        self.received()
        with self.file.open("a") as fh:
            fh.write("new\n")
        self.assertIsNone(self.attempt())

    def test_clear_starts_a_new_epoch(self):
        self.received()
        self.hook({"hook_event_name": "SessionStart", "source": "clear", "session_id": "s1"})
        self.assertIsNone(self.attempt())

    def test_compact_starts_a_new_epoch(self):
        self.received()
        self.hook({"hook_event_name": "SessionStart", "source": "compact", "session_id": "s1"})
        self.assertIsNone(self.attempt())

    def test_resume_keeps_the_epoch(self):
        self.received()
        self.hook({"hook_event_name": "SessionStart", "source": "resume", "session_id": "s1"})
        self.assertEqual(self.attempt(), "deny")

    def test_a_failed_read_is_not_recorded(self):
        self.attempt()
        self.hook(read("PostToolUse", self.file, error=True))
        self.assertIsNone(self.attempt())

    def test_a_subagent_has_its_own_record(self):
        self.received()
        self.assertIsNone(self.attempt(agent="agent-1"))

    def test_another_session_has_its_own_record(self):
        self.received()
        self.assertIsNone(self.attempt(session="s2"))

    def test_images_are_ignored(self):
        image = self.project / "shot.png"
        image.write_bytes(b"\x89PNG")
        self.hook(read("PostToolUse", image))
        self.assertIsNone(decision(self.hook(read("PreToolUse", image))))

    def test_reread_guard_disable_turns_it_off(self):
        self.received()
        self.assertIsNone(decision(self.hook(read("PreToolUse", self.file),
                                             REREAD_GUARD_DISABLE=1)))

    def test_malformed_stdin_fails_open(self):
        self.assertIsNone(self.hook("{not json"))


if __name__ == "__main__":
    unittest.main()
