import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import filelock  # noqa: E402
import ledger  # noqa: E402
import lib  # noqa: E402
import testkit  # noqa: E402
import usage  # noqa: E402
import validate  # noqa: E402

_HOOK = Path(__file__).resolve().parent / "inject-rules-on-edit.py"
_spec = importlib.util.spec_from_file_location("inject_rules_on_edit", _HOOK)
ire = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ire)

REGISTRY = """\
scope: project
topic: api
rules:
  - id: pinned-rule
    title: A resident rule
    resident: true
    applies_to:
      globs: ["app/**/*.php"]
    rule: "Never injected, it is already in the digest."
  - id: collapsed-rule
    title: A collapsed rule
    applies_to:
      globs: ["app/**/*.php"]
    trigger: "editing a service class"
    rule: "Constrain the query to the owning company."
  - id: process-rule
    title: A digest-only rule
    digest_only: true
    rule: "Never reachable from a file edit."
  - id: elsewhere-rule
    title: A rule for other files
    applies_to:
      globs: ["config/*.php"]
    rule: "Not this file."
  - id: zzz-blocking-rule
    title: A blocking rule that sorts last alphabetically
    severity: blocking
    applies_to:
      globs: ["app/**/*.php"]
    rule: "Blocking rules must pack before recommended ones regardless of fqid order."
  - id: overridable-target
    title: A project default that a service scope may override
    applies_to:
      globs: ["app/**/*.php"]
    rule: "Default behavior a service can override without contaminating the shared default."
  - id: sweep-only-rule
    title: A judgment rule deferred to the review sweep
    sweep_only: true
    applies_to:
      globs: ["app/**/*.php"]
    rule: "Reminders wait for the sweep, but the body still guides the edit."
  - id: no-jit-rule
    title: A rule whose body does not help while writing
    sweep_only: true
    no_jit: true
    applies_to:
      globs: ["app/**/*.php"]
    rule: "Review-time only; never worth injecting before an edit."
"""

# Popped in setUp and restored in tearDown so a developer following the module docstring's
# own advice (RULE_INJECT_DISABLE=1, a tighter RULE_INJECT_BYTES) does not get a red suite,
# and so tests that deliberately set one of these do not bleed into the next test.
ENV_KEYS = ("RULE_INJECT_BYTES", "RULE_INJECT_DISABLE", "RULE_INJECT_FILE_BYTES",
            "RULE_INJECT_LOCK_WAIT", "KNOWLEDGE_LOCAL_DIR")


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.uc = Path(self.tmp.name)
        (self.uc / ".claude" / "knowledge").mkdir(parents=True)
        (self.uc / ".claude" / "knowledge" / "api.yaml").write_text(REGISTRY, encoding="utf-8")
        (self.uc / "svc" / ".claude" / "knowledge").mkdir(parents=True)
        (self.uc / "svc" / "app").mkdir()
        self.cache = self.uc / "cache"
        self.prev_cache = ire.CACHE
        ire.CACHE = self.cache
        self.prev_budget = ire.DEFAULT_BUDGET
        self.prev_env = {k: os.environ.pop(k, None) for k in ENV_KEYS}
        # on_edit's root parameter defaults to None and falls back to paths.project_root() at
        # call time, so main() -- which always calls on_edit(data) with no explicit root --
        # resolves against $CLAUDE_PROJECT_DIR. Point it at the fixture tree for the duration
        # of the test so main()-driven tests exercise it too.
        self.prev_project = os.environ.get("CLAUDE_PROJECT_DIR")
        os.environ["CLAUDE_PROJECT_DIR"] = str(self.uc)

    def tearDown(self):
        if self.prev_project is None:
            os.environ.pop("CLAUDE_PROJECT_DIR", None)
        else:
            os.environ["CLAUDE_PROJECT_DIR"] = self.prev_project
        ire.CACHE = self.prev_cache
        ire.DEFAULT_BUDGET = self.prev_budget
        for k, v in self.prev_env.items():
            if v is None:
                os.environ.pop(k, None)
                continue
            os.environ[k] = v
        self.tmp.cleanup()

    def fire(self, rel_in_service="app/Foo.php", session="s1", tool="Edit"):
        payload = {"hook_event_name": "PreToolUse", "tool_name": tool,
                   "session_id": session,
                   "tool_input": {"file_path": str(self.uc / "svc" / rel_in_service)}}
        out = io.StringIO()
        with redirect_stdout(out):
            ire.on_edit(payload, self.uc)
        text = out.getvalue()
        return json.loads(text)["hookSpecificOutput"]["additionalContext"] if text else ""


