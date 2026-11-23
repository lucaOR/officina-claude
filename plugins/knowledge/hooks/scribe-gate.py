#!/usr/bin/env python3
"""UserPromptSubmit and PreToolUse(Skill) hook: keep `/knowledge:kb run` (the queue drain)
inside the scribe session.

The skill's own prose re-check is a second line of defence; this hook is the boundary. A typed
`/knowledge:kb run` (or `/kb run`, with or without `--audit`) and a Skill-tool call of the kb
skill with those args are refused unless the session is the scribe: `agent_type` is
`knowledge:scribe` or `scribe` in the payload, or CLAUDE_ROLE is `scribe`, and the call does not
come from a subagent. Claude Code sets `agent_type` both for a `--agent` main thread and for a
subagent of that type, and only a subagent's payload carries `agent_id`, so a payload with a
non-empty `agent_id` is never the scribe session. A `/kb` push whose text merely starts with
"run" ("/kb run tests before committing") is a push and goes through.

Every prompt and every Skill call in every project runs this hook, so it decides on the payload
first and resolves the project root (git spawns in a linked worktree) only for a drain it would
block.

Fails open and silent: no knowledge base in the project, unparseable input or any error means
exit 0 with empty stdout.
"""
import json
import os
import re
import sys
from collections.abc import Mapping
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import paths  # noqa: E402

SCRIBE_AGENTS = {"knowledge:scribe", "scribe"}
DRAIN = re.compile(r"\s*run(\s+--audit)?\s*")
PROMPT = re.compile(r"\s*/(?:knowledge:)?kb\s+(.*)", re.DOTALL)
SKILLS = {"knowledge:kb", "kb"}

REASON = ("`/knowledge:kb run` runs only in the scribe session. Start one with "
          "`claude --agent knowledge:scribe -n kb-scribe` (or `ccscribe`). To queue an "
          "observation from here, use `/knowledge:kb <text>`.")


def is_scribe(payload: dict, env: Mapping[str, str]) -> bool:
    if payload.get("agent_id"):
        return False                               # a subagent, never the scribe session
    return payload.get("agent_type") in SCRIBE_AGENTS or env.get("CLAUDE_ROLE") == "scribe"


def is_drain(args: str) -> bool:
    return DRAIN.fullmatch(args) is not None


def decide(payload: dict, env: Mapping[str, str]) -> dict | None:
    """The block output for `payload`, or None to let it through."""
    if is_scribe(payload, env):
        return None
    if payload.get("hook_event_name") == "PreToolUse":
        if payload.get("tool_name") != "Skill":
            return None
        tool_input = payload.get("tool_input") or {}
        if tool_input.get("skill") in SKILLS and is_drain(str(tool_input.get("args") or "")):
            return {"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                           "permissionDecision": "deny",
                                           "permissionDecisionReason": REASON}}
        return None
    prompt = payload.get("prompt")
    match = PROMPT.fullmatch(prompt) if isinstance(prompt, str) else None
    if match and is_drain(match.group(1)):
        return {"decision": "block", "reason": REASON}
    return None


def main() -> None:
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            return
        out = decide(payload, os.environ)
        if out and paths.has_knowledge(paths.project_root()):
            print(json.dumps(out))
    except Exception:
        pass                                       # fail-open: never block a prompt on a bug


if __name__ == "__main__":
    main()
