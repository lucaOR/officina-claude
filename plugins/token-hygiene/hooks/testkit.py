"""Shared helpers for the hook tests: run a hook script the way Claude Code does.

Each hook reads one JSON payload on stdin and may print one JSON object on stdout. The
helpers below run the real script in a subprocess, with HOME and XDG_CACHE_HOME pointed at a
temporary directory so no test touches the real ~/.claude or ~/.cache, and with every knob the
hooks read removed from the environment so a variable exported in the caller's shell cannot
change what a test sees.
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HOOKS = Path(__file__).resolve().parent

KNOB_PREFIXES = (
    "READ_CAP_", "REREAD_GUARD_", "EXTERNAL_READ_", "SQUASH_", "NO_SQUASH",
    "CONTEXT_WARN", "CONTEXT_WATCHDOG_", "CLAUDE_PROJECT_DIR",
)


def clean_env(home, **extra):
    env = {k: v for k, v in os.environ.items() if not k.startswith(KNOB_PREFIXES)}
    env["HOME"] = str(home)
    env["XDG_CACHE_HOME"] = str(Path(home) / ".cache")
    env.update({k: str(v) for k, v in extra.items()})
    return env


def run_hook(script, payload, home, **env):
    """Run hooks/<script> with `payload` on stdin. Return (parsed stdout or None, process)."""
    stdin = payload if isinstance(payload, str) else json.dumps(payload)
    proc = subprocess.run(
        [sys.executable, str(HOOKS / script)], input=stdin, capture_output=True, text=True,
        env=clean_env(home, **env), timeout=30,
    )
    out = proc.stdout.strip()
    return (json.loads(out) if out else None), proc


def decision(out):
    """The PreToolUse permission decision in a hook's output, or None."""
    return ((out or {}).get("hookSpecificOutput") or {}).get("permissionDecision")


class TempHome:
    """A temporary HOME for one test, removed at cleanup."""

    def __init__(self, case):
        self._dir = tempfile.TemporaryDirectory()
        case.addCleanup(self._dir.cleanup)
        self.path = Path(self._dir.name)
