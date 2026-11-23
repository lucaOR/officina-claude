"""Fixture builders shared by the knowledge tests: temp projects, superprojects with
real submodules, and linked worktrees. Stdlib only; every git call is self-contained
(identity and default branch passed with -c) so no ambient git config is needed."""
from __future__ import annotations

import subprocess
from pathlib import Path

_GIT = ["git", "-c", "user.name=kb-test", "-c", "user.email=kb-test@example.invalid",
        "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"]


def git(repo: Path, *args: str, allow_file: bool = False) -> str:
    """Run git in `repo`, raising on failure, and return stdout."""
    cmd = list(_GIT)
    if allow_file:
        cmd += ["-c", "protocol.file.allow=always"]
    proc = subprocess.run(cmd + ["-C", str(repo), *args],
                          capture_output=True, text=True, check=True)
    return proc.stdout


def _write(root: Path, rel: str, text: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _commit_all(repo: Path, message: str = "init") -> None:
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "--allow-empty", "-m", message)


def make_project(base: Path, registries: dict[str, str] | None = None,
                 git: bool = True) -> Path:
    """Create `<base>/project`. `registries` maps a path relative to
    `.claude/knowledge/` (for example "rules.yaml") to its YAML text. With `git`
    the directory is a repository with one commit."""
    root = Path(base) / "project"
    root.mkdir(parents=True, exist_ok=True)
    for rel, text in (registries or {}).items():
        _write(root, f".claude/knowledge/{rel}", text)
    if git:
        _init_repo(root)
    return root


def _init_repo(root: Path) -> None:
    git_fn = globals()["git"]
    git_fn(root, "init", "-q")
    (root / "README.md").write_text("fixture\n", encoding="utf-8")
    _commit_all(root)


def make_superproject(base: Path, services: list[str],
                      registries: dict[str, str] | None = None) -> Path:
    """Create `<base>/super` with one real submodule per service. `registries` maps a
    path relative to the superproject root (for example "svc/.claude/knowledge/r.yaml"
    or ".claude/knowledge/r.yaml") to YAML text; a key under a service lands inside
    that service's repository."""
    base = Path(base)
    registries = dict(registries or {})
    sources = {}
    for svc in services:
        src = base / "_sources" / svc
        src.mkdir(parents=True)
        for rel in [k for k in registries if k.startswith(f"{svc}/")]:
            _write(src, rel[len(svc) + 1:], registries.pop(rel))
        _init_repo(src)
        sources[svc] = src
    sup = base / "super"
    sup.mkdir()
    _init_repo(sup)
    for svc, src in sources.items():
        git(sup, "submodule", "add", "-q", str(src), svc, allow_file=True)
    for rel, text in registries.items():
        _write(sup, rel, text)
    _commit_all(sup, "add services")
    return sup


def make_worktree(repo: Path, dest: Path) -> Path:
    """Add a linked worktree of `repo` at `dest` on a fresh branch and return it."""
    dest = Path(dest)
    git(repo, "worktree", "add", "-q", "-b", f"wt-{dest.name}", str(dest))
    return dest