class TestResolve(Base):
    def test_service_file(self):
        self.assertEqual(ire.resolve(str(self.uc / "svc" / "app" / "Foo.php"), self.uc),
                         ("svc", "app/Foo.php"))

    def test_cross_service_file(self):
        (self.uc / ".claude" / "scripts").mkdir(parents=True, exist_ok=True)
        self.assertEqual(ire.resolve(str(self.uc / ".claude" / "scripts" / "x.py"), self.uc),
                         (None, ".claude/scripts/x.py"))

    def test_outside_tree_is_none(self):
        self.assertIsNone(ire.resolve("/etc/passwd", self.uc))

    def test_non_code_suffix_still_resolves(self):
        # Unlike check-on-edit.py, suffix does not gate here — globs do.
        self.assertEqual(ire.resolve(str(self.uc / "svc" / "app" / "notes.md"), self.uc),
                         ("svc", "app/notes.md"))


class TestInjection(Base):
    def test_matching_collapsed_rule_injects(self):
        text = self.fire()
        self.assertIn("collapsed-rule", text)
        self.assertIn("Constrain the query to the owning company.", text)
        self.assertIn("when: editing a service class", text)

    def test_resident_rule_never_injects(self):
        self.assertNotIn("pinned-rule", self.fire())

    def test_digest_only_rule_never_injects(self):
        self.assertNotIn("process-rule", self.fire())

    def test_sweep_only_rule_still_injects(self):
        """`sweep_only` defers the REMINDER to the review sweep; it must not also strip the
        rule's body from the pre-edit injection. Those are separate channels: the reminder
        line is noise on every commit, the body is authoring guidance delivered once per
        session. Conflating them was the 2026-08-17 regression — tagging a rule silently
        cost it the only edit-time exposure it had."""
        text = self.fire()
        self.assertIn("sweep-only-rule", text)
        self.assertIn("Reminders wait for the sweep, but the body still guides the edit.", text)

    def test_no_jit_rule_never_injects(self):
        """`no_jit` is the opt-out for the injection channel specifically — for a rule whose
        body cannot help while the code is being written (a comment-phrasing nit), only when
        it is being reviewed."""
        self.assertNotIn("no-jit-rule", self.fire())

    def test_non_matching_glob_never_injects(self):
        self.assertNotIn("elsewhere-rule", self.fire())

    def test_second_edit_in_the_same_session_injects_nothing(self):
        self.assertIn("collapsed-rule", self.fire())
        self.assertEqual(self.fire(), "")

    def test_a_new_session_injects_again(self):
        self.assertIn("collapsed-rule", self.fire(session="s1"))
        self.assertIn("collapsed-rule", self.fire(session="s2"))

    def test_budget_ceiling_suppresses_injection(self):
        ire.DEFAULT_BUDGET = 1
        self.assertEqual(self.fire(), "")

    def test_file_budget_ceiling_suppresses_injection(self):
        os.environ["RULE_INJECT_FILE_BYTES"] = "1"
        self.assertEqual(self.fire(), "")

    def test_missing_session_id_injects_nothing(self):
        payload = {"tool_input": {"file_path": str(self.uc / "svc" / "app" / "Foo.php")}}
        out = io.StringIO()
        with redirect_stdout(out):
            ire.on_edit(payload, self.uc)
        self.assertEqual(out.getvalue(), "")

    def test_tool_input_none_is_ignored(self):
        out = io.StringIO()
        with redirect_stdout(out):
            ire.on_edit({"tool_input": None, "session_id": "s1"}, self.uc)
        self.assertEqual(out.getvalue(), "")


