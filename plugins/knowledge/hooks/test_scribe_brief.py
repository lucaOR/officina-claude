import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

HOOKS = Path(__file__).resolve().parent
sys.path.insert(0, str(HOOKS.parent / "scripts"))
sys.path.insert(0, str(HOOKS.parent / "scripts" / "kb"))

import kb_audit  # noqa: E402
import kb_lease  # noqa: E402
import kb_queue  # noqa: E402
import testkit  # noqa: E402

_spec = importlib.util.spec_from_file_location("scribe_brief", HOOKS / "scribe-brief.py")
sb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sb)

SCRIBE = {"hook_event_name": "SessionStart", "source": "startup", "session_id": "s1",
          "agent_type": "knowledge:scribe"}


class BriefTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.local = self.base / "local"
        self.project = testkit.make_project(
            self.base, {"r.yaml": "scope: project\ntopic: t\nrules: []\n"})
        patcher = mock.patch.dict(os.environ, {"KNOWLEDGE_LOCAL_DIR": str(self.local)})
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        self.tmp.cleanup()

    def run_hook(self, payload, env_file=None, role=None):
        env = {k: v for k, v in os.environ.items()
               if k not in ("CLAUDE_ROLE", "CLAUDE_ENV_FILE")}
        env["CLAUDE_PROJECT_DIR"] = str(self.project)
        if env_file:
            env["CLAUDE_ENV_FILE"] = str(env_file)
        if role:
            env["CLAUDE_ROLE"] = role
        proc = subprocess.run([sys.executable, str(HOOKS / "scribe-brief.py")],
                              input=json.dumps(payload), env=env, capture_output=True,
                              text=True, timeout=60)
        return proc.returncode, proc.stdout, proc.stderr

    def context(self, out):
        return json.loads(out)["hookSpecificOutput"]["additionalContext"]

    def test_non_scribe_silent(self):
        env_file = self.base / "env"
        plain = dict(SCRIBE, agent_type="other")
        self.assertEqual(self.run_hook(plain, env_file), (0, "", ""))
        self.assertEqual(self.run_hook({"session_id": "s1"}, env_file, role="worker"),
                         (0, "", ""))
        self.assertFalse(env_file.exists())

    def test_writes_knowledge_role_to_env_file(self):
        env_file = self.base / "env"
        env_file.write_text("EXISTING=1\n")
        for _ in range(2):                           # a /clear fires the hook again
            rc, out, err = self.run_hook(SCRIBE, env_file)
            self.assertEqual((rc, err), (0, ""))
        self.assertEqual(env_file.read_text(), "EXISTING=1\nexport KNOWLEDGE_ROLE=scribe\n")

    @unittest.skipUnless(shutil.which("bash"), "needs bash to source the env file")
    def test_role_reaches_processes_the_session_runs(self):
        # Claude Code sources $CLAUDE_ENV_FILE in the shell of each Bash command. A bare
        # assignment there is a shell variable only: `echo $KNOWLEDGE_ROLE` sees it, but
        # printenv, a python3 check or any script the scribe runs reads it as unset.
        env_file = self.base / "env"
        self.run_hook(SCRIBE, env_file)
        probe = [sys.executable, "-c", "import os; print(os.environ.get('KNOWLEDGE_ROLE'))"]
        env = {k: v for k, v in os.environ.items() if k != "KNOWLEDGE_ROLE"}
        proc = subprocess.run(["bash", "-c", 'source "$1" && exec "${@:2}"', "bash",
                               str(env_file), *probe],
                              env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual((proc.returncode, proc.stdout.strip()), (0, "scribe"), proc.stderr)

    def test_no_env_file_still_briefs(self):
        rc, out, err = self.run_hook(SCRIBE)
        self.assertEqual((rc, err), (0, ""))
        text = self.context(out)
        self.assertIn("KB SCRIBE SESSION", text)
        self.assertIn("/knowledge:kb run", text)
        self.assertNotIn("pid", text)
        rc, out, _ = self.run_hook({"session_id": "s1"}, role="scribe")
        self.assertIn("KB SCRIBE SESSION", self.context(out))

    def test_reports_queue_count_and_oldest_age(self):
        self.assertIn("Queue now: empty.", "\n".join(sb.brief_lines(self.project)))
        for text in ("one", "two"):
            kb_queue.push(text, root=self.project)
        later = datetime.now(timezone.utc) + timedelta(hours=3)
        lines = sb.brief_lines(self.project, now=later)
        self.assertIn("Queue now: 2 unconsumed row(s), oldest 3h old.", lines)

    def test_warns_when_fresh_lease_held(self):
        kb_lease.acquire(self.project, "other-session")
        rc, out, err = self.run_hook(SCRIBE)
        self.assertEqual((rc, err), (0, ""))
        self.assertIn("other-session", self.context(out))
        stale = datetime.now(timezone.utc) + timedelta(hours=2)
        self.assertNotIn("WARNING", "\n".join(sb.brief_lines(self.project, now=stale)))

    def test_brief_reports_sweep_due(self):
        text = "\n".join(sb.brief_lines(self.project))
        self.assertIn("never", text)
        self.assertIn("due", text)
        self.assertNotIn("not due", text)
        kb_audit.mark_full(self.project)
        self.assertIn("not due", "\n".join(sb.brief_lines(self.project)))

    def test_malformed_queue_line_keeps_role_and_lease_warning(self):
        kb_queue.push("one", root=self.project)
        with open(kb_queue.queue_file_path(self.project), "a", encoding="utf-8") as f:
            f.write('{"id": "truncated", "te\n')
        kb_lease.acquire(self.project, "other-session")
        rc, out, err = self.run_hook(SCRIBE)
        self.assertEqual((rc, err), (0, ""))
        text = self.context(out)
        self.assertIn("KB SCRIBE SESSION", text)
        self.assertIn("Queue now: 1 unconsumed row(s)", text)
        self.assertIn("1 unparseable line", text)
        self.assertIn("other-session", text)

    def test_unreadable_queue_keeps_role_and_lease_warning(self):
        kb_lease.acquire(self.project, "other-session")
        with mock.patch.object(kb_queue, "scan", side_effect=OSError("boom")):
            text = "\n".join(sb.brief_lines(self.project))
        self.assertIn("KB SCRIBE SESSION", text)
        self.assertIn("Queue now: unreadable", text)
        self.assertIn("other-session", text)

    def _driver(self, prelude):
        """Run the hook as __main__ in a fresh interpreter after `prelude`."""
        hook = str(HOOKS / "scribe-brief.py")
        code = f"import runpy, sys\n{prelude}\nrunpy.run_path({hook!r}, run_name='__main__')\n"
        env = {k: v for k, v in os.environ.items() if k not in ("CLAUDE_ROLE", "CLAUDE_ENV_FILE")}
        env["CLAUDE_PROJECT_DIR"] = str(self.project)
        return subprocess.run([sys.executable, "-c", code], input=json.dumps(SCRIBE), env=env,
                              capture_output=True, text=True, timeout=60)

    def test_engine_imports_wait_for_the_role_check(self):
        # Every session start in every project runs this hook; only a scribe session needs
        # the engine (kb_audit pulls in lib and YAML).
        hook = str(HOOKS / "scribe-brief.py")
        code = ("import importlib.util, sys\n"
                f"spec = importlib.util.spec_from_file_location('sb', {hook!r})\n"
                "spec.loader.exec_module(importlib.util.module_from_spec(spec))\n"
                "print(sorted(m for m in ('kb_audit', 'kb_lease', 'kb_queue', 'lib', 'yaml')"
                " if m in sys.modules))\n")
        proc = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True,
                              timeout=60)
        self.assertEqual((proc.returncode, proc.stdout.strip()), (0, "[]"), proc.stderr)

    def test_engine_import_error_fails_open(self):
        proc = self._driver("sys.modules['kb_audit'] = None")
        self.assertEqual((proc.returncode, proc.stdout, proc.stderr), (0, "", ""))

    def test_never_calls_os_kill(self):
        kb_lease.acquire(self.project, "other-session")
        with mock.patch.object(os, "kill", side_effect=AssertionError("os.kill called")):
            self.assertTrue(sb.brief_lines(self.project))


if __name__ == "__main__":
    unittest.main()
