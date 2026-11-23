#!/usr/bin/env python3
"""What `/knowledge:setup` can seed from: the Claude memory directory, the repo's agent
instruction files and its other tracked markdown.

`memory_dir(root)` resolves the memory directory: `autoMemoryDirectory` from the project's
`settings.local.json`, then the user's settings, else `<config dir>/projects/<slug>/memory`.
Setup does not use a value from the committed `.claude/settings.json`, although Claude Code
itself honours it there under workspace trust: a cloned repository could otherwise point setup
at any directory of the user's markdown, which setup would offer to seed from and retire. When
that file sets it and `settings.local.json` does not, `discover` reports the skipped value as
`memory_dir_ignored`, so setup can tell the user.
The slug is the path of the repository's main worktree (paths.main_worktree, so a linked
worktree shares its main checkout's memory, as Claude Code's memory docs say: "all worktrees
and subdirectories within the same repo share one auto memory directory"), resolved, with every
character outside [A-Za-z0-9] replaced by `-`. The config dir is $CLAUDE_CONFIG_DIR or ~/.claude.

`discover(root)` returns `{"kb_exists", "memory", "instructions", "other_markdown"}`, plus
`memory_dir_ignored` (the committed value, as written) when setup skipped one.
`kb_exists` means `.claude/knowledge/` already holds rules: a registry YAML other than
`config.yaml`, outside `.local/`. Setup writes `config.yaml` before it seeds and a push creates
`.local/`, so neither counts. `memory` lists `{"name", "path"}` for each `*.md` directly in the
memory dir except MEMORY.md (empty when the dir is absent). Paths elsewhere are relative to the
root with forward slashes.
`other_markdown` groups by first path component, root-level files under ".".

CLI: `sources.py [--root R]` prints `discover(root)` plus `memory_dir` as JSON."""
from __future__ import annotations

import argparse
import fnmatch
import json
import os
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import paths  # noqa: E402

EXCLUDED_DIRS = {"node_modules", "vendor", "dist", "build"}
INSTRUCTION_NAMES = {"CLAUDE.md", "AGENTS.md", "GEMINI.md", ".cursorrules", ".windsurfrules"}
NEVER = {"CLAUDE.local.md", "MEMORY.md"}
SKIP_PREFIXES = ("README", "CHANGELOG", "LICENSE")


def config_dir() -> Path:
    env = os.environ.get("CLAUDE_CONFIG_DIR")
    return Path(env) if env else Path.home() / ".claude"


def _raw_setting(path: Path):
    try:
        value = json.loads(path.read_text(encoding="utf-8")).get("autoMemoryDirectory")
    except (OSError, ValueError, AttributeError):
        return None
    return value if isinstance(value, str) and value else None


def _setting(path: Path):
    value = _raw_setting(path)
    return Path(value).expanduser() if value else None


def ignored_memory_dir(root: Path) -> str | None:
    """The committed `.claude/settings.json` value of `autoMemoryDirectory` that setup skips,
    when `settings.local.json` does not override it anyway (Claude Code's local > project
    order); None otherwise."""
    root = Path(root)
    if _raw_setting(root / ".claude" / "settings.local.json"):
        return None
    return _raw_setting(root / ".claude" / "settings.json")


def memory_dir(root: Path) -> Path | None:
    root = Path(root)
    for settings in (root / ".claude" / "settings.local.json", config_dir() / "settings.json"):
        found = _setting(settings)
        if found:
            return found
    slug = re.sub(r"[^A-Za-z0-9]", "-", str(paths.main_worktree(root).resolve()))
    return config_dir() / "projects" / slug / "memory"


def has_rules(root: Path) -> bool:
    kdir = Path(root) / paths.KB_REL
    if not kdir.is_dir():
        return False
    for p in kdir.rglob("*.yaml"):
        rel = p.relative_to(kdir)
        if rel.parts[0] != ".local" and rel != Path("config.yaml"):
            return True
    return False


def _git_files(root: Path):
    def run(*args):
        proc = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True)
        if proc.returncode != 0:
            raise OSError(proc.stderr)
        return proc.stdout.split("\0")
    try:
        tracked = run("ls-files", "-z", "--cached", "--recurse-submodules")
        others = run("ls-files", "-z", "--others", "--exclude-standard")
    except OSError:
        return None
    return sorted({p for p in tracked + others if p and (root / p).is_file()})


def _walk_files(root: Path):
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d != ".git"]
        for f in filenames:
            out.append((Path(dirpath) / f).relative_to(root).as_posix())
    return sorted(out)


def _excluded(rel: str) -> bool:
    parts = rel.split("/")
    return bool(EXCLUDED_DIRS & set(parts[:-1])) or rel.startswith(".claude/knowledge/")


def _is_instruction(rel: str) -> bool:
    name = rel.rsplit("/", 1)[-1]
    if name in NEVER:
        return False
    return (name in INSTRUCTION_NAMES or rel == ".github/copilot-instructions.md"
            or fnmatch.fnmatch(rel, ".cursor/rules/*"))


def discover(root: Path) -> dict:
    root = Path(root)
    files = None
    if (root / ".git").exists():
        files = _git_files(root)
    if files is None:
        files = _walk_files(root)
    files = [f for f in files if not _excluded(f)]
    instructions = [f for f in files if _is_instruction(f)]
    other: dict[str, list] = {}
    for f in files:
        name = f.rsplit("/", 1)[-1]
        if (not f.endswith(".md") or f in instructions or name in NEVER
                or name.startswith(SKIP_PREFIXES)):
            continue
        key = f.split("/")[0] if "/" in f else "."
        other.setdefault(key, []).append(f)
    mem_dir = memory_dir(root)
    memory = []
    if mem_dir and mem_dir.is_dir():
        memory = [{"name": p.name, "path": str(p)} for p in sorted(mem_dir.glob("*.md"))
                  if p.name != "MEMORY.md" and p.is_file()]
    out = {"kb_exists": has_rules(root), "memory": memory,
           "instructions": instructions, "other_markdown": other}
    ignored = ignored_memory_dir(root)
    if ignored:
        out["memory_dir_ignored"] = ignored
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", default=None)
    args = ap.parse_args()
    root = paths.project_root(args.root)
    out = discover(root)
    mem = memory_dir(root)
    out["memory_dir"] = str(mem) if mem else None
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
