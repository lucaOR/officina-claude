#!/usr/bin/env python3
"""The one place that takes an OS file lock, so no other script imports a POSIX-only
module. POSIX uses fcntl.flock; Windows uses msvcrt.locking on the first byte."""
from __future__ import annotations

import os
import sys
from contextlib import contextmanager
from pathlib import Path


class Busy(RuntimeError):
    """A non-blocking lock was requested and another holder has it."""


def _lock_posix(fd: int, blocking: bool) -> None:
    import fcntl
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
    except (BlockingIOError, PermissionError) as exc:
        raise Busy(str(exc)) from exc


def _unlock_posix(fd: int) -> None:
    import fcntl
    fcntl.flock(fd, fcntl.LOCK_UN)


def _lock_windows(fd: int, blocking: bool) -> None:
    import msvcrt
    try:
        msvcrt.locking(fd, msvcrt.LK_LOCK if blocking else msvcrt.LK_NBLCK, 1)
    except OSError as exc:
        raise Busy(str(exc)) from exc


def _unlock_windows(fd: int) -> None:
    import msvcrt
    msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)


@contextmanager
def exclusive(path: Path, blocking: bool = True):
    """Hold an exclusive lock on `path` (created when absent) for the with-block.
    Non-blocking and already held raises Busy."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    windows = sys.platform == "win32"
    fd = os.open(str(path), os.O_CREAT | os.O_RDWR, 0o644)
    try:
        (_lock_windows if windows else _lock_posix)(fd, blocking)
        try:
            yield
        finally:
            (_unlock_windows if windows else _unlock_posix)(fd)
    finally:
        os.close(fd)