class TestUntieredScopeStaysInert(unittest.TestCase):
    """Ruling A: a scope only carries collapsed text once build_digest.render() has tiered
    it, which happens exactly when some rule in that scope is resident. A scope with
    matching rules but no resident rule anywhere was never tiered, so matching() must
    return nothing for it -- exactly the pre-Task-6 state of the real knowledge base,
    where no rule anywhere is resident yet."""

    def test_no_resident_rule_anywhere_injects_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            uc = Path(tmp)
            (uc / ".claude" / "knowledge").mkdir(parents=True)
            (uc / ".claude" / "knowledge" / "api.yaml").write_text(
                "scope: project\n"
                "topic: api\n"
                "rules:\n"
                "  - id: never-resident\n"
                "    title: Nothing here is tiered\n"
                "    applies_to:\n"
                "      globs: [\"app/**/*.php\"]\n"
                "    rule: \"Would be collapsed once tiered, but nothing here is.\"\n",
                encoding="utf-8")
            self.assertEqual(ire.matching("app/Foo.php", None, uc), [])


def _layer(scope, topic, prefix, extra=""):
    """One tiered registry: a resident rule and two collapsed ones matching app/**/*.php."""
    return (f"scope: {scope}\ntopic: {topic}\nrules:\n"
            f"  - id: {prefix}-pinned\n    title: P\n    resident: true\n    rule: pinned\n"
            f"  - id: {prefix}-collapsed\n    title: C\n    rule: collapsed\n"
            f"    applies_to:\n      globs: [\"app/**/*.php\"]\n"
            f"  - id: {prefix}-other\n    title: O\n    rule: other\n"
            f"    applies_to:\n      globs: [\"app/**/*.php\"]\n{extra}")


