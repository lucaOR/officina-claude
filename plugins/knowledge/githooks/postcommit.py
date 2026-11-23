#!/usr/bin/env python3
"""post-commit hook body: append one ledger marker per committed file.

This runs AFTER the commit exists, so there is nothing left to block and every failure
mode here costs telemetry and nothing else. It therefore swallows everything and exits 0.

It does not run the check engine. The marker records that a commit landed on a given
parent and which files it touched; §4 of the design uses that as the positive evidence
behind `caught_at_edit`, which would otherwise be inferred from the absence of a
commit-phase row — indistinguishable from an edit that was abandoned, stashed or
reverted."""
import argparse
import subprocess
import sys
import uuid
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import ledger  # noqa: E402
import paths  # noqa: E402

# Kept identical to check-on-edit.py:13 on purpose: a marker for a suffix the edit hook
# never runs on can never pair with an edit-phase row.
CHECKABLE = {".php", ".yaml", ".yml", ".py", ".sh"}


def checkable(files: list) -> list:
    return [f for f in files if Path(f).suffix in CHECKABLE]


def _git(root: Path, *args):
    proc = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True)
    return proc.stdout.strip() if proc.returncode == 0 else ""


def main():
    try:
        ap = argparse.ArgumentParser()
        ap.add_argument("--root", default=None, help="project root that owns the ledger")
        explicit = ap.parse_known_args()[0].root
        project, service = (paths.project_root(explicit), None) if explicit \
            else paths.git_context()
        if not paths.has_knowledge(project):
            return
        root = Path(_git(Path.cwd(), "rev-parse", "--show-toplevel"))
        if not root.name:
            return
        head = _git(root, "rev-parse", "--short", "HEAD")
        # A root commit has no parent; there is no earlier HEAD for an edit to have been
        # judged against, so there is nothing a marker could pair with.
        parent = _git(root, "rev-parse", "--short", "HEAD^")
        if not head or not parent:
            return
        files = checkable(_git(root, "diff-tree", "--no-commit-id", "--name-only",
                               "-r", "-m", "--diff-filter=ACM", "HEAD").splitlines())
        rows = ledger.commit_rows(files, service or root.name,
                                  datetime.now().isoformat(timespec="seconds"),
                                  uuid.uuid4().hex[:8],
                                  _git(root, "rev-parse", "--abbrev-ref", "HEAD"),
                                  head, parent)
        ledger.append(paths.metrics_file(project, "kb-ledger.jsonl"), rows)
    except Exception:
        pass


if __name__ == "__main__":
    main()
