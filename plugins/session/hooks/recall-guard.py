#!/usr/bin/env python3
"""PreToolUse(Bash) hook: the recall subagent may run only `recall.py search` and `recall.py show`.

The subagent reads archived transcript text, which is untrusted (it can hold fetched web
pages), so a prose rule is not enough. Plugin agents ignore `hooks` and `permissionMode`
frontmatter and the `tools` field takes no command patterns, so the guard lives here.

The hook input carries `agent_type`, which is `session:recall` inside that subagent and absent
in the main session. Any other caller returns at once, with no output. For the recall agent the
command must be one line `python3 "<this plugin's recall.py>" search|show <args>`, args being
plain tokens, optionally followed on a `search --stdin` line by a `<<'RECALL_WORDINGS'` heredoc
whose body runs to a final line that is exactly `RECALL_WORDINGS`. The quoted delimiter makes the
body literal, so the body may hold any text except a delimiter line before the end.

Fail-open for everyone but the recall agent. For the recall agent any error exits 2, which blocks.
"""
import json
import os
import re
import sys

AGENT = "session:recall"
DELIM = "RECALL_WORDINGS"
SCRIPT = os.path.realpath(os.path.join(
    os.path.dirname(os.path.realpath(__file__)), "..", "skills", "recall", "scripts", "recall.py"))
FIRST = re.compile(
    r'^python3 "([^"]+)" (search|show)((?: [A-Za-z0-9_.=:/-]+)*)( <<\'' + DELIM + r"')?$")
REASON = "recall agent may run only recall.py search or show; this call was blocked"


def allowed(command):
    if command.endswith("\n"):
        command = command[:-1]
    lines = command.split("\n")
    m = FIRST.match(lines[0])
    if not m or os.path.realpath(m.group(1)) != SCRIPT:
        return False
    sub, args, heredoc = m.group(2), m.group(3).split(), m.group(4)
    if not heredoc:
        return len(lines) == 1
    if sub != "search" or not args or args[-1] != "--stdin":
        return False
    return len(lines) >= 2 and lines[-1] == DELIM and DELIM not in lines[1:-1]


def main():
    try:
        data = json.load(sys.stdin)
        agent = data.get("agent_type")
    except Exception:
        return 0
    if agent != AGENT:
        return 0
    try:
        if allowed(data["tool_input"]["command"]):
            return 0
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": REASON}}))
        return 0
    except Exception as exc:
        print("recall guard failed closed: %s" % type(exc).__name__, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
