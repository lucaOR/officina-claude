#!/usr/bin/env python3
"""Where the project is: the one place any knowledge script learns its root.

The engine ships inside a plugin, so a script's own location says nothing about the
project it serves. The root comes from an explicit argument, else $CLAUDE_PROJECT_DIR,
else the working directory, and is then lifted to the enclosing superproject when the
start is a submodule."""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

KB_REL = Path(".claude") / "knowledge"


class NotInGit(RuntimeError):
    """The directory is not inside any git work tree."""


def _git(start: Path, *args: str) -> str:
    try:
        proc = subprocess.run(["git", "-C", str(start), *args],
                              capture_output=True, text=True)
    except OSError:
        return ""
    return proc.stdout.strip() if proc.returncode == 0 else ""


def project_root(explicit: str | Path | None = None) -> Path:
    """Explicit argument wins. Otherwise start at $CLAUDE_PROJECT_DIR or the cwd: a plain
    repository (`.git` is a directory) is its own root without spawning git; else the
    superproject, then the toplevel, then the start itself when git knows nothing."""
    if explicit:
        return Path(explicit).resolve()
    start = Path(os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()).resolve()
    if (start / ".git").is_dir():
        return start
    for query in ("--show-superproject-working-tree", "--show-toplevel"):
        out = _git(start, "rev-parse", query)
        if out:
            return Path(out).resolve()
    return start


def has_knowledge(root: Path) -> bool:
    return (Path(root) / KB_REL).is_dir()


def skip_without_knowledge(root: Path, tool: str) -> bool:
    """True, after one stderr line, when `root` has no knowledge base. Callers return
    straight away so a project that never adopted the plugin sees a clean exit 0."""
    if has_knowledge(root):
        return False
    print(f"{tool}: no {KB_REL.as_posix()}/ in {root}; nothing to do", file=sys.stderr)
    return True


def main_worktree(root: Path) -> Path:
    """The main worktree of the repository `root` belongs to: the parent of git's common
    dir when that is a `.git` directory that exists here; otherwise (not git, unreachable,
    submodule) `root` itself."""
    base = Path(root)
    common = _git(base, "rev-parse", "--git-common-dir")
    if common:
        cpath = Path(common)
        cpath = (cpath if cpath.is_absolute() else base / cpath).resolve()
        if cpath.name == ".git" and cpath.is_dir():
            return cpath.parent
    return base


def local_dir(root: Path, create: bool = True) -> Path:
    """Per-machine state: the queue, its lock and the telemetry. $KNOWLEDGE_LOCAL_DIR wins;
    else `.claude/knowledge/.local` under the main worktree (main_worktree), so every
    linked worktree feeds one queue. With `create` the directory exists and ignores itself
    from git."""
    env = os.environ.get("KNOWLEDGE_LOCAL_DIR")
    if env:
        path = Path(env)
    else:
        path = main_worktree(root) / KB_REL / ".local"
    if create:
        path.mkdir(parents=True, exist_ok=True)
        ignore = path / ".gitignore"
        if not ignore.exists():
            ignore.write_text("*\n", encoding="utf-8")
    return path


def metrics_file(root: Path, name: str) -> Path:
    """`<local dir>/metrics/<name>`, its directory created."""
    path = local_dir(root) / "metrics" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def git_context(cwd: Path | None = None) -> tuple[Path, str | None]:
    """(project root, service name). A submodule reports its superproject and its own
    name; a repository whose parent directory holds the knowledge base reports the
    parent and its own name; anything else is its own root with no service."""
    start = Path(cwd) if cwd is not None else Path.cwd()
    top = _git(start, "rev-parse", "--show-toplevel")
    if not top:
        raise NotInGit(f"{start} is not inside a git work tree")
    top_path = Path(top).resolve()
    sup = _git(start, "rev-parse", "--show-superproject-working-tree")
    if sup:
        return Path(sup).resolve(), top_path.name
    if has_knowledge(top_path.parent):
        return top_path.parent, top_path.name
    return top_path, None


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if args != ["git-context"]:
        print("usage: paths.py git-context", file=sys.stderr)
        return 2
    try:
        root, service = git_context()
    except NotInGit:
        return 1
    print(f"{root}\t{service or ''}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
