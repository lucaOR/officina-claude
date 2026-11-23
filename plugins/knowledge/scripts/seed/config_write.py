#!/usr/bin/env python3
"""Set `scribe.commit` in `.claude/knowledge/config.yaml` by editing the text, so comments and
other keys survive. Replaces an existing `commit:` value in place; else inserts it as the first
child of an existing `scribe:` block; else appends a `scribe:` block; creates the file when
absent. The result is read back through `lib.load_config`. A `scribe:` line with an inline
value (flow style, `scribe: {pathspecs: [...]}`) is refused with exit 1 and the file is left
alone: appending a second `scribe:` block would make PyYAML keep only the last one and drop
the first block's keys without a word.

CLI: config_write.py --root R --commit commit|stage"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import lib  # noqa: E402
import paths  # noqa: E402

TOP = re.compile(r"^\S")
SCRIBE = re.compile(r"^scribe:\s*(#.*)?$")
INLINE_SCRIBE = re.compile(r"^scribe:\s*[^\s#]")


class InlineScribe(ValueError):
    """The config holds `scribe:` with an inline value, which this editor cannot extend."""


def set_commit(text: str, value: str) -> str:
    lines = text.splitlines(keepends=True)
    if any(INLINE_SCRIBE.match(ln) for ln in lines):
        raise InlineScribe("scribe: has an inline value")
    start = next((i for i, ln in enumerate(lines) if SCRIBE.match(ln.rstrip("\n"))), None)
    if start is None:
        sep = "" if not text or text.endswith("\n") else "\n"
        return f"{text}{sep}scribe:\n  commit: {value}\n"
    end = len(lines)
    for i in range(start + 1, len(lines)):
        if lines[i].strip() and TOP.match(lines[i]) and not lines[i].startswith("#"):
            end = i
            break
    indent = None
    for i in range(start + 1, end):
        s = lines[i]
        if not s.strip() or s.lstrip().startswith("#"):
            continue
        cur = s[:len(s) - len(s.lstrip())]
        indent = indent if indent is not None else cur
        m = re.match(r"^(\s+commit:\s*)[^\s#]*(.*)$", s.rstrip("\n"))
        if cur == indent and m:
            lines[i] = f"{m.group(1)}{value}{m.group(2)}\n"
            return "".join(lines)
    new = f"{indent or '  '}commit: {value}\n"
    first = start + 1
    if lines[start].endswith("\n") is False:
        lines[start] += "\n"
    lines.insert(first, new)
    return "".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", default=None)
    ap.add_argument("--commit", required=True)
    args = ap.parse_args()
    if args.commit not in ("commit", "stage"):
        print("config_write: --commit must be commit or stage", file=sys.stderr)
        return 2
    root = paths.project_root(args.root)
    path = root / lib.CONFIG_REL
    old = path.read_text(encoding="utf-8") if path.is_file() else None
    try:
        new = set_commit(old or "", args.commit)
    except InlineScribe:
        print(f"config_write: {path} sets `scribe:` inline (flow style); rewrite it as a block "
              f"(`scribe:` on its own line, one key per indented line) and run again. "
              f"Nothing was changed.", file=sys.stderr)
        return 1
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(new, encoding="utf-8")
    ok = False
    try:
        lib.yaml.safe_load(path.read_text(encoding="utf-8"))
        ok = lib.load_config(root)["scribe"]["commit"] == args.commit
    except lib.yaml.YAMLError:
        pass
    if not ok:
        if old is None:
            path.unlink()
        else:
            path.write_text(old, encoding="utf-8")
        print("config_write: result did not read back; restored the original", file=sys.stderr)
        return 1
    print(json.dumps({"config": str(path), "scribe.commit": args.commit}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
