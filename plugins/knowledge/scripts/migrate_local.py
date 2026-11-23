#!/usr/bin/env python3
"""One-time move of a project's per-machine state into the self-ignoring local dir.

The legacy queue and metrics locations differ per project, so they are arguments.
Default is a dry run that lists the moves; --apply performs them. Sources that do not
exist are skipped. If any target already exists, nothing is moved and the exit is 1."""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

import paths

METRIC_NAMES = ("kb-ledger.jsonl", "kb-usage.jsonl", "kb-adjudications.jsonl",
                "skill-misses.jsonl", "kb-digest-rent.jsonl")


def plan(root: Path, queue_rel: str, metrics_rel: str) -> list[tuple[Path, Path]]:
    local = paths.local_dir(root, create=False)       # a dry run writes nothing
    pairs = [(root / queue_rel, local / "queue.md")]
    pairs += [(root / metrics_rel / n, local / "metrics" / n) for n in METRIC_NAMES]
    return [(src, dst) for src, dst in pairs if src.exists()]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", default=None)
    ap.add_argument("--queue", required=True, help="legacy queue file, relative to the root")
    ap.add_argument("--metrics-dir", required=True,
                    help="legacy metrics directory, relative to the root")
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args(argv)
    root = paths.project_root(a.root)
    moves = plan(root, a.queue, a.metrics_dir)
    clash = [dst for _, dst in moves if dst.exists()]
    if clash:
        for dst in clash:
            print(f"refusing: target exists: {dst}", file=sys.stderr)
        return 1
    if a.apply and moves:
        paths.local_dir(root)                         # the self-ignoring dir, before anything lands
    for src, dst in moves:
        print(f"{'move' if a.apply else 'would move'} {src} -> {dst}")
        if a.apply:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), str(dst))
    return 0


if __name__ == "__main__":
    sys.exit(main())
