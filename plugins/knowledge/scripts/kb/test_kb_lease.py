import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

import kb_lease  # noqa: E402
import testkit  # noqa: E402

T0 = datetime(2026, 11, 23, 10, 0, tzinfo=timezone.utc)
FIELDS = {"run_id", "session_id", "host", "started", "refreshed"}


class LeaseTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.root = testkit.make_project(self.base, {"r.yaml": "scope: project\ntopic: t\nrules: []\n"})
        self.env = dict(os.environ, KNOWLEDGE_LOCAL_DIR=str(self.base / "local"))
        os.environ["KNOWLEDGE_LOCAL_DIR"] = self.env["KNOWLEDGE_LOCAL_DIR"]
        self.addCleanup(lambda: os.environ.pop("KNOWLEDGE_LOCAL_DIR", None))

    def tearDown(self):
        self.tmp.cleanup()

    def lease_file(self):
        return self.base / "local" / "scribe-lease.json"

    def test_acquire_writes_all_fields(self):
        run_id, replaced = kb_lease.acquire(self.root, "s1", now=T0)
        self.assertIsNone(replaced)
        data = json.loads(self.lease_file().read_text())
        self.assertEqual(set(data), FIELDS)
        self.assertEqual((data["run_id"], data["session_id"]), (run_id, "s1"))
        self.assertEqual(data["started"], T0.isoformat())
        self.assertEqual(data["refreshed"], T0.isoformat())
        self.assertTrue(data["host"])

    def test_second_acquire_refused_while_fresh(self):
        kb_lease.acquire(self.root, "first", now=T0)
        with self.assertRaises(kb_lease.LeaseHeld) as ctx:
            kb_lease.acquire(self.root, "second", now=T0 + timedelta(minutes=59))
        self.assertEqual(ctx.exception.holder["session_id"], "first")

    def test_stale_lease_replaced_and_reported(self):
        old_id, _ = kb_lease.acquire(self.root, "first", now=T0)
        old = json.loads(self.lease_file().read_text())
        new_id, replaced = kb_lease.acquire(self.root, "second", now=T0 + timedelta(minutes=61))
        self.assertEqual(replaced, old)
        self.assertNotEqual(new_id, old_id)
        self.assertEqual(json.loads(self.lease_file().read_text())["session_id"], "second")

    def test_takeover_replaces_fresh_lease(self):
        kb_lease.acquire(self.root, "first", now=T0)
        run_id, replaced = kb_lease.acquire(self.root, "second", takeover=True, now=T0)
        self.assertEqual(replaced["session_id"], "first")
        self.assertEqual(json.loads(self.lease_file().read_text())["run_id"], run_id)

    def test_refresh_only_with_matching_run_id(self):
        run_id, _ = kb_lease.acquire(self.root, "s1", now=T0)
        before = self.lease_file().read_text()
        self.assertFalse(kb_lease.refresh(self.root, "other", now=T0 + timedelta(minutes=5)))
        self.assertEqual(self.lease_file().read_text(), before)
        self.assertTrue(kb_lease.refresh(self.root, run_id, now=T0 + timedelta(minutes=5)))
        self.assertEqual(json.loads(self.lease_file().read_text())["refreshed"],
                         (T0 + timedelta(minutes=5)).isoformat())
        self.assertTrue(kb_lease.status(self.root, now=T0 + timedelta(minutes=64))["fresh"])

    def test_release_only_own(self):
        run_id, _ = kb_lease.acquire(self.root, "s1", now=T0)
        kb_lease.release(self.root, "other")
        self.assertTrue(self.lease_file().exists())
        kb_lease.release(self.root, run_id)
        self.assertFalse(self.lease_file().exists())
        kb_lease.release(self.root, run_id)          # already gone: still a no-op

    def test_lease_minutes_from_config(self):
        (self.root / ".claude" / "knowledge" / "config.yaml").write_text(
            "scribe:\n  lease_minutes: 5\n")
        kb_lease.acquire(self.root, "first", now=T0)
        with self.assertRaises(kb_lease.LeaseHeld):
            kb_lease.acquire(self.root, "second", now=T0 + timedelta(minutes=4))
        _, replaced = kb_lease.acquire(self.root, "second", now=T0 + timedelta(minutes=6))
        self.assertEqual(replaced["session_id"], "first")

    def test_corrupt_lease_is_stale(self):
        self.lease_file().parent.mkdir(parents=True, exist_ok=True)
        self.lease_file().write_text("{")
        self.assertEqual(kb_lease.status(self.root, now=T0), {"corrupt": True, "fresh": False})
        run_id, replaced = kb_lease.acquire(self.root, "s1", now=T0)
        self.assertEqual(replaced, {"corrupt": True})
        self.assertEqual(json.loads(self.lease_file().read_text())["run_id"], run_id)

    def test_engine_flag_refreshes(self):
        run_id, _ = kb_lease.acquire(self.root, "s1", now=T0)
        script = HERE.parent / "build_digest.py"
        proc = subprocess.run([sys.executable, str(script), "--root", str(self.root),
                               "--lease", run_id], env=self.env, capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        refreshed = datetime.fromisoformat(json.loads(self.lease_file().read_text())["refreshed"])
        self.assertGreater(refreshed, T0)

    def test_engine_flag_never_fails_the_script(self):
        script = HERE.parent / "build_digest.py"
        for lease in ("no-such-run", ""):
            proc = subprocess.run([sys.executable, str(script), "--root", str(self.root),
                                   "--lease", lease], env=self.env, capture_output=True, text=True)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn("wrote", proc.stdout)
        self.assertFalse(self.lease_file().exists())

    def test_library_lease_keyword_refreshes(self):
        import kb_commit_guard
        import kb_queue
        run_id, _ = kb_lease.acquire(self.root, "s1", now=T0)
        for call in (lambda: kb_queue.read_unconsumed(self.root, lease=run_id),
                     lambda: kb_commit_guard.snapshot(self.root, [".claude/knowledge"],
                                                      lease=run_id)):
            self.lease_file().write_text(json.dumps(
                dict(json.loads(self.lease_file().read_text()), refreshed=T0.isoformat())))
            call()
            refreshed = json.loads(self.lease_file().read_text())["refreshed"]
            self.assertGreater(datetime.fromisoformat(refreshed), T0)
        before = self.lease_file().read_text()
        kb_queue.read_unconsumed(self.root)
        self.assertEqual(self.lease_file().read_text(), before)

    def test_cli_acquire_held_exits_3(self):
        cli = [sys.executable, str(HERE / "kb_lease.py"), "--root", str(self.root)]
        first = subprocess.run(cli + ["acquire", "--session", "a"], env=self.env,
                               capture_output=True, text=True)
        self.assertEqual(first.returncode, 0, first.stderr)
        second = subprocess.run(cli + ["acquire", "--session", "b"], env=self.env,
                                capture_output=True, text=True)
        self.assertEqual(second.returncode, 3)
        self.assertEqual(json.loads(second.stdout)["run_id"], first.stdout.strip())


if __name__ == "__main__":
    unittest.main()
