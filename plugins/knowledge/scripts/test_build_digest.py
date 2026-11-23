import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import lib
import build_digest
import testkit

REAL = os.environ.get("KNOWLEDGE_REAL_PROJECT")


def take_root(argv: list) -> tuple:
    """(project root, argv without it) for `--root <path>` or `--root=<path>`. Run as a
    script, the file accepts the project that way, as an alternative to
    $KNOWLEDGE_REAL_PROJECT, so the guard command knowledge-route step 5 runs starts with
    `python3` and matches a plain Bash(python3:*) allow rule."""
    rest, root, args = [], None, iter(argv)
    for arg in args:
        if arg == "--root":
            root = next(args, None)
        elif arg.startswith("--root="):
            root = arg[len("--root="):]
        else:
            rest.append(arg)
    return root, rest


class TestBuildDigest(unittest.TestCase):
    def _rule(self, **kw):
        base = dict(fqid="hub/static-analysis#x", scope="hub",
                    topic="static-analysis", id="x", title="t")
        base.update(kw)
        return lib.Rule(**base)

    def test_line_blocking_with_check(self):
        r = self._rule(id="s1142-return-count", severity="blocking",
                       rule="3 returns max; use match(true)", trigger="guard cascade",
                       check={"scope": "file", "shell": "x", "flag_when": "> 3"})
        line = build_digest.rule_line(r)
        self.assertTrue(line.startswith("- [blocking] s1142-return-count"))
        self.assertIn("when: guard cascade", line)
        self.assertIn("check", line)
        self.assertNotRegex(line, r"[\U0001F000-\U0001FAFF☀-➿]")  # no emoji

    def test_line_binding_marker_and_no_check(self):
        r = self._rule(id="scope-lookup", severity="blocking", override_policy="binding",
                       rule="scope lookups")
        line = build_digest.rule_line(r)
        self.assertTrue(line.startswith("- [blocking,binding] scope-lookup"))
        self.assertNotIn("check", line)

    def test_render_groups_by_topic_with_header(self):
        out = build_digest.render([self._rule(rule="a")])
        self.assertIn("## static-analysis", out)
        self.assertIn("GENERATED", out)

    def test_render_stays_flat_when_no_rule_is_resident(self):
        out = build_digest.render([self._rule(id="a", rule="first"),
                                   self._rule(id="b", rule="second")])
        self.assertIn("- [recommended] a", out)
        self.assertIn("- [recommended] b", out)
        self.assertNotIn("also:", out)
        self.assertNotIn("## lookup", out)

    def test_render_tiers_when_any_rule_is_resident(self):
        out = build_digest.render([
            self._rule(id="pinned", rule="stays in full", resident=True),
            self._rule(id="collapsed", rule="drops to an id")])
        self.assertIn("- [recommended] pinned", out)
        self.assertIn("stays in full", out)
        self.assertNotIn("drops to an id", out)
        self.assertIn("- also: collapsed", out)

    def test_tiered_render_appends_the_configured_trailer(self):
        cfg = {**lib.CONFIG_DEFAULTS, "digest_trailer": "## lookup\n- see _index.md\n"}
        out = build_digest.render([self._rule(id="pinned", rule="x", resident=True)], cfg)
        self.assertTrue(out.endswith("\n## lookup\n- see _index.md\n"))

    def test_tiered_render_drops_the_epics_topic(self):
        out = build_digest.render([
            self._rule(id="pinned", rule="x", resident=True),
            self._rule(fqid="hub/epics#bulk-import", topic="epics", id="bulk-import",
                       rule="the whole epic body", digest_only=True)])
        self.assertNotIn("the whole epic body", out)
        self.assertNotIn("also: bulk-import", out)
        self.assertNotIn("## epics", out)

    def test_collapsed_ids_are_comma_joined_in_id_order(self):
        out = build_digest.render([self._rule(id="pinned", rule="x", resident=True),
                                   self._rule(id="zeta"), self._rule(id="alpha")])
        self.assertIn("- also: alpha, zeta", out)

    def test_no_emoji_in_the_tiered_scaffolding(self):
        out = build_digest.render([self._rule(id="pinned", rule="x", resident=True),
                                   self._rule(id="collapsed")])
        self.assertNotRegex(out, r"[\U0001F000-\U0001FAFF☀-➿]")

    def test_rule_line_truncates_the_gist_and_the_trigger(self):
        # This truncation is what bounds RealRootGuards' per-line ceiling, and with it the cost of the
        # always-on prefix. Without it one verbose rule body would land in every session.
        r = self._rule(id="x", rule="w " * 200, trigger="t " * 200)
        gist, trig = build_digest.rule_line(r).split(" — ", 1)[1].split(" · when: ")
        # Lengths, not a total byte literal: a total would go vacuous the moment either
        # truncation is retuned, passing on slack instead of on the truncation firing.
        self.assertEqual(len(gist), 90)
        self.assertEqual(len(trig), 45)
        self.assertTrue(gist.endswith("...") and trig.endswith("..."))


