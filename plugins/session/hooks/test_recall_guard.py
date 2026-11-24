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


if __name__ == "__main__":
    unittest.main()
