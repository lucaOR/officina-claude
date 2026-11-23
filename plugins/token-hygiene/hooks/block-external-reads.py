#!/usr/bin/env python3
"""PreToolUse(Read, Bash): deny a direct Read or a Bash file-dump command
(cat/head/tail/sed/...) whose target path resolves outside the repo working
tree, and point at the one remedy that actually works.

Off by default: set EXTERNAL_READ_ENABLE=1 to turn it on. It is the one guard in
this plugin that refuses outright, with no second-attempt relent, and it assumes
Claude Code's scratchpad lives under /tmp/claude-*, which holds on Linux.

Why: cap-large-reads.py catches one large file by size, but the actual
violation this rule exists for is a *burst* of several individually-small
external files (e.g. reference material dropped under /mnt/d/Downloads/...)
that never trips a size cap yet still gets replayed on every later turn.
Externally-supplied reference material belongs in a subagent's own context,
not the main thread's. This hook makes that mechanical instead of relying on
an instruction being loaded and followed by judgment.

Dispatching a subagent alone does NOT bypass this: a subagent (fork or
fresh general-purpose) hits the identical PreToolUse gate as the main
thread, and this hook applies the same rule to both. The actual remedy: copy the
external material into the session scratchpad first (cp/mv — see
COPY_COMMANDS below), THEN dispatch a subagent to read it from there. That
still satisfies the real intent — raw external content never lands in the
main thread's own context — since a subagent's reads don't replay on the
main thread regardless of which allowed root they came from.

Allowed (not gated) as Read/dump-command targets, because they are the
project's own working areas rather than externally-supplied material:
  * anything inside the repo (CLAUDE_PROJECT_DIR)
  * anything inside ~/.claude/ (skills, agents, settings, and the auto-memory
    store at ~/.claude/projects/<slug>/memory/)
  * anything inside a Claude Code session scratchpad (/tmp/claude-*/...)

Everything else — another path under /tmp, /mnt/*, another user's home, etc.
— is denied for Read/dump-commands. No relent-once: unlike a large in-repo
file, there is no legitimate reason for the main thread to want raw external
material in its own context; the correct move is always copy-to-scratchpad,
then dispatch.

Bash matching is deliberately narrow: only a fixed set of dump-style
commands (cat, head, tail, sed, awk, more, less, nl, tac, strings, xxd, od,
hexdump, bat) are gated as reads, and only when they take an *absolute*
path argument (starting with / or ~). Relative paths are never inspected,
so cwd-tracking ambiguity can't produce a false positive on ordinary
in-repo commands.
The program text of sed/awk (`/A/,/B/p` is an address range, not a path) and the
body of a heredoc are not inspected; a script named with -f still is.

A second, narrower gate covers cp/mv/rsync: copying from an external source
to an absolute destination outside the scratchpad is denied, so the
sanctioned escape hatch (copy-to-scratchpad) can't double as a way to
smuggle external content straight into the repo tree or ~/.claude/ instead.
A relative destination is never inspected, same rationale as the dump-
command gate — it can't be resolved without the cwd-tracking this hook
deliberately avoids.

Enable with EXTERNAL_READ_ENABLE=1.
"""
import json
import os
import re
import shlex
import sys
from pathlib import Path

DUMP_COMMANDS = {
    "cat", "head", "tail", "tac", "nl", "more", "less", "sed", "awk",
    "strings", "xxd", "od", "hexdump", "bat",
}
COPY_COMMANDS = {"cp", "mv", "rsync"}
SPLIT_ON = re.compile(r"\|\||&&|[;|]")
# `<<[-]['"]TAG['"]` header line, then the body, then the terminator line. The header
# line is kept (it can still hold `| cmd` or a redirect); only body and terminator go.
HEREDOC = re.compile(
    r"(<<-?[ \t]*(['\"]?)(\w+)\2[^\n]*)\n.*?\n[ \t]*\3[ \t]*(?=\n|$)", re.DOTALL
)
SUBAGENT_HINT = (
    "A subagent hits this same gate — fork or fresh, it won't get past this either. "
    "Instead: cp/mv the material into the session scratchpad (/tmp/claude-*/...) first, "
    "THEN dispatch a read-only subagent (Explore, for instance) to "
    "read it from there and report back a summary — that keeps the raw external material "
    "out of this conversation and off every later turn's replay."
)


def allowed_roots():
    roots = []
    project_dir = os.environ.get("CLAUDE_PROJECT_DIR")
    if project_dir:
        roots.append(project_dir)
    roots.append(str(Path.home() / ".claude"))
    return roots


