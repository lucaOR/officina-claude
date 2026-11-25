#!/usr/bin/env python3
"""Tests for the shared KB queue I/O module. Plain stdlib unittest (no pytest on this host):
    python3 .claude/scripts/kb/test_kb_queue.py
or:
    python3 -m unittest .claude/scripts/kb/test_kb_queue.py

Every test runs against a throwaway `tempfile.mkdtemp()` git repo — nothing here ever touches the
real `docs/kb-queue.md`.
"""
import importlib.util
import io
import json
import multiprocessing
import os
import subprocess
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest import mock

_spec = importlib.util.spec_from_file_location(
    "kb_queue", Path(__file__).with_name("kb_queue.py"))
kq = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(kq)


def make_repo() -> Path:
    """A throwaway git repo with one commit, so HEAD-SHA capture has something to resolve."""
    root = Path(tempfile.mkdtemp())
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=root, check=True)
    (root / "README.md").write_text("init\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=root, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=root, check=True)
    return root


def _worker_push(root_str: str, idx: int) -> None:
    """Runs in a forked child process (module-level so it survives the fork/pickle boundary)."""
    kq.push(f"concurrent observation {idx}", pusher=f"worker-{idx}", root=root_str)


def _hold_lock(lock_path_str: str, hold_seconds: float, ready) -> None:
    """Runs in a forked child process: acquires the queue lock, signals ready, sleeps, releases."""
    import fcntl
    fd = os.open(lock_path_str, os.O_CREAT | os.O_RDWR, 0o644)
    fcntl.flock(fd, fcntl.LOCK_EX)
    ready.set()
    time.sleep(hold_seconds)
    fcntl.flock(fd, fcntl.LOCK_UN)
    os.close(fd)


class PushTest(unittest.TestCase):
    def test_push_creates_queue_file_and_writes_one_well_formed_line(self):
        root = make_repo()
        queue_file = kq.paths.local_dir(root) / "queue.md"
        self.assertFalse(queue_file.exists())

        record_id = kq.push("first observation", root=root)

        self.assertTrue(queue_file.exists())
        lines = queue_file.read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(lines), 1)
        record = json.loads(lines[0])
        self.assertEqual(record["id"], record_id)
        self.assertEqual(record["text"], "first observation")
        self.assertFalse(record["consumed"])
        self.assertTrue(record["head_sha"])
        self.assertTrue(record["pusher"])

    def test_two_sequential_pushes_produce_distinct_parseable_ids(self):
        root = make_repo()
        id1 = kq.push("obs one", root=root)
        id2 = kq.push("obs two", root=root)

        self.assertNotEqual(id1, id2)
        lines = (kq.paths.local_dir(root) / "queue.md").read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(lines), 2)
        parsed_ids = [json.loads(line)["id"] for line in lines]
        self.assertEqual(parsed_ids, [id1, id2])


class PushMetaTest(unittest.TestCase):
    def test_push_meta_roundtrip(self):
        root = make_repo()
        kq.push("t", meta={"source": "auto", "theme": "x"}, root=root)
        rec = kq.read_unconsumed(root)[0]
        self.assertEqual(rec["meta"], {"source": "auto", "theme": "x"})

    def test_push_without_meta_has_no_key(self):
        root = make_repo()
        kq.push("t", root=root)
        self.assertNotIn("meta", kq.read_unconsumed(root)[0])


class PushWithoutCommitTest(unittest.TestCase):
    """Spec Goal 2: a project without git, or a fresh repository with no commit yet, is a
    supported place to push from. There is no HEAD to record, so head_sha is empty."""

    def setUp(self):
        # Stop git from finding a repository that encloses the temp dir.
        self.base = Path(tempfile.mkdtemp())
        patcher = mock.patch.dict(os.environ, {"GIT_CEILING_DIRECTORIES": str(self.base)})
        patcher.start()
        self.addCleanup(patcher.stop)

    def _assert_one_row(self, root, record_id):
        lines = (kq.paths.local_dir(root) / "queue.md").read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(lines), 1)
        record = json.loads(lines[0])
        self.assertEqual(record["id"], record_id)
        self.assertEqual(record["head_sha"], "")
        self.assertEqual([r["id"] for r in kq.read_unconsumed(root=root)], [record_id])

    def test_push_without_git(self):
        root = self.base / "plain"
        root.mkdir()
        self._assert_one_row(root, kq.push("no git here", root=root))

    def test_push_in_a_repo_with_zero_commits(self):
        root = self.base / "fresh"
        root.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=root, check=True)
        self._assert_one_row(root, kq.push("no commit yet", root=root))


