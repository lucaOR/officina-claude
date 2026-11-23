#!/usr/bin/env python3
"""Tests for the knowledge-digest injector. Plain stdlib unittest (no pytest on this host):
    python3 test_inject_knowledge_digest.py
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import build_digest  # noqa: E402
import lib  # noqa: E402
import testkit  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "inject_knowledge_digest", Path(__file__).with_name("inject-knowledge-digest.py"))
ikd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ikd)

HOOK = Path(__file__).with_name("inject-knowledge-digest.py")
DIGEST = "## api\n- [blocking] some-rule — a body long enough to notice\n"


def payload(source):
    return json.dumps({"hook_event_name": "SessionStart", "source": source,
                       "session_id": "abc123"})


class TestReadSource(unittest.TestCase):
    def test_reads_the_source_the_harness_sends(self):
        for source in ("startup", "resume", "clear", "compact"):
            self.assertEqual(ikd.read_source(payload(source)), source)

    def test_empty_stdin_falls_back_to_startup(self):
        # A manual run pipes nothing; serving the full digest is the safe direction.
        self.assertEqual(ikd.read_source(""), "startup")

    def test_malformed_json_falls_back_to_startup(self):
        self.assertEqual(ikd.read_source('{"source": "compact"'), "startup")

    def test_missing_and_non_string_source_fall_back_to_startup(self):
        self.assertEqual(ikd.read_source('{"hook_event_name": "SessionStart"}'), "startup")
        self.assertEqual(ikd.read_source('{"source": 7}'), "startup")
        self.assertEqual(ikd.read_source('{"source": null}'), "startup")

    def test_a_bare_json_scalar_falls_back_rather_than_raising(self):
        # json.loads("null") parses fine and then has no .get -- the AttributeError arm.
        self.assertEqual(ikd.read_source("null"), "startup")
        self.assertEqual(ikd.read_source('"compact"'), "startup")


class TestBuildContext(unittest.TestCase):
    def test_compact_omits_the_digest_body(self):
        out = ikd.build_context("compact", DIGEST)
        self.assertNotIn("some-rule", out)
        self.assertIn("NOT in this context", out)
        self.assertIn(".claude/knowledge/_digest.md", out)

    def test_compact_still_carries_the_dispatch_text(self):
        # The whole point of not suppressing outright: without this the model
        # reinvents a per-turn cadence, which costs more than the digest does.
        out = ikd.build_context("compact", DIGEST)
        self.assertIn("knowledge:knowledge-check", out)
        self.assertIn("knowledge:knowledge-capture", out)
        self.assertIn("ONE boundary", out)

    def test_resume_omits_the_digest_body_but_keeps_the_dispatch_text(self):
        # A resumed session replays the whole prior conversation, which is strictly richer than a
        # compaction summary; what it does NOT get back is the attachment, i.e. the dispatch text.
        out = ikd.build_context("resume", DIGEST)
        self.assertNotIn("some-rule", out)
        self.assertIn("NOT in this context", out)
        self.assertIn(".claude/knowledge/_digest.md", out)
        self.assertIn("knowledge:knowledge-check", out)
        self.assertIn("ONE boundary", out)

    def test_resume_explains_its_own_boundary_not_compaction(self):
        # The two slim shapes must not be collapsed into one: telling a resumed session that
        # "compaction discarded it" is a false account of why the index is missing.
        self.assertIn("not replayed", ikd.build_context("resume", DIGEST))
        self.assertIn("compaction discarded", ikd.build_context("compact", DIGEST))

    def test_every_other_source_carries_the_digest(self):
        for source in ("startup", "clear"):
            out = ikd.build_context(source, DIGEST)
            self.assertIn("some-rule", out)
            self.assertIn("rule index follows", out)
            self.assertNotIn("NOT in this context", out)

    def test_compact_is_much_smaller_than_a_full_injection(self):
        big = "x" * 12_000
        self.assertLess(len(ikd.build_context("compact", big)),
                        len(ikd.build_context("startup", big)) - 11_000)

    def test_both_shapes_stay_inside_the_importance_wrapper(self):
        for source in ("startup", "compact"):
            out = ikd.build_context(source, DIGEST)
            self.assertTrue(out.startswith("<EXTREMELY_IMPORTANT>\n"))
            self.assertTrue(out.endswith("\n</EXTREMELY_IMPORTANT>"))


class TestEndToEnd(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.local = base / "local"
        rules = "".join(f"  - id: rule-{n}\n    title: Rule {n}\n    rule: Body of rule {n}, long "
                        "enough to notice.\n" for n in range(40))
        self.root = testkit.make_project(
            base, {"api.yaml": "scope: project\ntopic: api\nrules:\n" + rules})
        self.digest_path = self.root / ".claude" / "knowledge" / "_digest.md"
        self.digest_path.write_text(build_digest.render(lib.load_all([self.root]),
                                                        lib.load_config(self.root)))

    def tearDown(self):
        self.tmp.cleanup()

    def run_hook(self, stdin_text):
        env = dict(os.environ, CLAUDE_PROJECT_DIR=str(self.root),
                   KNOWLEDGE_LOCAL_DIR=str(self.local))
        proc = subprocess.run([sys.executable, str(HOOK)], input=stdin_text, env=env,
                              capture_output=True, text=True, timeout=30)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return json.loads(proc.stdout)

    def test_emits_the_hookSpecificOutput_shape(self):
        out = self.run_hook(payload("startup"))["hookSpecificOutput"]
        self.assertEqual(out["hookEventName"], "SessionStart")
        self.assertIn("knowledge:knowledge-check", out["additionalContext"])

    def test_the_real_compact_payload_is_dispatch_text_plus_a_pointer_and_nothing_else(self):
        # Guards the wiring end of it: reads the project's digest file, not a constant. The
        # bound is derived from the two constants rather than a literal byte budget, so
        # editing either piece of prose cannot quietly turn this into a test that passes on
        # slack.
        cold = self.run_hook(payload("startup"))["hookSpecificOutput"]["additionalContext"]
        warm = self.run_hook(payload("compact"))["hookSpecificOutput"]["additionalContext"]
        self.assertLess(len(warm), len(cold))
        self.assertEqual(
            warm,
            "<EXTREMELY_IMPORTANT>\n" + ikd.DISPATCH + ikd.INDEX_ON_DEMAND
            + "\n</EXTREMELY_IMPORTANT>")
        saved = len(cold) - len(warm)
        self.assertGreater(saved, len(self.digest_path.read_text()) * 0.9,
                           "compact should shed essentially the whole digest")

    def test_the_real_resume_payload_is_dispatch_text_plus_a_pointer_and_nothing_else(self):
        # Same bound as compact, derived from the constants rather than a byte budget. Guards the
        # regression that matters: a resumed session must not silently start paying for the index
        # again just because someone edited the branch above it.
        cold = self.run_hook(payload("startup"))["hookSpecificOutput"]["additionalContext"]
        warm = self.run_hook(payload("resume"))["hookSpecificOutput"]["additionalContext"]
        self.assertEqual(
            warm,
            "<EXTREMELY_IMPORTANT>\n" + ikd.DISPATCH + ikd.INDEX_ON_DEMAND_RESUME
            + "\n</EXTREMELY_IMPORTANT>")
        self.assertGreater(len(cold) - len(warm), len(self.digest_path.read_text()) * 0.9,
                           "resume should shed essentially the whole digest")


if __name__ == "__main__":
    unittest.main(verbosity=2)