class RealRootGuards(unittest.TestCase):
    """The digest guard that knowledge-route step 5 runs after a write
    (`python3 test_build_digest.py --root <project>`). It checks the real root digest of
    that project (or of $KNOWLEDGE_REAL_PROJECT) against the numbers it pins in the
    `digest_guard` key of its `.claude/knowledge/config.yaml` (`resident`, `max_bytes`). With
    no project, or no pin, each guard skips: the plugin cannot know another project's
    numbers, and a guard with made-up numbers would fail every project but one.

    Two guards, one per tier, because the tiers grow for different reasons and only one of
    them costs anything. A resident rule prints its full line into every session's always-on
    prefix (~200 B each). A non-resident rule adds only its bare id to an `also:` line
    (~35 B) and is otherwise delivered on demand by the on-edit injector.

    Between 2026-07-31 and 2026-08-26 a single total-byte pin stood in for both, and it was
    raised 28 times, 9216 -> 14430 B. Roughly 24 of those raises were `also:` drift from a
    /kb run — the cheap tier working exactly as designed — so the guard was firing on the
    growth it does not care about, and each firing cost a diagnosis plus a comment note.
    Split by tier instead:

      resident tier — pinned exactly by count (`digest_guard.resident`), plus a per-line
                      byte ceiling. It moves only when someone marks a rule resident, which
                      is the decision worth a review, and that is what these assertions
                      stop being silent.
      whole digest  — a loose backstop (`digest_guard.max_bytes`), NOT a budget. It catches
                      runaway growth (a scope root rendering flat, the epics pointer
                      dropping, a rule body pasted in whole), not one more collapsed id. Do
                      not re-cut it per /kb run; if it goes red, something structural broke.

    No note is owed for `also:` drift."""

    root = REAL

    def setUp(self):
        if not self.root:
            self.skipTest("pass --root <project>, or set KNOWLEDGE_REAL_PROJECT, to check a "
                          "project's real knowledge base")
        self.config = lib.load_config(Path(self.root))
        self.guard = self.config["digest_guard"] or {}

    def pinned(self, key):
        if key not in self.guard:
            self.skipTest(f"no digest_guard.{key} in {self.root}/.claude/knowledge/config.yaml; "
                          f"this guard is off for that project")
        return self.guard[key]

    def _real_root_rules(self):
        return lib.load_all([Path(self.root)])

    def test_real_root_resident_tier_is_pinned(self):
        expected = self.pinned("resident")
        resident = [r for r in self._real_root_rules() if r.resident]
        # Exact, not a bound. Residency is a deliberate call — the rule has to prescribe
        # an action that helps BEFORE an edit, which makes a post-edit reminder the wrong
        # delivery for it — and this count moving without that call is the regression the
        # guard exists for. When you do flip `resident:`, bump `digest_guard.resident` in
        # the same commit and say why in the commit message.
        self.assertEqual(
            len(resident), expected,
            f"resident tier moved (digest_guard.resident is {expected}): "
            + ", ".join(sorted(r.fqid for r in resident)))
        if not resident:
            return
        # A resident line's cost is bounded by construction — rule_line() truncates the
        # gist at 90 chars and the trigger at 45 — so the only unbounded input left is
        # the rule id. Assert the per-line ceiling rather than a total: a total would be
        # derived from the count above and could only ever restate it, while this catches
        # the one thing the count cannot see.
        widest = max(resident, key=lambda r: len(build_digest.rule_line(r).encode("utf-8")))
        width = len(build_digest.rule_line(widest).encode("utf-8"))
        self.assertLess(width, 256, f"resident line {width} B: {widest.fqid}")

    def test_real_root_digest_stays_under_the_backstop(self):
        ceiling = self.pinned("max_bytes")
        # Rendered with the project's config, as build_digest.py writes it, so the trailer
        # counts towards the size it really has.
        rendered = build_digest.render(self._real_root_rules(), self.config)
        total = len(rendered.encode("utf-8"))
        lines = rendered.splitlines()
        tier_bytes = lambda p: sum(len(l.encode("utf-8")) + 1 for l in lines if l.startswith(p))
        breakdown = (f"digest is {total} B against digest_guard.max_bytes {ceiling}: "
                     f"resident {tier_bytes('- [')} B, also {tier_bytes('- also: ')} B, "
                     f"scaffolding the rest")
        # A backstop, not the target. The target is the resident pin above plus cheap ids;
        # if this trips, read the breakdown before touching the number.
        self.assertLess(total, ceiling, breakdown)
        # Tiering itself is what makes the cheap tier cheap, so guard that it is still on:
        # collapsed ids on `also:` lines, and the project's trailer at the end.
        self.assertIn("- also: ", rendered)
        self.assertTrue(rendered.endswith(self.config["digest_trailer"]),
                        "the tiered digest lost the project's digest_trailer")


