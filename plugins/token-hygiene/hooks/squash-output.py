#!/usr/bin/env python3
"""stdin filter: pass small command output through verbatim, condense large output
to head + signal lines + tail.

Used by filter-verbose-output.py, which pipes known-verbose Bash commands through
it. Never exits non-zero, so `set -o pipefail` lets the wrapped command's own exit
status reach Claude Code unchanged.

Tunable via env: SQUASH_PASS_LINES, SQUASH_PASS_BYTES, SQUASH_HEAD, SQUASH_TAIL,
SQUASH_SIGNAL.
"""
import os
import re
import sys
from collections import deque


def env_int(name, default):
    try:
        return int(os.environ[name])
    except (KeyError, ValueError):
        return default


PASS_LINES = env_int("SQUASH_PASS_LINES", 120)   # under this, output is emitted verbatim
PASS_BYTES = env_int("SQUASH_PASS_BYTES", 24000)
HEAD_LINES = env_int("SQUASH_HEAD", 30)
TAIL_LINES = env_int("SQUASH_TAIL", 40)
MAX_SIGNAL = env_int("SQUASH_SIGNAL", 120)

# Lines worth keeping out of the elided middle: failures, errors, test summaries.
# Deliberately narrow — a pattern that matches most lines defeats the filter.
SIGNAL = re.compile(
    r"\b(FAIL|FAILED|FAILURE|FAILURES|ERROR|ERRORS|FATAL|Exception|Traceback|panic:)\b"
    r"|\bAssertion\w*\b"
    r"|(^|\s)(error|fatal|Error|Fatal):"
    r"|^\s*(not ok|✗|✖|×|E )"
    r"|\b\d+ (failed|errored|passed|skipped|incomplete|risky|assertions?)\b"
    r"|^(Tests|Time|OK|Summary|Result)[:!( ]"
    r"|^\d+\) "                                      # PHPUnit/Pest failure enumerator
    r"|\bThere (was|were) \d+ (failure|error)"
)


def absorb(n, line, head, signal):
    if len(head) < HEAD_LINES:
        head.append((n, line))
    if len(signal) < MAX_SIGNAL and SIGNAL.search(line):
        signal.append((n, line))


def main():
    try:
        sys.stdin.reconfigure(errors="replace")
    except (AttributeError, ValueError):
        pass

    head, signal = [], []
    tail = deque(maxlen=TAIL_LINES)
    buffered = []
    nlines = nbytes = 0
    small = True

    for line in sys.stdin:
        nlines += 1
        nbytes += len(line)
        if small and nlines <= PASS_LINES and nbytes <= PASS_BYTES:
            buffered.append(line)
            continue
        if small:
            # Crossed a threshold: replay what was buffered through the condenser.
            small = False
            buffered.append(line)
            for i, ln in enumerate(buffered, start=1):
                absorb(i, ln, head, signal)
                tail.append((i, ln))
            buffered = []
            continue
        absorb(nlines, line, head, signal)
        tail.append((nlines, line))

    out = sys.stdout
    if small:
        out.writelines(buffered)
        return

    shown = {n for n, _ in head} | {n for n, _ in tail}
    sig = [(n, ln) for n, ln in signal if n not in shown]
    hidden = nlines - len(shown) - len(sig)

    for _, ln in head:
        out.write(ln)
    out.write(
        "\n--- squashed by token-hygiene: {n} lines / {kb:.0f} KB, "
        "{h} lines hidden. Prefix the command with NO_SQUASH=1 for the full output. ---\n".format(
            n=nlines, kb=nbytes / 1024.0, h=max(hidden, 0)
        )
    )
    if sig:
        out.write("--- {c} signal line(s) from the elided middle ---\n".format(c=len(sig)))
        for n, ln in sig:
            out.write("{n}: {ln}".format(n=n, ln=ln if ln.endswith("\n") else ln + "\n"))
    out.write("--- last {c} lines ---\n".format(c=len(tail)))
    for _, ln in tail:
        out.write(ln)


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        pass
    except Exception as exc:
        # A filter that fails must not fail the command it wraps — but it must say so,
        # otherwise truncated output reads as a command that produced nothing.
        sys.stdout.write(
            "\n--- squash-output.py failed ({t}: {e}); output above may be truncated. "
            "Re-run with NO_SQUASH=1. ---\n".format(t=type(exc).__name__, e=exc)
        )
