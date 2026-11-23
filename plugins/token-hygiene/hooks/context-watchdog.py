#!/usr/bin/env python3
"""Context watchdog: interrupt once per compaction cycle when resident context passes a threshold.

One script, two events, one latch:

  PreToolUse (every tool)  deny one tool call at the crossing, so a turn that keeps chaining
                           tool calls is stopped in place instead of running on to 250k.
  Stop                     block the stop at the crossing, so the model hands off before the
                           human's next prompt lands on an even bigger context.

Why compact early at all. A response is billed almost entirely for the context resident in it
(measured on one project: 99.4% of billed tokens, 0.59% output), so a session's bill is the area
under its context curve. Compaction resets that curve to a flat ~70k floor and its rebuild cost
is a one-shot spike, which makes compacting EARLIER than the harness default the cheapest lever
available without changing how you work: the modelled optimum is 110-130k against an observed
auto-compaction median of 188k, worth 16-29%.

Why the number has to be computed here. No hook can trigger compaction, and none receives a
token count as an input field. PreCompact fires only once the harness has already decided to
compact, at its own threshold, so it cannot move that threshold. But every event receives
`transcript_path`, and the last assistant response's `usage` carries exactly the resident
context (input + cache_read + cache_creation). Only the human can type /compact or /clear, so
the hook's job is to stop the work and say so.

Why both events. Stop alone only looks when the model's turn ends; a turn that fans out
subagents or runs a long grep-read-edit sweep never reaches Stop, and context can run from 120k
to 250k inside it. PreToolUse is the only place a mid-turn crossing can be caught. A deny there
interrupts without forcing more work; a Stop block costs one more turn at full context, and earns
it because the model can act on it by writing a handoff note.

Why one latch. The `armed` flag per session in ~/.claude/state/context-watchdog.json is shared by
both events: whichever crosses first disarms both, so a crossing produces ONE interruption rather
than a deny followed by a block at the end of the same turn. Context falling back under the
threshold (a compaction or a /clear) rearms it.

Why `Skill` is exempt, before any context math. The way out of the deny is a skill (a handoff),
and the latch lives in a shared, unlocked file that a concurrent session can clobber, which would
rearm this session and let the deny fire again. The exemption keeps the escape route open even
then.

Loop guards. Stop honours the harness's own `stop_hook_active` re-entry flag first. And the
interruption (deny or block) is emitted ONLY when the disarm actually persisted; a failed write
degrades to a message, because an interruption that cannot be durably cleared would fire on every
tool call or every stop. Fail-open throughout: a watchdog must never break a session.

Knobs: CONTEXT_WARN_TOKENS retunes the threshold (default 150000). CONTEXT_WATCHDOG_MODE=wild
keeps the number visible but downgrades both interruptions to a message, for a session that means
to run past the threshold on purpose. CONTEXT_WARN=0 silences the watchdog entirely.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

DEFAULT_THRESHOLD = 150_000
STATE = Path.home() / ".claude" / "state" / "context-watchdog.json"
WILD = "wild"
EXEMPT_TOOLS = ("Skill",)
# Tail sizes tried in order when hunting for the last assistant response. A response's records sit
# at the very end of the transcript, so the first is almost always enough; the larger retry covers
# a turn that emitted an unusually large tool_result after it.
TAIL_BYTES = (262_144, 2_097_152)

WAYS_OUT = ("If the /session:handoff skill is available, invoke it and output its note, then "
            "stop and tell the user to run /clear. Otherwise stop and tell the user to run "
            "/compact. /clear and /compact are built-in commands, so the user must type them; "
            "you cannot.")
KNOBS = ("Set CONTEXT_WARN_TOKENS to retune, CONTEXT_WATCHDOG_MODE=wild for advice without "
         "interruptions, or CONTEXT_WARN=0 to silence.")
NOT_INTERRUPTING_WILD = ("Not interrupting: CONTEXT_WATCHDOG_MODE=wild turns the watchdog into "
                         "advice only.")
NOT_INTERRUPTING_LATCH = ("Not interrupting: the watchdog could not save its state, and an "
                          "interruption it cannot clear would fire again on every call.")


def threshold() -> int:
    try:
        return max(1, int(os.environ.get("CONTEXT_WARN_TOKENS", DEFAULT_THRESHOLD)))
    except ValueError:
        return DEFAULT_THRESHOLD


def watchdog_mode() -> str:
    """Anything unrecognised falls back to interrupting, so a typo fails safe rather than
    silently disabling the guard."""
    return os.environ.get("CONTEXT_WATCHDOG_MODE", "").strip().lower() or "block"


def resident_context(path: str | None) -> int | None:
    """Resident context of the last billed response = input + cache_read + cache_creation.

    Reads only the tail of the transcript: these files reach hundreds of MB and this runs before
    every tool call, so a full parse would be a real latency cost for one number at the end.
    """
    if not path:
        return None
    try:
        size = os.path.getsize(path)
    except OSError:
        return None
    for want in TAIL_BYTES:
        try:
            with open(path, "rb") as fh:
                start = max(0, size - want)
                fh.seek(start)
                blob = fh.read()
        except OSError:
            return None
        lines = blob.decode("utf-8", errors="replace").split("\n")
        if start > 0:
            lines = lines[1:]                      # drop the partial line the seek landed inside
        for line in reversed(lines):
            line = line.strip()
            if not line or line[0] != "{":
                continue
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            if obj.get("type") != "assistant":
                continue
            usage = (obj.get("message") or {}).get("usage") or {}
            if not usage:
                continue
            return (usage.get("input_tokens", 0)
                    + usage.get("cache_read_input_tokens", 0)
                    + usage.get("cache_creation_input_tokens", 0))
        if start == 0:                             # whole file already scanned; a bigger tail won't help
            break
    return None


def load_state() -> dict:
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_state(state: dict) -> bool:
    """Return whether the write persisted. The caller must know, because interrupting on the
    strength of an unpersisted disarm is how the interruption loops forever."""
    try:
        STATE.parent.mkdir(parents=True, exist_ok=True)
        STATE.write_text(json.dumps(state), encoding="utf-8")
        return True
    except OSError:
        return False


def decide(ctx: int | None, limit: int, armed: bool) -> tuple[bool, bool]:
    """Return (fire, next_armed). Fires once per crossing; falling back under the limit rearms."""
    if ctx is None:
        return False, armed
    if ctx < limit:
        return False, True
    return (True, False) if armed else (False, False)


def deny(ctx: int, limit: int) -> dict:
    return {"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": (
            f"Context is at {ctx:,} tokens (threshold {limit:,}), so this tool call was denied "
            f"to stop the turn growing further. Do not retry it: every further response is "
            f"billed for roughly this much. {WAYS_OUT} {KNOBS}"),
    }}


def block(ctx: int, limit: int) -> dict:
    return {"decision": "block",
            "reason": f"Context is at {ctx:,} tokens (threshold {limit:,}). Before doing "
                      f"anything else: {WAYS_OUT}"}


def advice(ctx: int, limit: int, why_not: str) -> dict:
    """The non-interrupting path, shown to the human. It never emits permissionDecision "allow",
    which would auto-approve a call the user would otherwise have been asked about. The order
    carries the recommendation: at a clean boundary a handoff and /clear beat a compaction."""
    return {"systemMessage": (
        f"Context is at {ctx:,} tokens (threshold {limit:,}). Every further response is billed "
        f"for roughly this much. At a clean task boundary, prefer /session:handoff then /clear, "
        f"which starts lower than the floor a compaction leaves. Mid-task, with nothing clean to "
        f"put in a note, run /compact instead. {why_not} {KNOBS}")}


def main() -> None:
    try:
        if os.environ.get("CONTEXT_WARN") == "0":
            return
        data = json.load(sys.stdin)
        event = data.get("hook_event_name")
        if event == "PreToolUse":
            if data.get("tool_name") in EXEMPT_TOOLS:
                return                             # the escape route out of the deny
        elif event == "Stop":
            if data.get("stop_hook_active"):
                return                             # the harness replaying a blocked stop
        else:
            return
        session = data.get("session_id") or "unknown"
        ctx = resident_context(data.get("transcript_path"))
        limit = threshold()
        state = load_state()
        armed = bool(state.get(session, {}).get("armed", True))
        fire, next_armed = decide(ctx, limit, armed)
        persisted = True
        if next_armed != armed or session not in state:
            state[session] = {"armed": next_armed}
            persisted = save_state(state)
        if not fire:
            return
        if watchdog_mode() == WILD:
            out = advice(ctx, limit, NOT_INTERRUPTING_WILD)
        elif not persisted:
            out = advice(ctx, limit, NOT_INTERRUPTING_LATCH)
        elif event == "PreToolUse":
            out = deny(ctx, limit)
        else:
            out = block(ctx, limit)
        print(json.dumps(out))
    except Exception:
        pass                                       # fail-open: never break a session over a warning


if __name__ == "__main__":
    main()
