#!/usr/bin/env python3
"""PreToolUse(Bash): pipe known-verbose commands through squash-output.py so a
10,000-line test log lands in the agent's context as a few hundred lines.

Why: tool output is the largest single contributor to context size, and because
every response replays the whole context, one fat log is paid for on every
subsequent turn of the session — not once. Filtering at the source is the only
lever that removes the tokens instead of compressing them.

Safety properties:
  * The filter only condenses output that is actually large (see squash-output.py's
    passthrough thresholds), so a false-positive pattern match costs nothing.
  * `set -o pipefail` + a filter that always exits 0 means the wrapped command's
    exit status is preserved.
  * No `permissionDecision` is returned, so the normal permission flow still applies
    to the rewritten command.
  * Escape hatch: prefix any command with `NO_SQUASH=1` to bypass the rewrite.
  * Fail-open: any error here leaves the command untouched.

Disable entirely with SQUASH_DISABLE=1.
"""
import json
import os
import re
import shlex
import sys
from pathlib import Path

SQUASH = Path(__file__).resolve().parent / "squash-output.py"

# Commands whose output is routinely thousands of lines. Keep this list tight:
# an over-broad pattern merges stderr into stdout for commands that did not need it.
VERBOSE = re.compile(
    r"""(?x)
    \b(
        php \s+ artisan \s+ (test|migrate)
      | (vendor/bin/)? (phpunit|pest) \b
      | pytest \b
      | go \s+ test \b
      | cargo \s+ test \b
      | (yarn|npm|pnpm) \s+ (run \s+)? (test|build|lint) \b
      | ng \s+ (test|build|lint) \b
      | composer \s+ (install|update|require|dump-autoload) \b
      | (yarn|npm|pnpm) \s+ install \b
      | docker (-compose)? \s+ (compose \s+)? logs \b
      | \./gradlew \b
      | gradle \s+ (build|test|assemble)
      | mvn \s+
      | pip3? \s+ install \b
      | apt (-get)? \s+ install \b
    )
    """
)

# The caller already reduced the output; adding a second filter would fight it.
ALREADY_FILTERED = re.compile(
    r"\|\s*(grep|egrep|fgrep|rg|ag|head|tail|sed|awk|wc|jq|yq|cut|sort|uniq|tee|less|more|python3?\b)"
)

# Cases where rewriting is wrong rather than merely unhelpful.
SKIP = re.compile(
    r"(^|\s)NO_SQUASH="                 # explicit bypass
    r"|(^|\s)\d?>>?\s*[^&\s]"           # output redirected to a file: capture intent
    r"|\s-(it|ti)\s"                    # interactive tty
    r"|&\s*$"                           # backgrounded
    r"|\btail\s+-f\b|--follow\b|--watch\b|(^|\s)-f(\s|$)"   # streams that never end
)


def rewrite(command):
    """Return the wrapped command, or None to leave it alone."""
    if not VERBOSE.search(command):
        return None
    if SKIP.search(command):
        return None
    if ALREADY_FILTERED.search(command):
        return None
    # Brace group (not a subshell) so a `cd` inside the command still affects the
    # tool's shell; the newline before `}` avoids needing a trailing `;`.
    return "set -o pipefail; {{ {cmd}\n}} 2>&1 | python3 {filt}".format(
        cmd=command, filt=shlex.quote(str(SQUASH))
    )


def main():
    if os.environ.get("SQUASH_DISABLE") == "1":
        return
    data = json.load(sys.stdin)
    if data.get("tool_name") != "Bash":
        return
    tool_input = data.get("tool_input") or {}
    if tool_input.get("run_in_background"):
        return
    command = tool_input.get("command")
    if not isinstance(command, str) or not command.strip():
        return
    wrapped = rewrite(command)
    if not wrapped:
        return
    updated = dict(tool_input)
    updated["command"] = wrapped
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "updatedInput": updated,
        }
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass          # fail-open: never block or alter a command because the hook broke