class TestRootNarrowingEquivalence(unittest.TestCase):
    """matching() loads only [project root, the service's registry root] instead of every
    scope_roots() root. That is equivalent to loading everything only while every registry
    declares the scope of the root it lives under, which validate.py's scope_mismatch
    enforces. This fixture lays out a root scope with epics, a top-level service, and a
    service whose registry sits under a fallback directory, and compares matching() with a
    full-load reimplementation of its selection, kept here so the narrowed production code
    has something un-narrowed to be checked against."""

    CONFIG = {**lib.CONFIG_DEFAULTS, "root_scope": "hub",
              "extra_scopes": ["umbrella/libs/*"],
              "registry_fallbacks": ["umbrella/libs/{service}"]}
    REL = "app/Http/Controllers/AnyController.php"

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root_extra = ("  - id: svc-only\n    title: S\n    rule: for svc only\n"
                      "    applies_to:\n      services: [svc]\n      globs: [\"app/**\"]\n")
        self.root = testkit.make_project(Path(tmp.name), {
            "api.yaml": _layer("hub", "api", "root", root_extra),
            "epics/feature.yaml": "scope: hub\ntopic: epics\nrules:\n"
                                  "  - id: feature\n    title: F\n    rule: an epic\n"}, git=False)
        self.write("svc", _layer("svc", "domain", "svc",
                                 "  - id: svc-override\n    title: X\n    rule: replaces\n"
                                 "    overrides: [\"hub/api#root-other\"]\n"
                                 "    applies_to:\n      globs: [\"app/**\"]\n"))
        self.write("umbrella/libs/pages", _layer("pages", "pages", "pages"))

    def write(self, where, text, name="domain.yaml"):
        kdir = self.root / where / ".claude" / "knowledge"
        kdir.mkdir(parents=True, exist_ok=True)
        (kdir / name).write_text(text, encoding="utf-8")

    def full_load(self, service):
        rules = lib.load_all(lib.scope_roots(self.root, self.CONFIG))
        scoped = [r for r in rules if r.scope in (self.CONFIG["root_scope"], service)]
        effective, _ = lib.resolve_overrides(scoped, service)
        tiered = {r.scope for r in rules if r.resident}
        return sorted(r.fqid for r in effective
                      if r.scope in tiered and not r.resident and not r.no_jit
                      and lib.file_matches(r, self.REL, service, include_sweep_only=True))

    def narrowed(self, service):
        return sorted(r.fqid for r in ire.matching(self.REL, service, self.root, self.CONFIG))

    def test_invariant_holds_in_the_fixture(self):
        roots = lib.scope_roots(self.root, self.CONFIG)
        self.assertEqual(len(roots), 3)                   # root, svc, umbrella/libs/pages
        self.assertEqual(validate.scope_mismatches(roots, self.root, self.CONFIG), [])

    def test_each_scope_selects_identical_rules(self):
        for service in (None, "svc", "pages"):
            with self.subTest(service=service):
                expected = self.full_load(service)
                self.assertTrue(expected, "fixture is vacuous: no rule matched at all")
                self.assertEqual(self.narrowed(service), expected)
        self.assertIn("hub/api#root-other", self.full_load(None))
        self.assertNotIn("hub/api#root-other", self.full_load("svc"))   # overridden
        self.assertIn("hub/api#svc-only", self.full_load("svc"))
        self.assertNotIn("hub/api#svc-only", self.full_load("pages"))

    def test_a_mis_scoped_registry_breaks_it_and_validate_says_so(self):
        # A registry under svc/ that declares `pages`: a full load would hand its rules to a
        # pages edit, the narrowed hook never sees them. validate reports the cause.
        self.write("svc", _layer("pages", "extra", "stray"), name="extra.yaml")
        self.assertNotEqual(self.narrowed("pages"), self.full_load("pages"))
        found = validate.scope_mismatches(lib.scope_roots(self.root, self.CONFIG), self.root,
                                          self.CONFIG)
        self.assertEqual([m[:3] for m in found],
                         [("svc/.claude/knowledge/extra.yaml", "pages", "svc")])


class TestOverrideResolutionOrder(Base):
    """Round-2 finding 3: lib.resolve_overrides() must run on the full project+service
    set before the tiered-scope filter narrows it down, or an override edge declared in an
    untiered service scope silently stops suppressing its project target -- the
    overriding rule itself never injects (its own scope is untiered), but it must still
    count during override resolution."""

    def setUp(self):
        super().setUp()
        (self.uc / "svc" / ".claude" / "knowledge").mkdir(parents=True, exist_ok=True)
        (self.uc / "svc" / ".claude" / "knowledge" / "svc.yaml").write_text(
            "scope: svc\n"
            "topic: svc\n"
            "rules:\n"
            "  - id: svc-override\n"
            "    title: Suppresses the project target from an untiered service scope\n"
            "    overrides: [\"project/api#overridable-target\"]\n"
            "    rule: \"Overrides a shared default; this scope itself is never tiered.\"\n",
            encoding="utf-8")

    def test_override_from_untiered_service_scope_still_suppresses_its_target(self):
        ids = [r.id for r in ire.matching("app/Foo.php", "svc", self.uc)]
        self.assertNotIn("overridable-target", ids)
        self.assertNotIn("svc-override", ids)  # its own scope is untiered, never injects


class TestBody(Base):
    def test_body_shows_marker_fqid_and_title(self):
        rules = ire.matching("app/Foo.php", "svc", self.uc)
        rendered = "\n".join(ire.body(r) for r in rules)
        self.assertIn("[recommended] project/api#collapsed-rule — A collapsed rule", rendered)

    def test_blocking_rule_sorts_before_lower_severity_despite_fqid_order(self):
        rules = ire.matching("app/Foo.php", "svc", self.uc)
        ids = [r.id for r in rules]
        self.assertLess(ids.index("zzz-blocking-rule"), ids.index("collapsed-rule"))


