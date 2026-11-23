import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

HOOKS = Path(__file__).resolve().parent
sys.path.insert(0, str(HOOKS.parent / "scripts"))

import testkit  # noqa: E402

REASON_START = "`/knowledge:kb run` runs only in the scribe session."


class GateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.project = testkit.make_project(
            self.base, {"r.yaml": "scope: project\ntopic: t\nrules: []\n"})

    def tearDown(self):
        self.tmp.cleanup()

    def run_hook(self, payload, role=None, raw=None):
        env = {k: v for k, v in os.environ.items() if k != "CLAUDE_ROLE"}
        env["CLAUDE_PROJECT_DIR"] = str(self.project)
        env["KNOWLEDGE_LOCAL_DIR"] = str(self.base / "local")
        if role:
            env["CLAUDE_ROLE"] = role
        stdin = raw if raw is not None else json.dumps(payload)
        proc = subprocess.run([sys.executable, str(HOOKS / "scribe-gate.py")], input=stdin,
                              env=env, capture_output=True, text=True, timeout=60)
        return proc.returncode, proc.stdout, proc.stderr

    def prompt(self, text, **extra):
        return dict({"hook_event_name": "UserPromptSubmit", "prompt": text}, **extra)

    def skill(self, args, **extra):
        return dict({"hook_event_name": "PreToolUse", "tool_name": "Skill",
                     "tool_input": {"skill": "knowledge:kb", "args": args}}, **extra)

    def test_typed_drain_blocked_outside_scribe(self):
        for text in ("/knowledge:kb run", "/kb run", "/kb run --audit", "  /knowledge:kb   run  "):
            with self.subTest(text=text):
                rc, out, err = self.run_hook(self.prompt(text))
                self.assertEqual((rc, err), (0, ""))
                data = json.loads(out)
                self.assertEqual(data["decision"], "block")
                self.assertTrue(data["reason"].startswith(REASON_START))
                self.assertIn("claude --agent knowledge:scribe -n kb-scribe", data["reason"])

    def test_push_starting_with_run_not_blocked(self):
        for text in ("/knowledge:kb run tests before committing", "/kb runbook link"):
            with self.subTest(text=text):
                self.assertEqual(self.run_hook(self.prompt(text)), (0, "", ""))

    def test_other_prompt_silent(self):
        for text in ("hello", "/kb", "/other run"):
            with self.subTest(text=text):
                self.assertEqual(self.run_hook(self.prompt(text)), (0, "", ""))

    def test_scribe_agent_type_allowed(self):
        for agent in ("knowledge:scribe", "scribe"):
            with self.subTest(agent=agent):
                self.assertEqual(self.run_hook(self.prompt("/kb run", agent_type=agent)),
                                 (0, "", ""))
                self.assertEqual(self.run_hook(self.skill("run", agent_type=agent)), (0, "", ""))

    def test_scribe_type_subagent_denied(self):
        # Claude Code sets agent_type for a `--agent` main thread and for a subagent of that
        # type alike; only a subagent carries agent_id. An ordinary session that spawns the
        # knowledge:scribe subagent must not get a drain through it.
        for agent in ("knowledge:scribe", "scribe"):
            with self.subTest(agent=agent):
                rc, out, err = self.run_hook(self.skill("run", agent_type=agent, agent_id="a1"))
                self.assertEqual((rc, err), (0, ""))
                self.assertEqual(json.loads(out)["hookSpecificOutput"]["permissionDecision"],
                                 "deny")
        rc, out, _ = self.run_hook(self.skill("run --audit", agent_id="a1"), role="scribe")
        self.assertEqual(json.loads(out)["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_empty_agent_id_is_the_main_thread(self):
        self.assertEqual(self.run_hook(self.skill("run", agent_type="knowledge:scribe",
                                                  agent_id="")), (0, "", ""))

    def test_claude_role_env_allowed(self):
        self.assertEqual(self.run_hook(self.prompt("/kb run"), role="scribe"), (0, "", ""))
        self.assertNotEqual(self.run_hook(self.prompt("/kb run"), role="worker")[1], "")

    def test_skill_tool_drain_denied(self):
        rc, out, err = self.run_hook(self.skill("run"))
        self.assertEqual((rc, err), (0, ""))
        specific = json.loads(out)["hookSpecificOutput"]
        self.assertEqual(specific["hookEventName"], "PreToolUse")
        self.assertEqual(specific["permissionDecision"], "deny")
        self.assertTrue(specific["permissionDecisionReason"].startswith(REASON_START))

    def test_skill_tool_push_allowed(self):
        self.assertEqual(self.run_hook(self.skill("remember X")), (0, "", ""))
        other = {"hook_event_name": "PreToolUse", "tool_name": "Skill",
                 "tool_input": {"skill": "other", "args": "run"}}
        self.assertEqual(self.run_hook(other), (0, "", ""))

    def test_subdirectory_cwd_still_gates(self):
        sub = self.project / "app"
        sub.mkdir()
        self.assertNotEqual(self.run_hook(self.prompt("/kb run", cwd=str(sub)))[1], "")

    def test_bad_stdin_fails_open(self):
        self.assertEqual(self.run_hook(None, raw="not json"), (0, "", ""))
        self.assertEqual(self.run_hook(None, raw="[]"), (0, "", ""))


class CheapPathTest(unittest.TestCase):
    """The gate runs on every prompt and every Skill call in every project. Only a drain
    outside the scribe needs the project root (two git spawns in a linked worktree), so
    everything else returns before resolving it."""

    def setUp(self):
        spec = importlib.util.spec_from_file_location("scribe_gate", HOOKS / "scribe-gate.py")
        self.gate = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.gate)

    def run_main(self, payload):
        with mock.patch.object(self.gate.paths, "project_root",
                               side_effect=AssertionError("resolved the root")) as root, \
                mock.patch.object(sys, "stdin", io.StringIO(json.dumps(payload))), \
                redirect_stdout(io.StringIO()) as out:
            self.gate.main()
        return root.call_count, out.getvalue()

    def test_ordinary_prompt_and_tool_skip_the_root(self):
        for payload in ({"hook_event_name": "UserPromptSubmit", "prompt": "hello"},
                        {"hook_event_name": "UserPromptSubmit", "prompt": "/kb remember X"},
                        {"hook_event_name": "PreToolUse", "tool_name": "Bash",
                         "tool_input": {"command": "ls"}},
                        {"hook_event_name": "PreToolUse", "tool_name": "Skill",
                         "tool_input": {"skill": "other", "args": "run"}}):
            with self.subTest(payload=payload):
                self.assertEqual(self.run_main(payload), (0, ""))


if __name__ == "__main__":
    unittest.main()
