#!/usr/bin/env python3
"""Find the installed knowledge plugin directory. Stdlib only and importing nothing from
the plugin, because a copy of this file sits next to installed git hooks (and in projects
that vendor it), where the plugin's own modules are not on the path.

Lookup order: $KNOWLEDGE_PLUGIN_DIR; then Claude Code's plugin registry, first a project or
local entry whose projectPath is this project, then one whose projectPath is the main checkout
when this project is a linked git worktree (an install is recorded under the checkout it was
made from), then a user entry. The main checkout is the parent of `git rev-parse
--git-common-dir` when that is a `.git` directory; without git, or on any git error, that step
matches nothing. An entry whose installPath no longer exists is skipped, which is what happens
after a plugin update."""
import json
import os
import subprocess
import sys
from pathlib import Path

PLUGIN_ID = "knowledge@officina-claude"
# Set by git inside a hook; they would make `git -C <project>` look at the hook's repository.
_GIT_LOCATION_VARS = ("GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE")


def _resolved(value):
    try:
        return Path(value).resolve()
    except (OSError, TypeError, ValueError):
        return None


def _main_checkout(project):
    """The main checkout of `project` when it is a linked worktree, else None. None too when
    git is absent or fails, so the lookup falls back to its behaviour without this step."""
    env = {k: v for k, v in os.environ.items() if k not in _GIT_LOCATION_VARS}
    try:
        proc = subprocess.run(["git", "-C", str(project), "rev-parse", "--git-common-dir"],
                              capture_output=True, text=True, env=env, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    out = proc.stdout.strip()
    if proc.returncode != 0 or not out:
        return None
    common = _resolved(out if Path(out).is_absolute() else Path(project) / out)
    if common is None or common.name != ".git" or not common.is_dir():
        return None
    main = common.parent
    return None if main == _resolved(project) else main


def plugin_dir(project: Path):
    override = os.environ.get("KNOWLEDGE_PLUGIN_DIR")
    if override:
        if Path(override).is_dir():
            return Path(override)
        print(f"knowledge: KNOWLEDGE_PLUGIN_DIR={override} is not a directory", file=sys.stderr)
        return None
    config = os.environ.get("CLAUDE_CONFIG_DIR") or str(Path.home() / ".claude")
    try:
        data = json.loads((Path(config) / "plugins" / "installed_plugins.json")
                          .read_text(encoding="utf-8"))
        entries = data["plugins"][PLUGIN_ID]
        if not isinstance(entries, list):
            return None
    except (OSError, ValueError, KeyError, TypeError):
        return None
    here = _resolved(project)
    live = [e for e in entries if isinstance(e, dict) and isinstance(e.get("installPath"), str)
            and Path(e["installPath"]).is_dir()]
    scoped = [e for e in live if e.get("scope") in ("project", "local")]

    def for_project(path):
        for entry in scoped:
            theirs = _resolved(entry["projectPath"]) if entry.get("projectPath") else None
            if theirs is not None and theirs == path:
                return Path(entry["installPath"])
        return None

    found = for_project(here) if here is not None else None
    if found is None and scoped and here is not None:
        main = _main_checkout(here)
        found = for_project(main) if main is not None else None
    if found is not None:
        return found
    for entry in live:
        if entry.get("scope") == "user":
            return Path(entry["installPath"])
    return None


def main(argv):
    if len(argv) != 2:
        print("usage: locate.py <project>", file=sys.stderr)
        return 2
    found = plugin_dir(Path(argv[1]))
    if found is None:
        return 1
    print(found)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