class TestNeverDenies(Base):
    """The single most important invariant on a PreToolUse hook: it must never be able to
    deny the tool call, only add context to it."""

    def test_well_formed_payload_never_emits_a_deny(self):
        payload = {"hook_event_name": "PreToolUse", "tool_name": "Edit",
                   "session_id": "s-safety",
                   "tool_input": {"file_path": str(self.uc / "svc" / "app" / "Foo.php")}}
        out = io.StringIO()
        with redirect_stdout(out):
            ire.on_edit(payload, self.uc)
        raw = out.getvalue()
        self.assertNotEqual(raw, "")
        self.assertNotIn("permissionDecision", raw)
        self.assertNotIn("deny", raw)


class TestEnvKnobs(Base):
    def run_via_main(self, session):
        payload = json.dumps({
            "hook_event_name": "PreToolUse", "tool_name": "Edit", "session_id": session,
            "tool_input": {"file_path": str(self.uc / "svc" / "app" / "Foo.php")}})
        out = io.StringIO()
        prev_stdin, sys.stdin = sys.stdin, io.StringIO(payload)
        try:
            with redirect_stdout(out):
                ire.main()
        finally:
            sys.stdin = prev_stdin
        return out.getvalue()

    def test_disable_env_suppresses_injection(self):
        self.assertNotEqual(self.run_via_main("s-env-enabled"), "")
        os.environ["RULE_INJECT_DISABLE"] = "1"
        self.assertEqual(self.run_via_main("s-env-disabled"), "")

    def test_inject_bytes_env_overrides_default_budget(self):
        os.environ["RULE_INJECT_BYTES"] = "500"
        self.assertEqual(ire.budget(), 500)

    def test_inject_bytes_env_moves_the_ceiling(self):
        os.environ["RULE_INJECT_BYTES"] = "1"
        self.assertEqual(self.fire(), "")


class TestFileBudget(unittest.TestCase):
    """Round-2 finding 2: the per-file cap was a new production behaviour with no
    dedicated coverage at all -- the only grep hit for file_budget was ENV_KEYS."""

    def setUp(self):
        self.prev = os.environ.pop("RULE_INJECT_FILE_BYTES", None)

    def tearDown(self):
        if self.prev is None:
            os.environ.pop("RULE_INJECT_FILE_BYTES", None)
            return
        os.environ["RULE_INJECT_FILE_BYTES"] = self.prev

    def test_default_clamp(self):
        self.assertEqual(ire.file_budget(), ire.DEFAULT_FILE_BUDGET)

    def test_env_var_raises_the_cap(self):
        os.environ["RULE_INJECT_FILE_BYTES"] = "4096"
        self.assertEqual(ire.file_budget(), 4096)

    def test_non_positive_falls_back_to_default(self):
        os.environ["RULE_INJECT_FILE_BYTES"] = "0"
        self.assertEqual(ire.file_budget(), ire.DEFAULT_FILE_BUDGET)

    def test_non_numeric_falls_back_to_default(self):
        os.environ["RULE_INJECT_FILE_BYTES"] = "not-a-number"
        self.assertEqual(ire.file_budget(), ire.DEFAULT_FILE_BUDGET)


class TestSanitize(unittest.TestCase):
    """Round-2 finding 2 (sanitize coverage) and finding 4 (spent must degrade to zero on
    a non-numeric or otherwise uncoercible stored value, not raise)."""

    def test_negative_spent_floors_to_zero(self):
        _, spent = ire.sanitize({"spent": -999999})
        self.assertEqual(spent, 0)

    def test_non_numeric_spent_falls_back_to_zero(self):
        _, spent = ire.sanitize({"spent": "abc"})
        self.assertEqual(spent, 0)

    def test_dict_spent_falls_back_to_zero(self):
        _, spent = ire.sanitize({"spent": {"nested": True}})
        self.assertEqual(spent, 0)

    def test_injected_as_string_is_rejected(self):
        injected, _ = ire.sanitize({"injected": "abc"})
        self.assertEqual(injected, set())

    def test_injected_as_dict_is_rejected(self):
        injected, _ = ire.sanitize({"injected": {"a": 1, "b": 2}})
        self.assertEqual(injected, set())

    def test_injected_as_array_keeps_only_string_elements(self):
        injected, _ = ire.sanitize({"injected": [1, 2, "three"]})
        self.assertEqual(injected, {"three"})


