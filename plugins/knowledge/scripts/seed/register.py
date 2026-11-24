#!/usr/bin/env python3
"""Register the plugin for teammates: write `enabledPlugins["knowledge@officina-claude"]` and the
marketplace source into `<root>/.claude/settings.json`. The marketplace entry is copied from
`<config dir>/plugins/known_marketplaces.json` (only its `source` object); without a known
marketplace only `enabledPlugins` is written and the output says so. Idempotent; every other
key is kept, and an existing `extraKnownMarketplaces["officina-claude"]` is left alone. A source
added from a local path (directory or file) is never copied, since it would leak a personal path
and break every other clone; the output notes it instead.

CLI: register.py --root R"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import paths  # noqa: E402
import sources  # noqa: E402

MARKETPLACE = "officina-claude"
PLUGIN_KEY = f"knowledge@{MARKETPLACE}"
REMOTE_SOURCES = ("github", "git", "url")


def known_source():
    try:
        data = json.loads((sources.config_dir() / "plugins" / "known_marketplaces.json")
                          .read_text(encoding="utf-8"))
        src = data[MARKETPLACE]["source"]
    except (OSError, ValueError, KeyError, TypeError):
        return None
    return src if isinstance(src, dict) else None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", default=None)
    args = ap.parse_args()
    path = paths.project_root(args.root) / ".claude" / "settings.json"
    settings = {}
    if path.is_file():
        try:
            settings = json.loads(path.read_text(encoding="utf-8"))
        except ValueError:
            print(f"register: {path} is not valid JSON; left untouched", file=sys.stderr)
            return 1
    settings.setdefault("enabledPlugins", {})[PLUGIN_KEY] = True
    src = known_source()
    local = src is not None and src.get("source") not in REMOTE_SOURCES
    if local:
        src = None
    if src is not None:
        markets = settings.setdefault("extraKnownMarketplaces", {})
        markets.setdefault(MARKETPLACE, {"source": src})
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")
    out = {"settings": str(path), "plugin": PLUGIN_KEY, "marketplace_registered": src is not None}
    if local:
        out["note"] = (f"marketplace {MARKETPLACE} was added from a local path, so it was not written "
                       "to the shared settings; teammates must add it themselves, or add it from GitHub "
                       "and run this again")
    elif src is None:
        out["note"] = f"no known marketplace {MARKETPLACE}; only enabledPlugins was added"
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
