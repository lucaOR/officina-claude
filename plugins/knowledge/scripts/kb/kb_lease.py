#!/usr/bin/env python3
"""The run lease: at most one `/knowledge:kb run` drains the queue at a time.

The lease is `scribe-lease.json` in the local state dir (`paths.local_dir`), holding
`run_id session_id host started refreshed`. A run takes it with `acquire`, every engine script
the run calls passes `--lease <run id>` so only that run keeps it fresh, and the run releases it
when it finishes. A lease whose `refreshed` is older than `scribe.lease_minutes` (default 60) is
stale and the next `acquire` replaces it. A missing, truncated or non-JSON lease file is stale
too. Pushes, git hooks and other sessions never touch the lease, so they cannot keep a dead run's
lease alive.

CLI:
    kb_lease.py acquire --session ID [--takeover]   prints the run id; exit 3 + holder JSON when held
    kb_lease.py refresh --lease ID
    kb_lease.py release --lease ID
    kb_lease.py status
"""
from __future__ import annotations

import argparse
import json
import os
import secrets
import socket
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import lib  # noqa: E402
import paths  # noqa: E402

LEASE_NAME = "scribe-lease.json"
CORRUPT = {"corrupt": True}


class LeaseHeld(Exception):
    """A fresh lease belongs to another run; `holder` is that lease."""

    def __init__(self, holder: dict):
        super().__init__(f"lease held by run {holder.get('run_id')}")
        self.holder = holder


def lease_path(root: Path) -> Path:
    return paths.local_dir(Path(root)) / LEASE_NAME


def _now(now: datetime | None) -> datetime:
    return now if now is not None else datetime.now(timezone.utc)


def _read(root: Path) -> dict | None:
    """The lease, None when absent, `CORRUPT` when unreadable."""
    try:
        text = lease_path(root).read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except OSError:
        return dict(CORRUPT)
    try:
        data = json.loads(text)
    except ValueError:
        return dict(CORRUPT)
    return data if isinstance(data, dict) else dict(CORRUPT)


def _write(root: Path, data: dict) -> None:
    path = lease_path(root)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(data, sort_keys=True), encoding="utf-8")
    os.replace(tmp, path)


def _fresh(root: Path, lease: dict | None, now: datetime) -> bool:
    if not lease or lease.get("corrupt"):
        return False
    try:
        refreshed = datetime.fromisoformat(lease["refreshed"])
        if refreshed.tzinfo is None:
            refreshed = refreshed.replace(tzinfo=timezone.utc)
    except (KeyError, TypeError, ValueError):
        return False
    minutes = lib.load_config(Path(root))["scribe"]["lease_minutes"]
    return now - refreshed <= timedelta(minutes=minutes)


def acquire(root: Path, session_id: str, *, takeover: bool = False,
            now: datetime | None = None) -> tuple[str, dict | None]:
    """Mint a run id and take the lease. Returns `(run_id, replaced_holder)`, where the holder
    is the stale or taken-over lease (or `{"corrupt": True}`), None when there was none. Raises
    LeaseHeld while another run's lease is fresh and `takeover` is false."""
    root = Path(root)
    moment = _now(now)
    existing = _read(root)
    if _fresh(root, existing, moment) and not takeover:
        raise LeaseHeld(existing)
    run_id = secrets.token_hex(8)
    stamp = moment.isoformat()
    _write(root, {"run_id": run_id, "session_id": session_id, "host": socket.gethostname(),
                  "started": stamp, "refreshed": stamp})
    return run_id, existing


def refresh(root: Path, run_id: str, now: datetime | None = None) -> bool:
    """Advance `refreshed` when `run_id` holds the lease; False, and no write, otherwise."""
    root = Path(root)
    lease = _read(root)
    if not lease or lease.get("run_id") != run_id:
        return False
    lease["refreshed"] = _now(now).isoformat()
    _write(root, lease)
    return True


def release(root: Path, run_id: str) -> None:
    """Delete the lease when `run_id` holds it; otherwise do nothing."""
    root = Path(root)
    lease = _read(root)
    if lease and lease.get("run_id") == run_id:
        try:
            lease_path(root).unlink()
        except FileNotFoundError:
            pass


def status(root: Path, now: datetime | None = None) -> dict | None:
    """The holder plus `fresh`, None when no lease file exists."""
    root = Path(root)
    lease = _read(root)
    if lease is None:
        return None
    return dict(lease, fresh=_fresh(root, lease, _now(now)))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", default=None,
                    help="project root (default: resolved from $CLAUDE_PROJECT_DIR or the cwd)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    acq = sub.add_parser("acquire")
    acq.add_argument("--session", required=True)
    acq.add_argument("--takeover", action="store_true")
    for name in ("refresh", "release"):
        sub.add_parser(name).add_argument("--lease", required=True)
    sub.add_parser("status")
    a = ap.parse_args(argv)
    root = paths.project_root(a.root)
    if a.cmd == "acquire":
        try:
            run_id, replaced = acquire(root, a.session, takeover=a.takeover)
        except LeaseHeld as held:
            print(json.dumps(held.holder, sort_keys=True))
            return 3
        if replaced:
            print(f"kb_lease: replaced {json.dumps(replaced, sort_keys=True)}", file=sys.stderr)
        print(run_id)
    elif a.cmd == "refresh":
        return 0 if refresh(root, a.lease) else 1
    elif a.cmd == "release":
        release(root, a.lease)
    else:
        print(json.dumps(status(root), sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
