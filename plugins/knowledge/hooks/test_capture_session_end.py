import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HOOKS = Path(__file__).resolve().parent
sys.path.insert(0, str(HOOKS.parent / "scripts"))

import testkit  # noqa: E402
from capture import run_capture  # noqa: E402

_spec = importlib.util.spec_from_file_location("capture_session_end",
                                               HOOKS / "capture-session-end.py")
hook = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hook)

PAYLOAD = {"hook_event_name": "SessionEnd", "session_id": "s1",
           "transcript_path": "/tmp/t.jsonl", "cwd": "/tmp"}


class CaptureSessionEndTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.root = testkit.make_project(
            self.base, {"r.yaml": "scope: project\ntopic: t\nrules: []\n"})
        env = {k: v for k, v in os.environ.items() if k != "KNOWLEDGE_EXTRACT"}
        env["CLAUDE_PROJECT_DIR"] = str(self.root)
        env["KNOWLEDGE_LOCAL_DIR"] = str(self.base / "local")
        patcher = mock.patch.dict(os.environ, env, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        self.tmp.cleanup()

    def write_config(self, mode):
        (self.root / ".claude" / "knowledge" / "config.yaml").write_text(
            f"scribe:\n  capture: {mode}\n")

    @staticmethod
    def spawned(popen):
        """Popen calls that start the runner (paths.py also shells out to git via Popen)."""
        return [c for c in popen.call_args_list
                if c.args and any(str(a).endswith("run_capture.py") for a in c.args[0])]

    def run_hook(self, payload):
        with mock.patch("sys.stdin", io.StringIO(json.dumps(payload))):
            hook.main()


class HookTest(CaptureSessionEndTest):
    def test_guard_env_exits_without_spawn(self):
        self.write_config("auto")
        with mock.patch.dict(os.environ, {"KNOWLEDGE_EXTRACT": "1"}), \
                mock.patch("subprocess.Popen") as popen:
            self.run_hook(PAYLOAD)
        self.assertEqual(self.spawned(popen), [])

    def test_default_config_does_not_spawn(self):
        with mock.patch("subprocess.Popen") as popen:
            self.run_hook(PAYLOAD)
        self.assertEqual(self.spawned(popen), [])

    def test_capture_off_does_not_spawn(self):
        self.write_config("off")
        with mock.patch("subprocess.Popen") as popen:
            self.run_hook(PAYLOAD)
        self.assertEqual(self.spawned(popen), [])

    def test_no_knowledge_base_does_not_spawn(self):
        bare = self.base / "bare"
        bare.mkdir()
        with mock.patch.dict(os.environ, {"CLAUDE_PROJECT_DIR": str(bare)}), \
                mock.patch("subprocess.Popen") as popen:
            self.run_hook(PAYLOAD)
        self.assertEqual(self.spawned(popen), [])

    def test_bad_stdin_is_silent(self):
        with mock.patch("sys.stdin", io.StringIO("not json")), \
                mock.patch("subprocess.Popen") as popen:
            hook.main()
        self.assertEqual(self.spawned(popen), [])

    def test_auto_spawns_detached(self):
        self.write_config("auto")
        with mock.patch("subprocess.Popen") as popen:
            self.run_hook(PAYLOAD)
        calls = self.spawned(popen)
        self.assertEqual(len(calls), 1)
        self.assertTrue(calls[0].kwargs["start_new_session"])
        cmd = calls[0].args[0]
        self.assertEqual(cmd[0], "python3")
        self.assertTrue(cmd[1].endswith("run_capture.py"))
        for flag, val in (("--session", "s1"), ("--transcript", "/tmp/t.jsonl"),
                          ("--mode", "auto")):
            self.assertEqual(cmd[cmd.index(flag) + 1], val)
        self.assertIn("--root", cmd)

    def test_popen_failure_never_raises(self):
        self.write_config("transcript")
        with mock.patch("subprocess.Popen", side_effect=OSError("boom")):
            self.run_hook(PAYLOAD)


class RunCaptureTest(CaptureSessionEndTest):
    def test_runner_failure_never_raises(self):
        self.assertEqual(run_capture.main(
            ["--session", "s", "--transcript", "/nope", "--root", str(self.root)]), 0)

    def test_pipeline_enqueues_and_passes_vocab(self):
        rows = [{"statement": "Always use X", "quote": "q" * 12, "kind": "rule",
                 "scope_guess": "project", "theme": "t"}]
        with mock.patch.object(run_capture, "extract", return_value=rows) as ext, \
                mock.patch.object(run_capture, "enqueue", return_value=1) as enq:
            rc = run_capture.main(["--session", "s", "--transcript", "/nope",
                                   "--root", str(self.root), "--mode", "transcript"])
        self.assertEqual(rc, 0)
        ext.assert_called_once()
        self.assertIsInstance(ext.call_args.args[1], list)
        self.assertEqual(enq.call_args.args[0], rows)
        self.assertEqual(enq.call_args.args[1], "s")

    def test_exception_is_logged(self):
        with mock.patch.object(run_capture, "extract", side_effect=RuntimeError("bad")):
            rc = run_capture.main(["--session", "s", "--transcript", "/nope",
                                   "--root", str(self.root)])
        self.assertEqual(rc, 0)
        log = self.base / "local" / "capture.log"
        self.assertIn("bad", log.read_text())


if __name__ == "__main__":
    unittest.main()
