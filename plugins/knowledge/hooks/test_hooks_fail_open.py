"""Every hook fails open and silent, and the pieces the plugin adds around them: the
namespaced dispatch text, the --root hand-off to the engine, the gate marker and root scope
read from config.yaml, and the hooks.json wiring."""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HOOKS = Path(__file__).resolve().parent
sys.path.insert(0, str(HOOKS.parent / "scripts"))

import testkit  # noqa: E402

HOOK_FILES = ("inject-knowledge-digest.py", "inject-rules-on-edit.py", "check-on-edit.py",
              "scribe-gate.py", "scribe-brief.py")

REGISTRY = """\
scope: project
topic: api
rules:
  - id: pinned-rule
    title: A resident rule
    resident: true
    applies_to:
      globs: ["app/**/*.php"]
    rule: "Already in the digest."
  - id: collapsed-rule
    title: A collapsed rule
    applies_to:
      globs: ["app/**/*.php"]
    rule: "Constrain the query to the owning company."
"""


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_")[:-3], HOOKS / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.state = self.base / "state"
        self.state.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def run_hook(self, name, stdin, project):
        env = dict(os.environ, CLAUDE_PROJECT_DIR=str(project),
                   KNOWLEDGE_LOCAL_DIR=str(self.state / "local"),
                   XDG_CACHE_HOME=str(self.state / "cache"))
        env.pop("RULE_INJECT_DISABLE", None)
        proc = subprocess.run([sys.executable, str(HOOKS / name)], input=stdin, env=env,
                              capture_output=True, text=True, timeout=60)
        return proc.returncode, proc.stdout, proc.stderr

    def payloads(self, project):
        edit = {"hook_event_name": "PreToolUse", "tool_name": "Edit", "session_id": "s1",
                "tool_input": {"file_path": str(project / "app" / "Foo.php")}}
        return {
            "inject-knowledge-digest.py": {"hook_event_name": "SessionStart",
                                           "source": "startup", "session_id": "s1"},
            "inject-rules-on-edit.py": edit,
            "check-on-edit.py": dict(edit, hook_event_name="PostToolUse"),
            "scribe-gate.py": {"hook_event_name": "UserPromptSubmit", "prompt": "/kb run",
                               "session_id": "s1"},
            "scribe-brief.py": {"hook_event_name": "SessionStart", "source": "startup",
                                "session_id": "s1", "agent_type": "knowledge:scribe"},
        }


class TestFailOpen(Base):
    def test_all_hooks_silent_without_kb(self):
        bare = self.base / "bare"
        bare.mkdir()
        for name, payload in self.payloads(bare).items():
            with self.subTest(hook=name):
                self.assertEqual(self.run_hook(name, json.dumps(payload), bare), (0, "", ""))

    def test_all_hooks_silent_on_bad_stdin(self):
        project = testkit.make_project(self.base, {"api.yaml": REGISTRY})
        bare = self.base / "bare"
        bare.mkdir()
        for where in (project, bare):
            for name in HOOK_FILES:
                with self.subTest(hook=name, project=where.name):
                    self.assertEqual(self.run_hook(name, "not json", where), (0, "", ""))

    def test_digest_hook_silent_without_digest_file(self):
        project = testkit.make_project(self.base, {"api.yaml": REGISTRY})
        self.assertFalse((project / ".claude" / "knowledge" / "_digest.md").exists())
        payload = json.dumps(self.payloads(project)["inject-knowledge-digest.py"])
        self.assertEqual(self.run_hook("inject-knowledge-digest.py", payload, project),
                         (0, "", ""))

    def test_dispatch_preamble_is_namespaced(self):
        project = testkit.make_project(self.base, {"api.yaml": REGISTRY})
        (project / ".claude" / "knowledge" / "_digest.md").write_text("## api\n- x\n")
        payload = json.dumps(self.payloads(project)["inject-knowledge-digest.py"])
        rc, out, err = self.run_hook("inject-knowledge-digest.py", payload, project)
        self.assertEqual((rc, err), (0, ""))
        text = json.loads(out)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("`knowledge:knowledge-check`", text)
        self.assertIn("`knowledge:knowledge-capture`", text)