class MalformedLineTest(unittest.TestCase):
    """One unparseable queue line (a truncated write, a bad hand edit) must not stop a run:
    readers skip it and say how many they skipped, and a rewrite keeps it byte for byte."""

    BAD = b'{"id": "truncated", "text": "half a li\n'

    def _queue(self):
        root = make_repo()
        id1 = kq.push("a", root=root)
        queue_file = kq.paths.local_dir(root) / "queue.md"
        with open(queue_file, "ab") as f:
            f.write(self.BAD)
        id2 = kq.push("b", root=root)
        return root, queue_file, id1, id2

    def test_read_skips_and_reports_the_bad_line(self):
        root, _, id1, id2 = self._queue()
        err = io.StringIO()
        with redirect_stderr(err):
            rows = kq.read_unconsumed(root=root)
        self.assertEqual([r["id"] for r in rows], [id1, id2])
        self.assertIn("1 unparseable line", err.getvalue())

    def test_scan_counts_the_bad_line(self):
        root, _, id1, id2 = self._queue()
        rows, skipped = kq.scan(root=root)
        self.assertEqual(([r["id"] for r in rows], skipped), ([id1, id2], 1))

    def test_mark_consumed_keeps_the_bad_line_byte_for_byte(self):
        root, queue_file, id1, id2 = self._queue()
        with redirect_stderr(io.StringIO()):
            kq.mark_consumed(id1, root=root)
        after = queue_file.read_bytes().splitlines(keepends=True)
        self.assertEqual(after[0], self.BAD)
        self.assertEqual(json.loads(after[1])["id"], id2)


class TruncatedLastLineTest(unittest.TestCase):
    def test_push_after_a_last_line_without_newline_keeps_both_entries(self):
        root = make_repo()
        id1 = kq.push("a", root=root)
        queue_file = kq.paths.local_dir(root) / "queue.md"
        queue_file.write_bytes(queue_file.read_bytes().rstrip(b"\n"))
        id2 = kq.push("b", root=root)
        rows, skipped = kq.scan(root)
        self.assertEqual(skipped, 0)
        self.assertEqual([r["id"] for r in rows], [id1, id2])


class ConcurrencyTest(unittest.TestCase):
    def test_concurrent_pushes_from_real_processes_land_as_n_complete_lines(self):
        root = make_repo()
        n = 10
        procs = [multiprocessing.Process(target=_worker_push, args=(str(root), i))
                 for i in range(n)]
        for p in procs:
            p.start()
        for p in procs:
            p.join(timeout=30)
            self.assertEqual(p.exitcode, 0, "a pusher subprocess crashed")

        raw = (kq.paths.local_dir(root) / "queue.md").read_text(encoding="utf-8")
        lines = raw.splitlines()
        self.assertEqual(len(lines), n, "torn or interleaved writes: wrong line count")

        records = [json.loads(line) for line in lines]  # raises if any line is malformed/torn
        ids = [r["id"] for r in records]
        self.assertEqual(len(ids), len(set(ids)), "two pushes collided on id")


class ReadUnconsumedTest(unittest.TestCase):
    def test_skips_consumed_rows_in_file_order(self):
        root = make_repo()
        id1 = kq.push("a", root=root)
        id2 = kq.push("b", root=root)
        id3 = kq.push("c", root=root)
        kq.mark_consumed(id2, root=root)

        rows = kq.read_unconsumed(root=root)

        self.assertEqual([r["id"] for r in rows], [id1, id3])


class MarkConsumedTest(unittest.TestCase):
    def test_drops_its_own_row_other_rows_byte_for_byte_unchanged(self):
        root = make_repo()
        id1 = kq.push("a", root=root)
        id2 = kq.push("b", root=root)
        id3 = kq.push("c", root=root)
        queue_file = kq.paths.local_dir(root) / "queue.md"
        before = queue_file.read_bytes().splitlines(keepends=True)
        self.assertEqual(len(before), 3)

        kq.mark_consumed(id2, root=root)

        after = queue_file.read_bytes().splitlines(keepends=True)
        self.assertEqual(len(after), 2, "consumed row should be dropped, not tombstoned")
        self.assertEqual(before[0], after[0], "row 1 (untouched) changed")
        self.assertEqual(before[2], after[1], "row 3 (untouched) changed")
        self.assertEqual(json.loads(after[0])["id"], id1)
        self.assertEqual(json.loads(after[1])["id"], id3)

    def test_unknown_id_raises(self):
        root = make_repo()
        kq.push("a", root=root)

        with self.assertRaises(kq.UnknownQueueIdError):
            kq.mark_consumed("not-a-real-id", root=root)


class LockOrderingTest(unittest.TestCase):
    def test_push_blocks_until_a_concurrently_held_lock_is_released(self):
        root = make_repo()
        (root / "docs").mkdir(parents=True, exist_ok=True)
        lock_path = kq.paths.local_dir(root) / "queue.lock"

        hold_seconds = 1.2
        ready = multiprocessing.Event()
        holder = multiprocessing.Process(target=_hold_lock,
                                          args=(str(lock_path), hold_seconds, ready))
        holder.start()
        self.assertTrue(ready.wait(timeout=5), "lock-holding subprocess never signalled ready")

        result = {}
        def call_push():
            result["id"] = kq.push("blocked push", root=root)
            result["returned_at"] = time.monotonic()

        start = time.monotonic()
        t = threading.Thread(target=call_push)
        t.start()
        t.join(timeout=10)
        holder.join(timeout=10)

        self.assertIn("returned_at", result, "push() never returned")
        elapsed = result["returned_at"] - start
        self.assertGreaterEqual(
            elapsed, hold_seconds - 0.1,
            f"push() returned after {elapsed:.3f}s, before the {hold_seconds}s held lock was "
            f"released — it did not actually wait on the lock")


if __name__ == "__main__":
    unittest.main()
