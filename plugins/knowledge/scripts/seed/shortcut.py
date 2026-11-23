#!/usr/bin/env python3
"""Install the `ccscribe` shortcut: copy `templates/ccscribe` to `~/.local/bin/ccscribe` with
mode 755. Anything already there (even a broken symlink) is left alone: exit 1 naming it.
It writes to the user's home, so it takes no --root.

CLI: shortcut.py"""
from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

TEMPLATE = Path(__file__).resolve().parent.parent.parent / "templates" / "ccscribe"


def main() -> int:
    target = Path.home() / ".local" / "bin" / "ccscribe"
    if os.path.lexists(target):
        print(f"shortcut: {target} already exists; left untouched", file=sys.stderr)
        return 1
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(TEMPLATE, target)
    target.chmod(0o755)
    print(json.dumps({"installed": str(target)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
