#!/usr/bin/env python3
"""Shared, process-safe queue for observations awaiting knowledge-base review.

Queue file: `queue.md` in the local state dir (`paths.local_dir`: self-ignoring, shared by
every worktree of the project). Lock file: `queue.lock` beside it, held via `filelock.exclusive`.

Line format: one JSON object per line (JSONL) — pick a concrete parseable format and document it,
per the design doc. Fields:
    id            str   unique, monotonic-ish: "<time.time_ns()>-<8 hex chars>"
    pusher        str   identity that called push()
    ts            str   ISO-8601 UTC timestamp of the push
    head_sha      str   `git rev-parse HEAD` at push time; "" without git or before the first commit
    text          str   the observation text
    artifact_refs list  free text: path:line / SHA / test-output path, etc.
    consumed      bool  false until mark_consumed() flips it
JSON-per-line is used (not pipe-delimited) because json.dumps escapes embedded newlines inside
`text`/`artifact_refs`, so one JSON object is always exactly one physical line — no risk of a
free-text field silently splitting a queue row across two lines. A line that does not parse as a
JSON object (a truncated write, a bad hand edit) is skipped by every reader, which reports how
many it skipped, and is kept byte for byte by mark_consumed's rewrite.

Repo-root resolution mirrors the convention in `.claude/scripts/pair/pair_resolve.py` and
`.claude/hooks/pair-brief.py`: every function takes the directory it needs as an explicit,
overridable parameter (there `pairs_dir=PAIRS_DIR`/`sessions_dir=SESSIONS_DIR`; here `root=None`),
so callers get a sane default and tests can inject a throwaway directory without monkeypatching
module globals. The default here is resolved via `git rev-parse --show-toplevel` from the current
working directory (git already walks up to find `.git` from any subdirectory), not a value baked
in at import time — that is what makes it correct across different clone roots.
"""
from __future__ import annotations

import json
import os
import secrets
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import filelock  # noqa: E402
import lib  # noqa: E402
import paths  # noqa: E402

QUEUE_NAME = "queue.md"
LOCK_NAME = "queue.lock"


class UnknownQueueIdError(LookupError):
    """Raised by mark_consumed() when the given id is not present in the queue file.

    A caller bug (id typo) must be loud, not swallowed as a silent no-op.
    """


def repo_root(start: Path | str | None = None) -> Path:
    """The project root (see paths.project_root): `start` when given, else
    $CLAUDE_PROJECT_DIR or the cwd, lifted to the superproject inside a submodule."""
    return paths.project_root(start)


def _resolve_root(root: Path | str | None) -> Path:
    return Path(root) if root is not None else repo_root()


def queue_file_path(root: Path | str | None = None) -> Path:
    return paths.local_dir(_resolve_root(root)) / QUEUE_NAME


def lock_file_path(root: Path | str | None = None) -> Path:
    return paths.local_dir(_resolve_root(root)) / LOCK_NAME


def _head_sha(root: Path) -> str:
    """HEAD at push time, or "" when there is none to record: a project without git, a
    repository with no commit yet, or no git binary at all."""
    try:
        proc = subprocess.run(["git", "-C", str(root), "rev-parse", "--verify", "-q", "HEAD"],
                              capture_output=True, text=True)
    except OSError:
        return ""
    return proc.stdout.strip() if proc.returncode == 0 else ""


def _default_pusher() -> str:
    return os.environ.get("USER") or os.environ.get("USERNAME") or "unknown"


def _new_id() -> str:
    return f"{time.time_ns()}-{secrets.token_hex(4)}"


def _normalize_artifact_refs(value) -> list:
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    return list(value)


def _locked(lock_file: Path):
    return filelock.exclusive(lock_file)


