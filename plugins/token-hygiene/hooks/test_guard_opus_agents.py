"""Black-box tests for guard-opus-agents.py. Plain stdlib unittest.

The descriptions below are shaped on real dispatches from one two-week sample, where 117 Opus
subagents ran and most of them were implementers, per-task reviewers and fix waves.
"""
import unittest

from testkit import decision, run_hook

HOOK = "guard-opus-agents.py"
HOME = "/srv/home"


def agent(description, model="opus", prompt="Do the work.", tool="Agent"):
    tool_input = {"description": description, "prompt": prompt,
                  "subagent_type": "general-purpose"}
    if model is not None:
        tool_input["model"] = model
    return {"hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": tool_input}


class GuardOpusAgentsTest(unittest.TestCase):
    def hook(self, payload, enabled=True):
        env = {"OPUS_GUARD_ENABLE": "1"} if enabled else {}
        out, proc = run_hook(HOOK, payload, HOME, **env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return out

    def verdict(self, payload, enabled=True):
        return decision(self.hook(payload, enabled))

    def test_it_is_off_unless_enabled(self):
        self.assertIsNone(self.verdict(agent("Implement Task 3: parser"), enabled=False))

    def test_an_opus_implementer_is_denied(self):
        self.assertEqual(self.verdict(agent("Implement Task 3: parser")), "deny")

    def test_an_opus_per_task_review_is_denied(self):
        self.assertEqual(self.verdict(agent("Review Task 4 (spec + quality)")), "deny")

    def test_an_opus_fix_wave_is_denied_even_after_a_final_review(self):
        self.assertEqual(self.verdict(agent("Final-review fix wave plan 2")), "deny")
        self.assertEqual(self.verdict(agent("Re-review final fix wave")), "deny")

    def test_an_opus_pre_flight_scan_is_denied(self):
        self.assertEqual(self.verdict(agent("Plan B pre-flight scan")), "deny")

    def test_an_unclassified_opus_dispatch_is_denied(self):
        self.assertEqual(self.verdict(agent("Move docs plugin to new repo")), "deny")

    def test_the_deny_reason_names_the_way_out(self):
        reason = self.hook(agent("Implement Task 3: parser"))["hookSpecificOutput"][
            "permissionDecisionReason"]
        self.assertIn('"sonnet"', reason)
        self.assertIn("Opus risk:", reason)

    def test_a_final_whole_branch_review_passes(self):
        self.assertIsNone(self.verdict(agent("Final whole-branch review plan 6a")))
        self.assertIsNone(self.verdict(agent("Final review of plan 3 branch")))

    def test_design_and_architecture_work_passes(self):
        self.assertIsNone(self.verdict(agent("Design the sync protocol")))
        self.assertIsNone(self.verdict(agent("Architecture options for storage")))

    def test_a_fix_loop_escalation_passes(self):
        self.assertIsNone(self.verdict(agent("Escalated fix round 4")))

    def test_a_named_risk_in_the_prompt_passes(self):
        prompt = "Fix the findings.\nOpus risk: lock ordering across two workers can deadlock.\n"
        self.assertIsNone(self.verdict(agent("Fix wave plan 2", prompt=prompt)))

    def test_an_empty_risk_line_does_not_pass(self):
        self.assertEqual(self.verdict(agent("Fix wave plan 2", prompt="Opus risk:\n")), "deny")

    def test_a_full_opus_model_id_is_guarded_too(self):
        self.assertEqual(self.verdict(agent("Implement Task 3", model="claude-opus-5-5")), "deny")

    def test_other_models_pass(self):
        self.assertIsNone(self.verdict(agent("Implement Task 3: parser", model="sonnet")))
        self.assertIsNone(self.verdict(agent("Implement Task 3: parser", model=None)))

    def test_other_tools_pass(self):
        self.assertIsNone(self.verdict(agent("Implement Task 3", tool="Bash")))

    def test_malformed_stdin_fails_open(self):
        out, proc = run_hook(HOOK, "{not json", HOME, OPUS_GUARD_ENABLE=1)
        self.assertEqual(proc.returncode, 0)
        self.assertIsNone(out)


if __name__ == "__main__":
    unittest.main()