def is_external(path_str):
    try:
        resolved = str(Path(os.path.expanduser(path_str)).resolve())
    except (OSError, RuntimeError):
        return False
    for root in allowed_roots():
        try:
            root_resolved = str(Path(root).resolve())
        except (OSError, RuntimeError):
            continue
        if resolved == root_resolved or resolved.startswith(root_resolved + os.sep):
            return False
    if is_scratchpad(path_str):
        return False
    return True


def scratchpad_prefixes():
    """/tmp/claude-*, also as /tmp resolves (on macOS /tmp is a link to /private/tmp)."""
    return {"/tmp/claude-", os.path.realpath("/tmp") + "/claude-"}


def is_scratchpad(path_str):
    try:
        resolved = str(Path(os.path.expanduser(path_str)).resolve())
    except (OSError, RuntimeError):
        return False
    return any(resolved.startswith(prefix) for prefix in scratchpad_prefixes())


def emit_deny(reason):
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }))


def on_read(tool_input):
    file_path = tool_input.get("file_path")
    if not isinstance(file_path, str) or not file_path:
        return
    if not is_external(file_path):
        return
    emit_deny(
        "External path blocked: {p} is outside the repo working tree. "
        "{hint}".format(p=file_path, hint=SUBAGENT_HINT)
    )


def extract_absolute_paths(tokens):
    for tok in tokens:
        if tok.startswith("-"):
            continue
        if tok.startswith("/") or tok.startswith("~"):
            yield tok


def strip_heredoc_bodies(command):
    """Drop heredoc bodies: they are data written or fed to a command, never a path
    the command opens, so a body that merely mentions /usr/local must not be gated."""
    return HEREDOC.sub(lambda m: m.group(1), command)


def without_script(cmd, args):
    """For sed/awk, drop the program text: `/A/,/B/p` is an address range, not a path.
    A script named with -f / --file is a real file and stays in the result."""
    if cmd not in ("sed", "awk"):
        return args
    kept = []
    explicit = False
    i = 0
    while i < len(args):
        tok = args[i]
        i += 1
        if not tok.startswith("-") or tok == "-":
            kept.append(tok)
            continue
        long_form = tok.startswith("--")
        if tok == "--expression" or (cmd == "sed" and not long_form and tok.endswith("e")):
            explicit = True
            i += 1          # the next token is the script text
        elif tok == "--file" or (not long_form and tok.endswith("f")):
            explicit = True  # the next token is a script file; leave it for the path check
        elif cmd == "awk" and tok in ("-v", "-F"):
            i += 1          # the next token is a variable assignment or a separator
    if not explicit and kept:
        kept = kept[1:]     # first positional argument is the program text
    return kept


def on_bash(tool_input):
    command = tool_input.get("command")
    if not isinstance(command, str) or not command.strip():
        return
    for segment in SPLIT_ON.split(strip_heredoc_bodies(command)):
        segment = segment.strip()
        if not segment:
            continue
        try:
            tokens = shlex.split(segment)
        except ValueError:
            continue
        if not tokens:
            continue
        cmd = os.path.basename(tokens[0])
        if cmd in DUMP_COMMANDS:
            for path in extract_absolute_paths(without_script(cmd, tokens[1:])):
                if is_external(path):
                    emit_deny(
                        "External path blocked: `{cmd}` targets {p}, outside the repo working "
                        "tree. {hint}".format(cmd=cmd, p=path, hint=SUBAGENT_HINT)
                    )
                    return
        elif cmd in COPY_COMMANDS:
            abs_paths = list(extract_absolute_paths(tokens[1:]))
            if len(abs_paths) < 2:
                continue
            *sources, dest = abs_paths
            if not any(is_external(s) for s in sources):
                continue
            if is_scratchpad(dest):
                continue
            emit_deny(
                "External-sourced `{cmd}` blocked: destination {d} is outside the session "
                "scratchpad. Copying external material anywhere but the scratchpad defeats "
                "the escape hatch — cp/mv it into /tmp/claude-*/... instead, then dispatch a "
                "subagent to read it from there.".format(cmd=cmd, d=dest)
            )
            return


def main():
    if os.environ.get("EXTERNAL_READ_ENABLE") != "1":
        return
    data = json.load(sys.stdin)
    if data.get("hook_event_name") != "PreToolUse":
        return
    tool_name = data.get("tool_name")
    tool_input = data.get("tool_input") or {}
    if tool_name == "Read":
        on_read(tool_input)
    elif tool_name == "Bash":
        on_bash(tool_input)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass          # fail-open: never block a call because the hook broke