class TestLockWaitTimeout(Base):
    """Round-2 finding 1: a lock held by someone else must time out, not hang the edit."""

    def test_held_lock_times_out_without_injecting(self):
        os.environ["RULE_INJECT_LOCK_WAIT"] = "0.2"
        path = ire.state_file("locked-out-session")
        lock_path = path.with_suffix(".lock")
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        with filelock.exclusive(lock_path):
            start = time.monotonic()
            text = self.fire(session="locked-out-session")
            elapsed = time.monotonic() - start
        self.assertEqual(text, "")
        self.assertGreaterEqual(elapsed, 0.2)
        self.assertLess(elapsed, 1.5)  # comfortably bounded; must not hang


_RACE_DRIVER_SOURCE = """\
import importlib.util
import json
import sys
from pathlib import Path

hook_path = Path(sys.argv[2])
_spec = importlib.util.spec_from_file_location("ire_race_driver", hook_path)
ire = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ire)

fixture_root = Path(sys.argv[1])
ire.CACHE = fixture_root / "cache"

data = json.load(sys.stdin)
ire.on_edit(data, fixture_root)
"""


class TestConcurrency(unittest.TestCase):
    """Round-2 finding 2: nothing else in the suite drives with_lock through genuine
    OS-level concurrency, so a future refactor could remove the lock entirely and the rest
    of the suite would stay green. This spawns real subprocesses -- the lock only
    serializes across processes, not just threads in one -- all sharing one session_id,
    each editing a distinct file, with every process's stdin written and closed before any
    of them is waited on, so they race for real."""

    N_FILES = 12

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / ".claude" / "knowledge").mkdir(parents=True)
        lines = [
            "scope: project", "topic: race", "rules:",
            "  - id: anchor-resident",
            "    title: Anchor rule that marks this scope tiered",
            "    resident: true",
            "    rule: \"Never injected -- exists only so the scope counts as tiered.\"",
        ]
        filler = "Padding sentence chosen to reach a realistic rule body size. " * 20
        for i in range(self.N_FILES):
            lines += [
                "  - id: rule-{}".format(i),
                "    title: Race rule {}".format(i),
                "    applies_to:",
                "      globs: [\"file{}.py\"]".format(i),
                "    rule: \"Race fixture filler for rule {}. {}\"".format(i, filler),
            ]
        (self.root / ".claude" / "knowledge" / "race.yaml").write_text(
            "\n".join(lines) + "\n", encoding="utf-8")
        self.driver = self.root / "driver.py"
        self.driver.write_text(_RACE_DRIVER_SOURCE, encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def test_concurrent_edits_stay_within_the_session_ceiling(self):
        procs = []
        for i in range(self.N_FILES):
            payload = json.dumps({
                "hook_event_name": "PreToolUse", "tool_name": "Edit",
                "session_id": "race-regression-session",
                "tool_input": {"file_path": str(self.root / "file{}.py".format(i))},
            })
            p = subprocess.Popen(
                [sys.executable, str(self.driver), str(self.root), str(_HOOK)],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True)
            p.stdin.write(payload)
            p.stdin.close()
            procs.append(p)
        # All N_FILES processes are now started and fed; only now do we read/wait on them.

        outputs = [(p.stdout.read(), p.stderr.read()) for p in procs]
        for p in procs:
            p.wait()
            p.stdout.close()
            p.stderr.close()

        total_rule_bytes = 0
        for out, err in outputs:
            self.assertEqual(err.strip(), "")
            if not out.strip():
                continue
            text = json.loads(out)["hookSpecificOutput"]["additionalContext"]
            # Only the rule bodies are budgeted; the per-call wrapper sentence is not.
            bodies = text.split(":\n\n", 1)[1]
            total_rule_bytes += len(bodies.encode("utf-8"))

        self.assertGreater(total_rule_bytes, 0)
        self.assertLessEqual(total_rule_bytes, ire.DEFAULT_BUDGET)


class TestFailOpen(unittest.TestCase):
    """Drives the hook the way Claude Code does: as a subprocess reading stdin, so the
    module-level try/except around main() is actually exercised. Calling on_edit() directly
    the way the other tests do sits below that guard and never tests it."""

    def run_hook(self, stdin_bytes):
        return subprocess.run([sys.executable, str(_HOOK)], input=stdin_bytes,
                               capture_output=True)

    def test_empty_stdin_fails_open(self):
        result = self.run_hook(b"")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b"")

    def test_non_json_bytes_fail_open(self):
        result = self.run_hook(b"not json at all {{{")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b"")

    def test_top_level_json_array_fails_open(self):
        result = self.run_hook(b"[1, 2, 3]")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b"")

    def test_dict_session_id_fails_open(self):
        payload = json.dumps({
            "hook_event_name": "PreToolUse", "tool_name": "Edit",
            "session_id": {"not": "a string"},
            "tool_input": {"file_path": str(Path(__file__).resolve())},
        }).encode("utf-8")
        result = self.run_hook(payload)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b"")


