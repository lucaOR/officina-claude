"""SessionStart rebuilds a scope's digest when its YAML changed, and only then."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HOOK = Path(__file__).resolve().parent / "inject-knowledge-digest.py"
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import build_digest  # noqa: E402
import lib  # noqa: E402
import testkit  # noqa: E402

RULE = """\
  - id: {id}
    title: Rule {id}
    rule: "Body of {id}."
"""
ROOT_YAML = "scope: project\ntopic: api\nrules:\n" + RULE.format(id="first-rule")
SVC_YAML = "scope: svc\ntopic: svc\nrules:\n" + RULE.format(id="svc-rule")
SVC_YAML_KEY = "svc/.claude/knowledge/svc.yaml"
KDIR = ".claude/knowledge"


def render(scope, project=None):
    """Render a scope the way the hook does: with the PROJECT's config."""
    return build_digest.render(lib.load_all([scope]), lib.load_config(project or scope))


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.local = base / "local"
        self.root = testkit.make_project(base, {"api.yaml": ROOT_YAML})
        self.digest = self.root / KDIR / "_digest.md"
        self.digest.write_text(render(self.root))
        self.hash_file = self.local / "sources.hash"

    def tearDown(self):
        self.tmp.cleanup()

    def session(self, source="startup"):
        env = dict(os.environ, CLAUDE_PROJECT_DIR=str(self.root),
                   KNOWLEDGE_LOCAL_DIR=str(self.local))
        proc = subprocess.run([sys.executable, str(HOOK)], env=env, capture_output=True,
                              text=True, timeout=60,
                              input=json.dumps({"hook_event_name": "SessionStart",
                                                "source": source, "session_id": "s"}))
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stderr, "")
        if not proc.stdout:
            return ""
        return json.loads(proc.stdout)["hookSpecificOutput"]["additionalContext"]

    def add_rule(self, path, rule_id):
        with path.open("a") as fh:
            fh.write(RULE.format(id=rule_id))

    def hashes(self):
        return json.loads(self.hash_file.read_text())


class TestRepair(Base):
    def test_rebuilt_when_sources_change(self):
        self.session()
        before = self.hashes()
        self.add_rule(self.root / KDIR / "api.yaml", "second-rule")
        injected = self.session()
        self.assertIn("second-rule", self.digest.read_text())
        self.assertEqual(self.digest.read_text(), render(self.root))
        self.assertIn("second-rule", injected)
        self.assertNotEqual(self.hashes()[KDIR], before[KDIR])

    def test_untouched_when_sources_same(self):
        self.session()
        stamp = self.digest.stat().st_mtime_ns
        hash_stamp = self.hash_file.stat().st_mtime_ns
        self.session()
        self.assertEqual(self.digest.stat().st_mtime_ns, stamp)
        self.assertEqual(self.hash_file.stat().st_mtime_ns, hash_stamp)

    def test_fresh_clone_same_content_not_rewritten(self):
        self.assertFalse(self.hash_file.exists())
        stamp = self.digest.stat().st_mtime_ns
        self.session()
        self.assertEqual(self.digest.stat().st_mtime_ns, stamp)
        self.assertEqual(list(self.hashes()), [KDIR])
        self.assertEqual(len(self.hashes()[KDIR]), 64)

    def test_unparseable_yaml_keeps_digest(self):
        self.session()
        committed = self.digest.read_bytes()
        before = self.hash_file.read_bytes()
        (self.root / KDIR / "broken.yaml").write_text("<<<<<<< HEAD\nscope: [\n")
        injected = self.session()
        self.assertEqual(self.digest.read_bytes(), committed)
        self.assertEqual(self.hash_file.read_bytes(), before)
        self.assertIn("first-rule", injected)
        self.assertEqual([p.name for p in (self.root / KDIR).iterdir()
                          if p.name.endswith(".tmp") or p.name.startswith(".")], [])

    def test_service_scope_rebuilt_independently(self):
        svc = self.root / SVC_YAML_KEY
        svc.parent.mkdir(parents=True)
        svc.write_text(SVC_YAML)
        svc_digest = svc.parent / "_digest.md"
        svc_digest.write_text(render(self.root / "svc", self.root))
        self.session()
        root_stamp = self.digest.stat().st_mtime_ns
        before = self.hashes()
        self.assertEqual(sorted(before), [KDIR, "svc/.claude/knowledge"])
        self.add_rule(svc, "svc-two")
        self.session()
        self.assertIn("svc-two", svc_digest.read_text())
        self.assertEqual(self.digest.stat().st_mtime_ns, root_stamp)
        after = self.hashes()
        self.assertEqual(after[KDIR], before[KDIR])
        self.assertNotEqual(after["svc/.claude/knowledge"], before["svc/.claude/knowledge"])

    def test_repair_keeps_a_readable_mode(self):
        # A devcontainer user with another uid must still read the digest after a repair.
        os.chmod(self.digest, 0o644)
        self.add_rule(self.root / KDIR / "api.yaml", "second-rule")
        self.session()
        self.assertIn("second-rule", self.digest.read_text())
        self.assertEqual(self.digest.stat().st_mode & 0o777, 0o644)
        self.assertEqual(self.hash_file.stat().st_mode & 0o777, 0o644)

    def test_repair_heals_a_0600_left_by_an_earlier_repair(self):
        # Earlier versions replaced the digest and sources.hash with mkstemp's 0600 file.
        self.session()
        os.chmod(self.digest, 0o600)
        os.chmod(self.hash_file, 0o600)
        self.add_rule(self.root / KDIR / "api.yaml", "second-rule")
        self.session()
        self.assertEqual(self.digest.stat().st_mode & 0o777, 0o644)
        self.assertEqual(self.hash_file.stat().st_mode & 0o777, 0o644)

    def test_one_odd_scope_does_not_stop_the_others(self):
        import importlib.util
        from unittest import mock
        spec = importlib.util.spec_from_file_location("inject_digest", HOOK)
        hook = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(hook)
        outside = Path(self.tmp.name) / "outside"
        (outside / KDIR).mkdir(parents=True)
        (outside / KDIR / "_digest.md").write_text("stale\n")
        self.add_rule(self.root / KDIR / "api.yaml", "second-rule")
        real = lib.scope_roots
        with mock.patch.dict(os.environ, {"KNOWLEDGE_LOCAL_DIR": str(self.local)}), \
                mock.patch.object(hook.lib, "scope_roots",
                                  side_effect=lambda root, cfg: [outside] + real(root, cfg)):
            hook.repair_digests(self.root, lib.load_config(self.root))
        self.assertIn("second-rule", self.digest.read_text())

    def test_scope_without_digest_is_left_alone(self):
        svc = self.root / SVC_YAML_KEY
        svc.parent.mkdir(parents=True)
        svc.write_text(SVC_YAML)
        self.session()
        self.assertFalse((svc.parent / "_digest.md").exists())
        self.assertEqual(list(self.hashes()), [KDIR])


