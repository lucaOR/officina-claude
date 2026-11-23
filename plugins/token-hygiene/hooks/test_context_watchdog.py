"""Black-box tests for context-watchdog.py. Plain stdlib unittest.

The watchdog reads the resident context from the last assistant response in the transcript
(input + cache_read + cache_creation) and fires once per crossing of the threshold: a deny on
PreToolUse, a block on Stop. One latch, kept in ~/.claude/state/context-watchdog.json, is
shared by both events.
"""
import json
import unittest

from testkit import TempHome, decision, run_hook

HOOK = "context-watchdog.py"
DEFAULT_THRESHOLD = 150_000


def response(input_t=0, read=0, creation=0, out=1):
    return {"type": "assistant", "message": {"id": "msg_x", "usage": {
        "input_tokens": input_t, "cache_read_input_tokens": read,
        "cache_creation_input_tokens": creation, "output_tokens": out}}}


class WatchdogTest(unittest.TestCase):
    def setUp(self):
        self.home = TempHome(self).path
        self.transcript = self.home / "session.jsonl"
        self.at(1_000)

    def at(self, ctx, *trailing):
        """Rewrite the transcript so its last response carries `ctx` resident tokens."""
        records = [response(read=10), response(read=ctx)] + list(trailing)
        self.transcript.write_text("".join(json.dumps(r) + "\n" for r in records))

    def payload(self, event, tool="Read", session="s1", **extra):
        p = {"hook_event_name": event, "session_id": session,
             "transcript_path": str(self.transcript), **extra}
        if event == "PreToolUse":
            p.update(tool_name=tool, tool_input={})
        return p

    def hook(self, payload, **env):
        out, proc = run_hook(HOOK, payload, self.home, **env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return out

    def tool_call(self, tool="Read", session="s1", **env):
        return self.hook(self.payload("PreToolUse", tool=tool, session=session), **env)

    def stop(self, session="s1", **env):
        return self.hook(self.payload("Stop", session=session), **env)

    # -- firing -----------------------------------------------------------------------------

    def test_below_the_threshold_nothing_fires(self):
        self.at(DEFAULT_THRESHOLD - 1)
        self.assertIsNone(self.tool_call())
        self.assertIsNone(self.stop())

    def test_a_crossing_denies_one_tool_call_then_lets_the_next_through(self):
        self.at(DEFAULT_THRESHOLD)
        self.assertEqual(decision(self.tool_call()), "deny")
        self.assertIsNone(self.tool_call())

    def test_a_crossing_blocks_one_stop_then_lets_the_next_through(self):
        self.at(DEFAULT_THRESHOLD + 5_000)
        self.assertEqual(self.stop()["decision"], "block")
        self.assertIsNone(self.stop())

    def test_output_tokens_are_not_resident_context(self):
        self.transcript.write_text(json.dumps(response(read=100_000, out=900_000)) + "\n")
        self.assertIsNone(self.tool_call())

    def test_the_three_resident_components_add_up(self):
        self.transcript.write_text(
            json.dumps(response(input_t=10, read=100_000, creation=50_000)) + "\n")
        self.assertEqual(decision(self.tool_call()), "deny")

    def test_the_last_response_counts_even_behind_a_huge_tool_result(self):
        self.at(DEFAULT_THRESHOLD, {"type": "user", "message": {"content": "x" * 400_000}})
        self.assertEqual(decision(self.tool_call()), "deny")

    def test_context_warn_tokens_moves_the_threshold(self):
        self.at(60_000)
        self.assertEqual(decision(self.tool_call(CONTEXT_WARN_TOKENS=50_000)), "deny")

    # -- the shared latch -------------------------------------------------------------------

    def test_a_mid_turn_deny_silences_the_stop_for_that_crossing(self):
        self.at(DEFAULT_THRESHOLD)
        self.tool_call()
        self.assertIsNone(self.stop())

    def test_a_stop_block_silences_the_next_tool_call(self):
        self.at(DEFAULT_THRESHOLD)
        self.stop()
        self.assertIsNone(self.tool_call())

    def test_falling_back_under_the_threshold_rearms_it(self):
        self.at(DEFAULT_THRESHOLD)
        self.tool_call()
        self.at(70_000)
        self.tool_call()
        self.at(DEFAULT_THRESHOLD)
        self.assertEqual(decision(self.tool_call()), "deny")

    def test_another_session_has_its_own_latch(self):
        self.at(DEFAULT_THRESHOLD)
        self.tool_call(session="a")
        self.assertEqual(decision(self.tool_call(session="b")), "deny")

    # -- escape routes and knobs ------------------------------------------------------------

    def test_the_skill_tool_is_never_denied_and_keeps_the_latch(self):
        self.at(DEFAULT_THRESHOLD)
        self.assertIsNone(self.tool_call(tool="Skill"))
        self.assertEqual(decision(self.tool_call()), "deny")

    def test_a_replayed_stop_never_blocks(self):
        self.at(DEFAULT_THRESHOLD)
        self.assertIsNone(self.hook(self.payload("Stop", stop_hook_active=True)))

    def test_context_warn_zero_silences_both(self):
        self.at(DEFAULT_THRESHOLD)
        self.assertIsNone(self.tool_call(CONTEXT_WARN=0))
        self.assertIsNone(self.stop(CONTEXT_WARN=0))

    def test_wild_mode_turns_the_deny_into_a_message_and_spends_the_latch(self):
        self.at(DEFAULT_THRESHOLD)
        out = self.tool_call(CONTEXT_WATCHDOG_MODE="Wild")
        self.assertIsNone(decision(out))
        self.assertIn("150,000", out["systemMessage"])
        self.assertIsNone(self.tool_call(CONTEXT_WATCHDOG_MODE="wild"))

    def test_wild_mode_turns_the_stop_block_into_a_message(self):
        self.at(DEFAULT_THRESHOLD)
        out = self.stop(CONTEXT_WATCHDOG_MODE="wild")
        self.assertNotIn("decision", out)
        self.assertIn("systemMessage", out)

    def test_an_unknown_mode_still_denies(self):
        self.at(DEFAULT_THRESHOLD)
        self.assertEqual(decision(self.tool_call(CONTEXT_WATCHDOG_MODE="wlid")), "deny")

    def test_an_unwritable_latch_degrades_to_a_message_instead_of_looping(self):
        (self.home / ".claude").mkdir()
        (self.home / ".claude" / "state").write_text("a file where the directory should be")
        self.at(DEFAULT_THRESHOLD)
        out = self.tool_call()
        self.assertIsNone(decision(out))
        self.assertIn("systemMessage", out)
        out = self.stop()
        self.assertNotIn("decision", out)
        self.assertIn("systemMessage", out)

    # -- advice -----------------------------------------------------------------------------

    def test_the_advice_offers_a_handoff_and_a_compaction(self):
        """The plugin cannot assume the session plugin is installed, so the model is told both
        ways out and which one the user has to type."""
        self.at(DEFAULT_THRESHOLD)
        reason = self.tool_call()["hookSpecificOutput"]["permissionDecisionReason"]
        for route in ("/session:handoff", "/clear", "/compact"):
            self.assertIn(route, reason)

    def test_a_project_handoff_skill_counts_as_a_way_out(self):
        """A project can ship its own handoff skill instead of the session plugin. Naming only
        /session:handoff would steer such a project onto /compact at every crossing. The skill
        stays unnamed, because the plugin cannot know what a project calls it."""
        self.at(DEFAULT_THRESHOLD)
        reason = self.tool_call()["hookSpecificOutput"]["permissionDecisionReason"]
        self.assertIn("the project's own", reason)
        advice = self.tool_call(session="s2", CONTEXT_WATCHDOG_MODE="wild")["systemMessage"]
        self.assertIn("the project's own", advice)

    # -- fail-open --------------------------------------------------------------------------

    def test_a_missing_transcript_is_inert(self):
        self.transcript.unlink()
        self.assertIsNone(self.tool_call())

    def test_malformed_stdin_fails_open(self):
        self.assertIsNone(self.hook("{not json"))


if __name__ == "__main__":
    unittest.main()