class TestDispatch(Base):
    """main() is what filters on tool name; on_edit itself is tool-agnostic."""

    def run_main(self, tool):
        payload = json.dumps({
            "hook_event_name": "PreToolUse", "tool_name": tool, "session_id": "s1",
            "tool_input": {"file_path": str(self.uc / "svc" / "app" / "Foo.php")}})
        seen, prev_on_edit = [], ire.on_edit
        ire.on_edit = lambda data: seen.append(data.get("tool_name"))
        prev_stdin, sys.stdin = sys.stdin, io.StringIO(payload)
        try:
            ire.main()
        finally:
            ire.on_edit = prev_on_edit
            sys.stdin = prev_stdin
        return seen

    def test_edit_write_and_multiedit_all_dispatch(self):
        for tool in ("Edit", "Write", "MultiEdit"):
            self.assertEqual(self.run_main(tool), [tool])

    def test_other_tools_are_ignored(self):
        self.assertEqual(self.run_main("Read"), [])


class TestUsageRecording(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.state = self.root / "state.json"
        self.prev = {k: os.environ.pop(k, None)
                     for k in ("CLAUDE_PROJECT_DIR", "KNOWLEDGE_LOCAL_DIR")}
        os.environ["CLAUDE_PROJECT_DIR"] = str(self.root)

    def tearDown(self):
        for k, v in self.prev.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self.tmp.cleanup()

    def _rule(self, rid):
        return lib.Rule(fqid=f"project/t#{rid}", scope="project", topic="t", id=rid,
                        title=f"Rule {rid}", rule="Do the thing.")

    def _rows(self):
        return ledger.load_ledger(usage.default_path(self.root))

    def test_delivered_rules_are_recorded(self):
        ire.build_injection(self.state, "app/A.php",
                            [self._rule("a"), self._rule("b")], 99999, session_id="s1")
        rows = self._rows()
        self.assertEqual({r["fqid"] for r in rows},
                         {"project/t#a", "project/t#b"})
        self.assertEqual({r["channel"] for r in rows}, {"jit_delivered"})
        self.assertEqual({r["session"] for r in rows}, {"s1"})

    def test_already_injected_rules_are_not_recorded_twice(self):
        # pick() skips a rule already injected this session, so it is not delivered a
        # second time and must not be counted a second time either.
        ire.build_injection(self.state, "app/A.php", [self._rule("a")], 99999,
                            session_id="s1")
        ire.build_injection(self.state, "app/B.php", [self._rule("a")], 99999,
                            session_id="s1")
        self.assertEqual(len(self._rows()), 1)

    def test_nothing_recorded_when_nothing_is_chosen(self):
        ire.build_injection(self.state, "app/A.php", [self._rule("a")], 0,
                            session_id="s1")
        self.assertEqual(self._rows(), [])

    def test_missing_session_id_still_injects(self):
        # The hook is fail-open by design. No session id means no usable usage row, and
        # that must degrade the telemetry, never the injection.
        text = ire.build_injection(self.state, "app/A.php", [self._rule("a")], 99999)
        self.assertIn("project/t#a", text)
        self.assertEqual(self._rows(), [])

    def test_usage_write_honors_an_explicit_root_over_the_project_dir(self):
        # build_injection() must write usage under the root a caller resolved for itself,
        # not the one $CLAUDE_PROJECT_DIR names (self.root here); other_root is a distinct
        # tree passed explicitly. A row under self.root would mean the argument was ignored.
        other_tmp = tempfile.TemporaryDirectory()
        self.addCleanup(other_tmp.cleanup)
        other_root = Path(other_tmp.name)
        self.assertNotEqual(other_root, self.root)

        ire.build_injection(self.state, "app/A.php", [self._rule("a")], 99999,
                            session_id="s1", root=other_root)

        self.assertEqual(self._rows(), [])
        other_rows = ledger.load_ledger(usage.default_path(other_root))
        self.assertEqual({r["fqid"] for r in other_rows}, {"project/t#a"})
        self.assertEqual({r["session"] for r in other_rows}, {"s1"})


class TestOnEditThreadsRootIntoUsageWrite(unittest.TestCase):
    """on_edit()'s with_lock lambda must forward its own resolved root into
    build_injection(), so the usage write lands under the root the caller of on_edit()
    supplied -- exactly the path a real caller drives, unlike TestUsageRecording above which
    calls build_injection() directly. self.decoy stands in for $CLAUDE_PROJECT_DIR;
    self.caller_root is the root on_edit() is explicitly given, the way TestConcurrency's
    subprocess driver passes a fixture root. A row under self.decoy would mean the root was
    dropped on the way."""

    def setUp(self):
        self.decoy_tmp = tempfile.TemporaryDirectory()
        self.caller_tmp = tempfile.TemporaryDirectory()
        self.decoy = Path(self.decoy_tmp.name)
        self.caller_root = Path(self.caller_tmp.name)
        (self.caller_root / ".claude" / "knowledge").mkdir(parents=True)
        (self.caller_root / ".claude" / "knowledge" / "api.yaml").write_text(
            REGISTRY, encoding="utf-8")
        (self.caller_root / "app").mkdir()
        self.prev_cache = ire.CACHE
        self.prev = {k: os.environ.pop(k, None)
                     for k in ("CLAUDE_PROJECT_DIR", "KNOWLEDGE_LOCAL_DIR")}
        os.environ["CLAUDE_PROJECT_DIR"] = str(self.decoy)
        ire.CACHE = self.caller_root / "cache"

    def tearDown(self):
        for k, v in self.prev.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        ire.CACHE = self.prev_cache
        self.decoy_tmp.cleanup()
        self.caller_tmp.cleanup()

    def test_usage_row_lands_under_caller_root_not_the_project_dir(self):
        payload = {"hook_event_name": "PreToolUse", "tool_name": "Edit",
                   "session_id": "caller-root-session",
                   "tool_input": {"file_path": str(self.caller_root / "app" / "Foo.php")}}
        out = io.StringIO()
        with redirect_stdout(out):
            ire.on_edit(payload, self.caller_root)
        self.assertTrue(out.getvalue(), "expected an injection so a usage row exists to check")

        caller_rows = ledger.load_ledger(usage.default_path(self.caller_root))
        self.assertEqual({r["session"] for r in caller_rows}, {"caller-root-session"})

        decoy_rows = ledger.load_ledger(usage.default_path(self.decoy))
        self.assertEqual(decoy_rows, [])


if __name__ == "__main__":
    unittest.main()