BUILD = Path(__file__).resolve().parents[1] / "scripts" / "build_digest.py"
VALIDATE = Path(__file__).resolve().parents[1] / "scripts" / "validate.py"
TRAILER = "## distinctive\n- project trailer line\n"
SVC_RESIDENT = ("scope: svc\ntopic: svc\nrules:\n  - id: pinned\n    title: Pinned\n"
                "    resident: true\n    rule: Pinned body.\n" + RULE.format(id="other"))


class TestServiceDigestUsesProjectConfig(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.local = base / "local"
        self.root = testkit.make_superproject(base, ["svc"], {
            ".claude/knowledge/api.yaml": ROOT_YAML,
            ".claude/knowledge/config.yaml": "digest_trailer: |\n  ## distinctive\n"
                                             "  - project trailer line\n",
            SVC_YAML_KEY: SVC_RESIDENT})
        self.svc = self.root / "svc"
        self.digest = self.svc / KDIR / "_digest.md"
        self.env = dict(os.environ, CLAUDE_PROJECT_DIR=str(self.root),
                        KNOWLEDGE_LOCAL_DIR=str(self.local))

    def tearDown(self):
        self.tmp.cleanup()

    def cli(self, script, *args):
        return subprocess.run([sys.executable, str(script), *args], env=self.env,
                              capture_output=True, text=True, timeout=60)

    def test_cli_service_digest_ends_with_project_trailer(self):
        proc = self.cli(BUILD, "--root", str(self.svc))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue(self.digest.read_text().endswith(TRAILER))

    def test_session_start_after_cli_build_does_not_churn(self):
        self.cli(BUILD, "--root", str(self.root))
        self.cli(BUILD, "--root", str(self.svc))
        before = (self.digest.read_bytes(), self.digest.stat().st_mtime_ns)
        proc = subprocess.run(
            [sys.executable, str(HOOK)], env=self.env, capture_output=True, text=True,
            timeout=60, input=json.dumps({"source": "startup", "session_id": "s"}))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual((self.digest.read_bytes(), self.digest.stat().st_mtime_ns), before)

    def test_validate_reports_no_drift_for_the_service(self):
        self.cli(BUILD, "--root", str(self.root))
        self.cli(BUILD, "--root", str(self.svc))
        out = self.cli(VALIDATE, "--root", str(self.root)).stdout
        self.assertNotIn("digest_out_of_sync", out)


if __name__ == "__main__":
    unittest.main()
