#!/usr/bin/env python3
"""Generate _digest.md (slim one-line-per-rule index) from a scope's registries."""
from __future__ import annotations

import argparse
import os
from pathlib import Path

import lib
import paths

HEADER = ("<!-- GENERATED from .claude/knowledge/*.yaml by the knowledge plugin's "
          "build_digest.py — do not hand-edit. -->\n")


def rule_line(r: lib.Rule) -> str:
    marker = r.severity
    if r.override_policy == "binding":
        marker += ",binding"
    gist = " ".join((r.rule or r.title).split())
    if len(gist) > 90:
        gist = gist[:87] + "..."
    parts = [f"- [{marker}] {r.id} — {gist}"]
    if r.trigger:
        trig = " ".join(r.trigger.split())
        if len(trig) > 45:
            trig = trig[:42] + "..."
        parts.append(f"when: {trig}")
    if r.check:
        parts.append("check")
    return " · ".join(parts)


def render(rules: list, config: dict | None = None) -> str:
    """One line per rule, unless some rule is marked resident — then two tiers: resident
    rules keep their full line, the rest collapse to bare ids on an `also:` line, the
    epics topic is dropped, and the project's `digest_trailer` (config.yaml) is appended.

    The switch is the data rather than a caller flag so that validate.digest_drift can
    re-render any scope root without knowing which tier model that scope uses. A scope
    with no resident rule renders exactly as it did before this function was tiered."""
    tiered = any(r.resident for r in rules)
    by_topic: dict = {}
    for r in rules:
        if tiered and r.topic == "epics":
            continue
        by_topic.setdefault(r.topic, []).append(r)
    out = [HEADER]
    for topic in sorted(by_topic):
        group = sorted(by_topic[topic], key=lambda x: x.id)
        services = sorted({s for r in group for s in (r.applies_to.get("services") or [])})
        suffix = f"  ({', '.join(services)})" if services else ""
        out.append(f"\n## {topic}{suffix}")
        if not tiered:
            out.extend(rule_line(r) for r in group)
            continue
        out.extend(rule_line(r) for r in group if r.resident)
        collapsed = [r.id for r in group if not r.resident]
        if collapsed:
            out.append("- also: " + ", ".join(collapsed))
    text = "\n".join(out) + "\n"
    if not tiered:
        return text
    trailer = (config if config is not None else lib.CONFIG_DEFAULTS)["digest_trailer"]
    return text + "\n" + trailer


def _config_root(scope: Path) -> Path:
    """Where the config for `scope` lives. The SessionStart hook and validate render every
    scope with the project's config, so the CLI must too.

    1. The project ($CLAUDE_PROJECT_DIR or the cwd) when the scope lies inside it and it has a
       config.yaml. Containment is lexical, because a service's `.claude` may be a symlink.
    2. Otherwise the nearest directory with a config.yaml, walking up lexically from the scope
       itself. This covers a cwd outside the project, such as its parent directory, which
       would otherwise pass for the project and lend the scope its defaults.
    3. With no config.yaml anywhere: the project when it contains the scope, else the scope;
       either way the defaults apply."""
    project = paths.project_root()
    here = Path(os.path.abspath(scope))
    try:
        here.relative_to(os.path.abspath(project))
        inside = True
    except ValueError:
        inside = False
    if inside and (project / lib.CONFIG_REL).is_file():
        return project
    for directory in (here, *here.parents):
        if (directory / lib.CONFIG_REL).is_file():
            return directory
    return project if inside else scope


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", default=None, help="project root (default: resolved from $CLAUDE_PROJECT_DIR or the cwd)")
    lib.add_lease_arg(ap)
    a = ap.parse_args()
    root = paths.project_root(a.root)
    if paths.skip_without_knowledge(root, "build_digest"):
        return
    lib.touch_lease(root, a)
    rules = lib.load_all([root])
    digest = root / ".claude" / "knowledge" / "_digest.md"
    # UTF-8 and `\n` whatever the platform defaults: the SessionStart repair writes the same
    # rendered text as UTF-8 bytes, and the two writers must agree byte for byte.
    digest.write_text(render(rules, lib.load_config(_config_root(root))),
                      encoding="utf-8", newline="\n")
    print(f"wrote {digest} ({len(rules)} rules)")


if __name__ == "__main__":
    main()