def push(text: str, pusher: str | None = None, artifact_refs=None,
          root: Path | str | None = None) -> str:
    """Append one observation to the queue. Creates the queue file if missing. Returns the new id."""
    root_dir = _resolve_root(root)
    queue_file = queue_file_path(root_dir)
    lock_file = lock_file_path(root_dir)
    queue_file.parent.mkdir(parents=True, exist_ok=True)

    record = {
        "id": _new_id(),
        "pusher": pusher or _default_pusher(),
        "ts": datetime.now(timezone.utc).isoformat(),
        "head_sha": _head_sha(root_dir),
        "text": text,
        "artifact_refs": _normalize_artifact_refs(artifact_refs),
        "consumed": False,
    }
    line = (json.dumps(record, sort_keys=True) + "\n").encode("utf-8")

    with _locked(lock_file):
        fd = os.open(str(queue_file), os.O_APPEND | os.O_CREAT | os.O_RDWR, 0o644)
        try:
            # A last line cut short (a crash, a hand edit) has no "\n"; without one the new
            # entry would be glued onto it and both would stop parsing. Checked under the lock.
            size = os.fstat(fd).st_size
            if size and os.pread(fd, 1, size - 1) != b"\n":
                line = b"\n" + line
            os.write(fd, line)
        finally:
            os.close(fd)

    return record["id"]


def _parse(line: str):
    """The queue row on `line`, or None when it is not a JSON object."""
    try:
        record = json.loads(line)
    except ValueError:
        return None
    return record if isinstance(record, dict) else None


def scan(root: Path | str | None = None) -> tuple[list[dict], int]:
    """(every row with consumed=false in file order, number of unparseable lines skipped).
    Blank lines are neither rows nor skipped lines."""
    queue_file = queue_file_path(root)
    if not queue_file.exists():
        return [], 0
    rows, skipped = [], 0
    with open(queue_file, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            record = _parse(line)
            if record is None:
                skipped += 1
            elif not record.get("consumed", False):
                rows.append(record)
    return rows, skipped


def _report_skipped(skipped: int, queue_file: Path) -> None:
    if skipped:
        print(f"kb_queue: skipped {skipped} unparseable line{'s' if skipped != 1 else ''} in "
              f"{queue_file}; they stay in the file untouched, fix or remove them by hand",
              file=sys.stderr)


def read_unconsumed(root: Path | str | None = None, *, lease: str | None = None) -> list[dict]:
    """Every row with consumed=false, in file order, skipping already-consumed rows. An
    unparseable line is skipped too, with one stderr line giving the count (see scan()).
    `lease` is the /kb run id: given, the call refreshes that run's lease."""
    lib.refresh_lease(_resolve_root(root), lease)
    rows, skipped = scan(root)
    _report_skipped(skipped, queue_file_path(root))
    return rows


def mark_consumed(id: str, root: Path | str | None = None, *, lease: str | None = None) -> None:
    """Read-modify-write under the queue lock; drops the row matching `id` from the file.

    A consumed row carries no further information once routed/memoried — nothing reads it
    back (see grep in SKILL.md history) — so mark_consumed removes it outright instead of
    flipping a `consumed` flag and leaving it to accumulate forever. Every other row, and
    every unparseable line, is left byte-for-byte unchanged. Raises UnknownQueueIdError if
    `id` is not present — never a silent no-op. `lease` is the /kb run id: given, the call
    refreshes that run's lease.
    """
    root_dir = _resolve_root(root)
    lib.refresh_lease(root_dir, lease)
    queue_file = queue_file_path(root_dir)
    lock_file = lock_file_path(root_dir)

    with _locked(lock_file):
        if not queue_file.exists():
            raise UnknownQueueIdError(id)

        with open(queue_file, "rb") as f:
            raw_lines = f.readlines()

        found = False
        skipped = 0
        new_lines = []
        for raw in raw_lines:
            stripped = raw.strip()
            if not stripped:
                new_lines.append(raw)
                continue
            record = _parse(stripped.decode("utf-8", errors="replace"))
            if record is None:
                skipped += 1
            elif record.get("id") == id:
                found = True
                continue  # drop the row instead of keeping a consumed=true tombstone
            new_lines.append(raw)  # byte-for-byte unchanged, an unparseable line included

        if not found:
            raise UnknownQueueIdError(id)

        # Write to a sibling tempfile and rename atomically — a plain `open(..., "w")` truncates
        # the file before writing, so a crash mid-write would lose every row, not just the one
        # being updated. os.replace() is atomic on the same filesystem (the local dir is never a mount
        # boundary here), so readers only ever see the fully-old or fully-new file.
        tmp_path = queue_file.with_suffix(queue_file.suffix + ".tmp")
        with open(tmp_path, "wb") as f:
            f.writelines(new_lines)
        os.replace(tmp_path, queue_file)
    _report_skipped(skipped, queue_file)