class TestEngineHandoff(Base):
    def test_build_cmd_passes_root(self):
        coe = load("check-on-edit.py")
        cmd = coe.build_cmd("/e/check.py", "svc", "app/Foo.php", "/proj")
        self.assertEqual(cmd[1:], ["/e/check.py", "--checks-only", "--baseline", "HEAD",
                                   "--source", "hook", "--phase", "edit",
                                   "--root", "/proj", "--service", "svc", "app/Foo.php"])
        self.assertEqual(coe.build_cmd("/e/check.py", None, "x.py", Path("/proj"),
                                       python="py")[0], "py")

    def test_gate_marker_read_from_config(self):
        project = testkit.make_project(self.base, {"api.yaml": REGISTRY})
        svc = project / "svc"
        testkit.git(project, "init", "-q", str(svc))
        (svc / "app").mkdir()
        gate = Path(testkit.git(svc, "rev-parse", "--absolute-git-dir").strip()) / "hooks"
        gate.mkdir(parents=True, exist_ok=True)
        (gate / "pre-commit").write_text("#!/bin/sh\n# my custom gate\n")
        coe = load("check-on-edit.py")
        target = str(svc / "app" / "Foo.php")
        self.assertEqual(coe.resolve(target, project), (None, "svc/app/Foo.php"))
        (project / ".claude" / "knowledge" / "config.yaml").write_text(
            "gate_marker: my custom gate\n")
        self.assertEqual(coe.resolve(target, project), ("svc", "app/Foo.php"))


class TestRootScope(Base):
    def test_rules_hook_uses_root_scope(self):
        registry = REGISTRY.replace("scope: project", "scope: hub")
        project = testkit.make_project(self.base, {
            "api.yaml": registry, "config.yaml": "root_scope: hub\n"})
        (project / "svc" / ".claude" / "knowledge").mkdir(parents=True)
        (project / "svc" / "app").mkdir()
        payload = {"hook_event_name": "PreToolUse", "tool_name": "Edit", "session_id": "s1",
                   "tool_input": {"file_path": str(project / "svc" / "app" / "Foo.php")}}
        rc, out, err = self.run_hook("inject-rules-on-edit.py", json.dumps(payload), project)
        self.assertEqual((rc, err), (0, ""))
        text = json.loads(out)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("hub/api#collapsed-rule", text)

    def test_default_root_scope_does_not_see_other_names(self):
        registry = REGISTRY.replace("scope: project", "scope: hub")
        project = testkit.make_project(self.base, {"api.yaml": registry})
        payload = {"hook_event_name": "PreToolUse", "tool_name": "Edit", "session_id": "s1",
                   "tool_input": {"file_path": str(project / "app" / "Foo.php")}}
        self.assertEqual(self.run_hook("inject-rules-on-edit.py", json.dumps(payload),
                                       project), (0, "", ""))


class TestHooksJson(unittest.TestCase):
    def test_hooks_json_commands(self):
        data = json.loads((HOOKS / "hooks.json").read_text())["hooks"]
        wired = set()
        for event, entries in data.items():
            for entry in entries:
                for hook in entry["hooks"]:
                    cmd = hook["command"]
                    fname = cmd.split("/hooks/")[1].rstrip('"')
                    self.assertEqual(cmd, f'python3 "${{CLAUDE_PLUGIN_ROOT}}/hooks/{fname}"')
                    self.assertTrue((HOOKS / fname).is_file(), fname)
                    wired.add((fname, event, entry.get("matcher")))
        self.assertEqual(wired, {
            ("inject-knowledge-digest.py", "SessionStart", "startup|resume|clear|compact"),
            ("scribe-brief.py", "SessionStart", "startup|resume|clear|compact"),
            ("scribe-gate.py", "UserPromptSubmit", None),
            ("scribe-gate.py", "PreToolUse", "Skill"),
            ("inject-rules-on-edit.py", "PreToolUse", "Edit|Write|MultiEdit"),
            ("check-on-edit.py", "PostToolUse", "Edit|Write|MultiEdit"),
        })


if __name__ == "__main__":
    unittest.main()