GUARDED = ("scope: project\ntopic: t\nrules:\n"
           "  - id: pinned\n    title: P\n    rule: stays in full\n    resident: true\n"
           "  - id: collapsed\n    title: C\n    rule: drops to an id\n")


class TestDigestGuardConfig(unittest.TestCase):
    """The real-root guards take their numbers from the project's `digest_guard` config key,
    so a project pins its own resident tier and backstop and every other project runs none."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.project = testkit.make_project(Path(tmp.name), {"r.yaml": GUARDED}, git=False)
        lib._config_warned = False
        self.addCleanup(setattr, lib, "_config_warned", False)

    def config(self, text):
        (self.project / ".claude" / "knowledge" / "config.yaml").write_text(text, encoding="utf-8")

    def run_guards(self):
        guards = type("Guards", (RealRootGuards,), {"root": str(self.project)})
        result = unittest.TestResult()
        unittest.defaultTestLoader.loadTestsFromTestCase(guards).run(result)
        self.assertEqual(result.errors, [])
        skipped = {t._testMethodName: why for t, why in result.skipped}
        failed = {t._testMethodName for t, _ in result.failures}
        return result.testsRun, skipped, failed

    def test_guards_skip_without_digest_guard(self):
        run, skipped, failed = self.run_guards()
        self.assertEqual(set(skipped), {"test_real_root_resident_tier_is_pinned",
                                        "test_real_root_digest_stays_under_the_backstop"})
        for why in skipped.values():
            self.assertIn("digest_guard", why)
        self.assertEqual(failed, set())

    def test_wrong_resident_count_fails(self):
        self.config("digest_guard: {resident: 2, max_bytes: 100000}\n")
        self.assertEqual(self.run_guards(), (2, {}, {"test_real_root_resident_tier_is_pinned"}))

    def test_digest_over_max_bytes_fails(self):
        self.config("digest_guard: {resident: 1, max_bytes: 50}\n")
        self.assertEqual(self.run_guards(),
                         (2, {}, {"test_real_root_digest_stays_under_the_backstop"}))

    def test_matching_guard_runs_and_passes(self):
        self.config("digest_guard: {resident: 1, max_bytes: 100000}\n")
        self.assertEqual(self.run_guards(), (2, {}, set()))

    def run_cli(self, *args):
        """The command knowledge-route step 5 runs: `python3 test_build_digest.py --root R`,
        here narrowed to the guard class so the run stays short."""
        env = {k: v for k, v in os.environ.items()
               if k not in ("KNOWLEDGE_REAL_PROJECT", "CLAUDE_PROJECT_DIR", "KNOWLEDGE_LOCAL_DIR")}
        return subprocess.run([sys.executable, str(Path(__file__).resolve()), *args,
                               "RealRootGuards"], cwd=str(self.project.parent), env=env,
                              capture_output=True, text=True, timeout=60)

    def test_root_argument_selects_the_project(self):
        self.config("digest_guard: {resident: 2, max_bytes: 100000}\n")
        for form in (("--root", str(self.project)), (f"--root={self.project}",)):
            with self.subTest(form=form):
                proc = self.run_cli(*form)
                self.assertEqual(proc.returncode, 1, proc.stderr)
                self.assertIn("FAIL: test_real_root_resident_tier_is_pinned", proc.stderr)
        self.config("digest_guard: {resident: 1, max_bytes: 100000}\n")
        proc = self.run_cli("--root", str(self.project))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertRegex(proc.stderr, r"Ran 2 tests.*\n\nOK\n")

    def test_root_argument_without_digest_guard_skips(self):
        proc = self.run_cli("--root", str(self.project))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("OK (skipped=2)", proc.stderr)



class TestCliWritesUtf8(unittest.TestCase):
    """The CLI writes the digest as UTF-8 with `\\n` newlines whatever the platform's
    defaults, so it agrees byte for byte with the SessionStart repair, which writes the
    rendered text's UTF-8 bytes. The header alone carries a non-ASCII dash."""

    def test_c_locale_writes_the_rendered_utf8_bytes(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        project = testkit.make_project(Path(tmp.name), {"r.yaml": GUARDED}, git=False)
        env = {k: v for k, v in os.environ.items()
               if k not in ("CLAUDE_PROJECT_DIR", "KNOWLEDGE_LOCAL_DIR", "LANG", "LANGUAGE")
               and not k.startswith("LC_")}
        env.update(LC_ALL="C", PYTHONUTF8="0", PYTHONCOERCECLOCALE="0")
        proc = subprocess.run([sys.executable, str(Path(__file__).resolve().parent / "build_digest.py"),
                               "--root", str(project)],
                              env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        written = (project / ".claude" / "knowledge" / "_digest.md").read_bytes()
        expected = build_digest.render(lib.load_all([project]), lib.load_config(project))
        self.assertEqual(written, expected.encode("utf-8"))
        self.assertNotIn(b"\r", written)


class TestConfigRootFromOutside(unittest.TestCase):
    """`build_digest.py --root <scope>` renders with the project's config even when the cwd
    is a directory outside the project that contains it, such as the project's parent. The
    tiered digest must keep the project's digest_trailer, for the root scope and for a
    service scope inside the project."""

    TRAILER = "## custom trailer\n- kept from the project's config.yaml\n"

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.outside = Path(tmp.name)
        self.project = testkit.make_project(self.outside, {
            "r.yaml": GUARDED,
            "config.yaml": "digest_trailer: |\n  ## custom trailer\n"
                           "  - kept from the project's config.yaml\n"})
        svc_kb = self.project / "svc" / ".claude" / "knowledge"
        svc_kb.mkdir(parents=True)
        (svc_kb / "s.yaml").write_text(GUARDED.replace("scope: project", "scope: svc"),
                                       encoding="utf-8")

    def build(self, scope):
        env = {k: v for k, v in os.environ.items()
               if k not in ("CLAUDE_PROJECT_DIR", "KNOWLEDGE_LOCAL_DIR")}
        proc = subprocess.run([sys.executable, str(Path(__file__).resolve().parent / "build_digest.py"),
                               "--root", str(scope)],
                              cwd=self.outside, env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual((proc.returncode, proc.stderr), (0, ""))
        return (scope / ".claude" / "knowledge" / "_digest.md").read_text(encoding="utf-8")

    def test_root_scope_keeps_the_project_trailer(self):
        self.assertTrue(self.build(self.project).endswith(self.TRAILER))

    def test_service_scope_keeps_the_project_trailer(self):
        self.assertTrue(self.build(self.project / "svc").endswith(self.TRAILER))


if __name__ == "__main__":
    _root, _argv = take_root(sys.argv[1:])
    if _root:
        RealRootGuards.root = _root
    unittest.main(argv=[sys.argv[0], *_argv])
