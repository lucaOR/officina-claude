#!/usr/bin/env python3
"""Retire a copied memory file: move it to `<memory dir>/.retired/<date>/` and drop the
`MEMORY.md` lines that link to it. Exit 1 with a message, changing nothing, when the file is
missing.

CLI: retire.py --root R --memory-file NAME [--date YYYY-MM-DD]"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import paths  # noqa: E402
import sources  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", default=None)
    ap.add_argument("--memory-file", required=True)
    ap.add_argument("--date", default=None)
    args = ap.parse_args()
    root = paths.project_root(args.root)
    mem = sources.memory_dir(root)
    name = args.memory_file
    src = mem / name if mem else None
    if src is None or Path(name).name != name or not src.is_file():
        print(f"retire: no memory file {name} in {mem}", file=sys.stderr)
        return 1
    dest_dir = mem / ".retired" / (args.date or date.today().isoformat())
    dest_dir.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dest_dir / name))
    index = mem / "MEMORY.md"
    removed = 0
    if index.is_file():
        lines = index.read_text(encoding="utf-8").splitlines(keepends=True)
        keep = [ln for ln in lines if f"]({name})" not in ln]
        removed = len(lines) - len(keep)
        index.write_text("".join(keep), encoding="utf-8")
    print(json.dumps({"retired": str(dest_dir / name), "index_lines_removed": removed}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
