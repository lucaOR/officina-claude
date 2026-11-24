#!/usr/bin/env python3
"""PreToolUse(Agent): deny a subagent dispatch that asks for an Opus model, unless its
description names one of the jobs Opus is kept for.

Off by default: set OPUS_GUARD_ENABLE=1 to turn it on. Which model a team's subagents run on is
a policy choice, so the plugin does not impose one on everyone who installs it.

Why: a subagent is billed for its own context on every call it makes, at its own model's price.
In one two-week sample, Opus general-purpose subagents were the largest single cost, and most of
them were implementers, per-task reviewers and fix waves. Those were dispatched with an explicit
`model: "opus"` by planning and execution skills, so an instruction in CLAUDE.md alone did not
stop them. Sonnet does that work for about half the price per token.

Opus passes for:
  * a final review of a whole branch ("Final whole-branch review", "Final review of plan 3")
  * design or architecture work
  * a fix-loop escalation ("Escalated fix round 4")
  * any dispatch whose prompt has a line `Opus risk: <the specific risk>`, because a diff with a
    named risk is the one case a description alone cannot show

The deny patterns are checked before the allow patterns, because "Final-review fix wave" names a
final review but is a fix wave. Anything that matches neither list is denied. A deny costs one
turn of the dispatching conversation, and the reason tells the model how to re-dispatch.

Enable with OPUS_GUARD_ENABLE=1.
"""
import json
import os
import re
import sys

ESCALATION = re.compile(r"escalat", re.IGNORECASE)
NAMED_RISK = re.compile(r"^[ \t]*opus risk:[ \t]*\S", re.IGNORECASE | re.MULTILINE)
WORKER = re.compile(
    r"\bfix|\bre-?review|\bimplement|\bpre-?flight|\bper-task|\btask \d", re.IGNORECASE
)
OPUS_JOB = re.compile(r"\bfinal\b.{0,20}\breview|whole-branch|\bdesign|\barchitect", re.IGNORECASE)

REASON = (
    "Opus subagent blocked: \"{d}\" is not one of the jobs Opus is kept for. Re-dispatch it with "
    "model \"sonnet\". Opus is for a final review of a whole branch, for design or architecture "
    "work, and for a fix-loop escalation, and the description has to say which. For a diff with "
    "a specific risk, add a line `Opus risk: <the risk>` to the prompt instead."
)


def is_opus(model):
    return isinstance(model, str) and "opus" in model.lower()


def allowed(description, prompt):
    if NAMED_RISK.search(prompt) or ESCALATION.search(description):
        return True
    if WORKER.search(description):
        return False
    return bool(OPUS_JOB.search(description))


def main():
    if os.environ.get("OPUS_GUARD_ENABLE") != "1":
        return
    data = json.load(sys.stdin)
    if data.get("hook_event_name") != "PreToolUse" or data.get("tool_name") != "Agent":
        return
    tool_input = data.get("tool_input") or {}
    if not is_opus(tool_input.get("model")):
        return
    description = tool_input.get("description") or ""
    prompt = tool_input.get("prompt") or ""
    if allowed(str(description), str(prompt)):
        return
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": REASON.format(d=description),
        }
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass          # fail-open: never block a call because the hook broke
