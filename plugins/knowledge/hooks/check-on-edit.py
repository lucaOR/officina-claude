#!/usr/bin/env python3
"""PostToolUse hook: run the knowledge check engine (diff-aware) on the just-edited file and
feed introduced violations back to the agent. Violations-only, tiered (block on [blocking],
inform on [recommended]), fail-open.

Records to the ledger as phase=edit. This is the only moment that knows a violation was
INTRODUCED by the agent rather than found lying in the tree, so it is the numerator of the
whole effectiveness metric: a violation seen here and absent from the commit gate is a
catch, and one seen at both is a miss the warning failed to prevent. The engine drops
reminder rows at phase=edit, so this costs about two rows per edit."""
import contextlib
import io
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import lib  # noqa: E402  (needs the sys.path line above)
import paths  # noqa: E402

ENGINE = Path(__file__).resolve().parents[1] / "scripts" / "check.py"
CHECKABLE = {".php", ".yaml", ".yml", ".py", ".sh"}


def _repo_root(path, root):
    """Nearest ancestor of `path` that is a git repo root (has a .git entry), stopping
    at the project root itself. None if path is outside the project.

    Walking upward rather than only inspecting parts[0] is what tells a nested clone
    (its own repo with its own commit history) apart from an
    ordinary service subdirectory — parts[0] alone cannot see the nested .git."""
    cur = path
    stop = Path(root).resolve()
    try:
        cur.relative_to(stop)
    except ValueError:
        return None
    while True:
        if (cur / ".git").exists():
            return cur
        if cur == stop:
            return None
        cur = cur.parent


def _gate_installed(repo_root, marker):
    """Ground truth: does this repo have the shared KB pre-commit gate installed.

    Checks the live hook file for the project's `gate_marker` rather than any manifest — a
    manifest states intent while installation state is what actually runs on this machine,
    and the two can drift apart independently (e.g. a service added to the manifest before
    anyone has re-run the hook installer here)."""
    try:
        git_dir = subprocess.run(
            ["git", "-C", str(repo_root), "rev-parse", "--absolute-git-dir"],
            capture_output=True, text=True, check=True, timeout=5,
        ).stdout.strip()
    except (subprocess.CalledProcessError, OSError, subprocess.TimeoutExpired):
        return False
    hook = Path(git_dir) / "hooks" / "pre-commit"
    try:
        return marker in hook.read_text(encoding="utf-8")
    except OSError:
        return False


def resolve(file_path, root, marker=None):
    """Map an edited file path to (service|None, rel_path), or None if out of tree / uncheckable.

    "Keyed" (service is not None) means: the file sits in a repo whose KB gate is
    actually installed, so an edit-phase violation here has a commit-phase counterpart
    that could catch it too. A nested repo with no gate installed or a repo whose .claude
    dir exists but whose gate was never installed is unkeyed for exactly the same reason
    the root repo is: nothing could have caught it at commit time, so it must not be scored
    as a coverage failure. `marker` defaults to the project's `gate_marker`."""
    if Path(file_path).suffix not in CHECKABLE:
        return None
    try:
        resolved = Path(file_path).resolve()
        rel = resolved.relative_to(Path(root).resolve())
    except (ValueError, OSError):
        return None
    if marker is None:
        with contextlib.redirect_stderr(io.StringIO()):
            marker = lib.load_config(Path(root))["gate_marker"]
    repo_root = _repo_root(resolved.parent, root)
    if repo_root is None or repo_root == Path(root).resolve():
        return None, str(rel)
    if not _gate_installed(repo_root, marker):
        return None, str(rel)
    return repo_root.name, str(resolved.relative_to(repo_root))


def decide(stdout):
    """From check.py --checks-only stdout, return the hook response dict, or None."""
    lines = [ln for ln in stdout.splitlines() if ln.startswith("  [")]
    if not lines:
        return None
    body = "Knowledge-base check on your edit flagged introduced violation(s):\n" + "\n".join(lines)
    if any(ln.startswith("  [blocking]") for ln in lines):
        return {"decision": "block", "reason": body}
    return {"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": body}}


def build_cmd(engine, service, rel, root, python=None):
    """argv for one edit-time engine run. Extracted so the flags are testable without
    executing the engine. --source hook covers both git-adjacent hooks; --phase edit is
    what separates this from the pre-commit gate downstream."""
    cmd = [python or sys.executable, str(engine), "--checks-only", "--baseline", "HEAD",
           "--source", "hook", "--phase", "edit", "--root", str(root)]
    if service:
        cmd += ["--service", service]
    cmd.append(rel)
    return cmd


def main():
    try:
        root = paths.project_root()
        if not paths.has_knowledge(root):
            return
        data = json.load(sys.stdin)
        fp = (data.get("tool_input") or {}).get("file_path")
        if not fp:
            return
        resolved = resolve(fp, root)
        if resolved is None:
            return
        service, rel = resolved
        proc = subprocess.run(build_cmd(ENGINE, service, rel, root), capture_output=True,
                              text=True)
        out = decide(proc.stdout)
        if out:
            print(json.dumps(out))
    except Exception:
        pass


if __name__ == "__main__":
    main()
