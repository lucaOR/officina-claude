import os
import tempfile, unittest
from pathlib import Path
import lib
import validate

SAT = {**lib.CONFIG_DEFAULTS, "root_scope": "hub", "extra_scopes": ["umbrella/libs/*"],
       "probe_roots": [{"registry": "umbrella/libs/*", "tree": "checkouts/{name}"}]}
MONO = {**lib.CONFIG_DEFAULTS, "root_scope": "hub"}

REAL = os.environ.get("KNOWLEDGE_REAL_PROJECT")
needs_real = unittest.skipUnless(REAL, "set KNOWLEDGE_REAL_PROJECT to a project with a real knowledge base")
needs_hook = unittest.skipUnless(validate._hook_module(), "hooks/inject-rules-on-edit.py arrives with the hooks")


def write_registry(root: Path, rel: str, text: str) -> None:
    p = root / ".claude" / "knowledge" / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)


class TestDigestDrift(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        write_registry(self.root, "t.yaml",
                       "scope: hub\ntopic: t\nrules:\n  - id: a\n    title: A rule\n")

    def tearDown(self):
        self.tmp.cleanup()

    def _digest(self):
        return self.root / ".claude" / "knowledge" / "_digest.md"

    def test_in_sync_no_drift(self):
        import build_digest
        self._digest().write_text(build_digest.render(lib.load_all([self.root])))
        self.assertEqual(validate.digest_drift([self.root]), [])

    def test_stale_digest_is_drift(self):
        self._digest().write_text("stale content\n")
        self.assertEqual(len(validate.digest_drift([self.root])), 1)

    def test_missing_digest_is_skipped(self):
        self.assertEqual(validate.digest_drift([self.root]), [])


class TestValidate(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def _load(self):
        return lib.load_all([self.root])

    def test_dangling_edge_is_error(self):
        write_registry(self.root, "api.yaml",
            "scope: hub\ntopic: api\nrules:\n  - id: a\n    title: t\n"
            "    see_also: [hub/api#ghost]\n")
        self.assertIn(("dangling_edge", "hub/api#a", "hub/api#ghost"),
                      validate.check_edges(self._load()))

    def test_override_of_binding_is_error(self):
        write_registry(self.root, "api.yaml",
            "scope: hub\ntopic: api\nrules:\n  - id: b\n    title: t\n    override_policy: binding\n")
        write_registry(self.root, "svc-api.yaml",
            "scope: sso\ntopic: api\nrules:\n  - id: x\n    title: y\n    overrides: [hub/api#b]\n")
        self.assertIn(("override_of_binding", "sso/api#x", "hub/api#b"),
                      validate.check_edges(self._load()))

    def test_duplicate_fqid_is_error(self):
        write_registry(self.root, "api.yaml",
            "scope: hub\ntopic: api\nrules:\n  - id: dup\n    title: one\n")
        write_registry(self.root, "api2.yaml",
            "scope: hub\ntopic: api\nrules:\n  - id: dup\n    title: two\n")
        kinds = [e[0] for e in validate.check_edges(self._load())]
        self.assertIn("duplicate_fqid", kinds)

    def test_double_override_same_scope_is_error(self):
        write_registry(self.root, "api.yaml",
            "scope: hub\ntopic: api\nrules:\n  - id: base\n    title: t\n")
        write_registry(self.root, "svc-api.yaml",
            "scope: sso\ntopic: api\nrules:\n"
            "  - id: x\n    title: y\n    overrides: [hub/api#base]\n"
            "  - id: z\n    title: w\n    overrides: [hub/api#base]\n")
        kinds = [e[0] for e in validate.check_edges(self._load())]
        self.assertIn("double_override_same_scope", kinds)

    def test_unlinked_overlapping_same_topic_is_candidate(self):
        write_registry(self.root, "api.yaml",
            "scope: hub\ntopic: api\nrules:\n"
            "  - id: a\n    title: t\n    applies_to:\n      services: [catalog-api]\n"
            "  - id: b\n    title: u\n    applies_to:\n      services: [catalog-api]\n")
        self.assertEqual(validate.candidate_clusters(self._load()),
                         [["hub/api#a", "hub/api#b"]])

    def test_linked_pair_is_not_candidate(self):
        write_registry(self.root, "api.yaml",
            "scope: hub\ntopic: api\nrules:\n"
            "  - id: a\n    title: t\n    applies_to:\n      services: [catalog-api]\n"
            "    see_also: [hub/api#b]\n"
            "  - id: b\n    title: u\n    applies_to:\n      services: [catalog-api]\n")
        self.assertEqual(validate.candidate_clusters(self._load()), [])

    def test_disjoint_services_not_candidate(self):
        write_registry(self.root, "api.yaml",
            "scope: hub\ntopic: api\nrules:\n"
            "  - id: a\n    title: t\n    applies_to:\n      services: [catalog-api]\n"
            "  - id: b\n    title: u\n    applies_to:\n      services: [billing-api]\n")
        self.assertEqual(validate.candidate_clusters(self._load()), [])

    def test_fan_out_zombie_when_all_services_override(self):
        write_registry(self.root, "api.yaml",
            "scope: hub\ntopic: api\nrules:\n  - id: base\n    title: t\n"
            "    applies_to:\n      services: [catalog-api, billing-api]\n")
        write_registry(self.root, "catalog.yaml",
            "scope: catalog-api\ntopic: api\nrules:\n  - id: o1\n    title: y\n"
            "    overrides: [hub/api#base]\n")
        write_registry(self.root, "billing.yaml",
            "scope: billing-api\ntopic: api\nrules:\n  - id: o2\n    title: y\n"
            "    overrides: [hub/api#base]\n")
        fo = {f[0]: f for f in validate.fan_out(self._load(), config=MONO)}
        self.assertEqual(fo["hub/api#base"][2], "zombie_default")

    def test_fan_out_healthy_when_partial(self):
        write_registry(self.root, "api.yaml",
            "scope: hub\ntopic: api\nrules:\n  - id: base\n    title: t\n"
            "    applies_to:\n      services: [catalog-api, billing-api]\n")
        write_registry(self.root, "catalog.yaml",
            "scope: catalog-api\ntopic: api\nrules:\n  - id: o1\n    title: y\n"
            "    overrides: [hub/api#base]\n")
        fo = {f[0]: f for f in validate.fan_out(self._load(), config=MONO)}
        self.assertEqual(fo["hub/api#base"][2], "healthy")

    def test_validate_omits_none_fan_out_entries(self):
        # a hub rule nobody overrides -> status 'none' -> excluded from validate()'s fan_out
        write_registry(self.root, "api.yaml",
            "scope: hub\ntopic: api\nrules:\n  - id: base\n    title: t\n"
            "    applies_to:\n      services: [catalog-api, billing-api]\n")
        report = validate.validate(self._load())
        self.assertEqual(report["fan_out"], [])

    def test_focus_narrows_candidate_clusters(self):
        # two independent clusters across two topics; focus returns only the one containing the fqid
        write_registry(self.root, "api.yaml",
            "scope: hub\ntopic: api\nrules:\n"
            "  - id: a\n    title: t\n    applies_to:\n      services: [catalog-api]\n"
            "  - id: b\n    title: u\n    applies_to:\n      services: [catalog-api]\n")
        write_registry(self.root, "testing.yaml",
            "scope: hub\ntopic: testing\nrules:\n"
            "  - id: c\n    title: t\n    applies_to:\n      services: [catalog-api]\n"
            "  - id: d\n    title: u\n    applies_to:\n      services: [catalog-api]\n")
        rules = self._load()
        self.assertEqual(len(validate.candidate_clusters(rules)), 2)  # both clusters unfocused
        self.assertEqual(validate.candidate_clusters(rules, focus="hub/api#a"),
                         [["hub/api#a", "hub/api#b"]])


class TestRealGraph(unittest.TestCase):
    """Guards the actual on-disk knowledge graph. The synthetic-tree tests above
    prove the linter's logic; this proves the real graph is clean — catches dangling
    edges, duplicate FQIDs, and illegal overrides that hand-edits slip past."""

    @needs_real
    def test_real_graph_has_no_referential_errors(self):
        rules = lib.load_all(validate._default_roots(REAL))
        errors = validate.check_edges(rules)
        self.assertEqual(errors, [], f"knowledge graph has referential errors: {errors}")


class TestIdOnlyRules(unittest.TestCase):
    def _rule(self, **kw):
        base = dict(fqid="hub/architecture#x", scope="hub",
                    topic="architecture", id="x", title="t")
        base.update(kw)
        return lib.Rule(**base)

    def _pinned(self, scope="hub", topic="architecture"):
        """A resident rule in the same scope. render() only tiers a scope that has one,
        so without this the fixture's scope is flat and nothing in it is collapsed."""
        return lib.Rule(fqid=f"{scope}/{topic}#pinned", scope=scope, topic=topic,
                        id="pinned", title="t", resident=True)

    def test_digest_only_and_collapsed_and_uncheckable_is_flagged(self):
        r = self._rule(id="explainer", fqid="hub/architecture#explainer",
                       digest_only=True)
        self.assertEqual(validate.id_only_rules([r, self._pinned()]),
                         ["hub/architecture#explainer"])

    def test_resident_rule_is_not_flagged(self):
        r = self._rule(digest_only=True, resident=True)
        self.assertEqual(validate.id_only_rules([r]), [])

    def test_checked_rule_is_not_flagged(self):
        # the resident sibling makes this scope tiered, so the assertion turns on
        # `not r.check` rather than on the scope gate.
        r = self._rule(digest_only=True, check={"scope": "file", "shell": "x", "flag_when": "> 0"})
        self.assertEqual(validate.id_only_rules([r, self._pinned()]), [])

    def test_jit_reachable_rule_is_not_flagged(self):
        # Not digest_only, so the on-edit injector can still deliver it in full. The
        # resident sibling makes this scope tiered, so the assertion turns on
        # `r.digest_only` rather than on the scope gate.
        r = self._rule(applies_to={"globs": ["app/**/*.php"]})
        self.assertEqual(validate.id_only_rules([r, self._pinned()]), [])

    def test_no_jit_rule_is_flagged(self):
        # `no_jit` reaches the same end state `digest_only` does — collapsed in the digest,
        # never injected before an edit, no mechanical check — so it belongs to the same
        # advisory. Gating only on `digest_only` would under-report the moment a rule opts
        # out of the injection channel instead of being excluded from per-file matching.
        r = self._rule(id="nit", fqid="hub/architecture#nit", no_jit=True,
                       applies_to={"globs": ["app/**/*.php"]})
        self.assertEqual(validate.id_only_rules([r, self._pinned()]),
                         ["hub/architecture#nit"])

    def test_no_jit_rule_with_a_check_is_not_flagged(self):
        r = self._rule(no_jit=True, applies_to={"globs": ["app/**/*.php"]},
                       check={"scope": "file", "shell": "x", "flag_when": "> 0"})
        self.assertEqual(validate.id_only_rules([r, self._pinned()]), [])

    def test_sweep_only_alone_is_not_flagged(self):
        # sweep_only defers the reminder but keeps the JIT body, so the rule is still
        # delivered in full at edit time and is not seen by id only.
        r = self._rule(sweep_only=True, applies_to={"globs": ["app/**/*.php"]})
        self.assertEqual(validate.id_only_rules([r, self._pinned()]), [])

    def test_warning_does_not_fail_the_run(self):
        r = self._rule(digest_only=True)
        report = validate.validate([r, self._pinned()])
        self.assertEqual(report["errors"], [])
        self.assertEqual(report["id_only"], ["hub/architecture#x"])

    def test_untiered_scope_is_not_flagged(self):
        # A scope with no resident rule renders flat: every rule keeps a full line in its
        # own digest, so nothing in it is collapsed and nothing is seen by id only.
        r = self._rule(fqid="sso/native-client#x", scope="sso", topic="native-client",
                       digest_only=True)
        self.assertEqual(validate.id_only_rules([r]), [])

    def test_epics_topic_is_not_flagged(self):
        r = self._rule(fqid="hub/epics#bulk-import", topic="epics", id="bulk-import",
                       digest_only=True)
        self.assertEqual(validate.id_only_rules([r, self._pinned()]), [])


@needs_hook
class TestOversizeJitRules(unittest.TestCase):
    def _rule(self, **kw):
        base = dict(fqid="hub/api#x", scope="hub", topic="api",
                    id="x", title="t")
        base.update(kw)
        return lib.Rule(**base)

    def _pinned(self, scope="hub", topic="api"):
        """A resident rule in the same scope. render() only tiers a scope that has one,
        so without this the fixture's scope is flat and nothing in it is collapsed."""
        return lib.Rule(fqid=f"{scope}/{topic}#pinned", scope=scope, topic=topic,
                        id="pinned", title="t", resident=True)

    def _over_cap(self, factor=2):
        """A rule body guaranteed to exceed the hook's per-file cap, scaled to the cap
        itself rather than to a literal. A fixed literal silently goes vacuous the day
        the cap is tuned above it: the negative tests below would then pass because the
        body fits, not because the guard each one is named for fired."""
        return "x" * (validate._hook_module().file_budget() * factor)

    def test_body_over_the_cap_is_flagged(self):
        r = self._rule(rule=self._over_cap())
        out = validate.oversize_jit_rules([r, self._pinned()])
        self.assertEqual([f for f, _ in out], ["hub/api#x"])

    def test_body_under_the_cap_is_not_flagged(self):
        # the resident sibling makes this scope tiered, so the assertion turns on
        # the cap comparison rather than on the scope gate.
        r = self._rule(rule="short")
        self.assertEqual(validate.oversize_jit_rules([r, self._pinned()]), [])

    def test_resident_rule_is_not_flagged(self):
        # A resident rule is already in the digest in full; JIT delivery is moot.
        r = self._rule(rule=self._over_cap(), resident=True)
        self.assertEqual(validate.oversize_jit_rules([r]), [])

    def test_digest_only_rule_is_not_flagged(self):
        # digest_only rules are never JIT-injected at all, so the cap cannot bite them.
        # The resident sibling makes this scope tiered, so the assertion turns on
        # `not r.digest_only` rather than on the scope gate.
        r = self._rule(rule=self._over_cap(), digest_only=True)
        self.assertEqual(validate.oversize_jit_rules([r, self._pinned()]), [])

    def test_returns_size_and_sorts_largest_first(self):
        # Sizes scaled to the hook's per-file cap (DEFAULT_FILE_BUDGET) rather than a
        # fixed literal: both must clear the cap by a comfortable margin, with big
        # clearly larger than mid, regardless of where the cap itself is tuned.
        big = self._rule(id="big", fqid="hub/api#big", rule=self._over_cap(3))
        mid = self._rule(id="mid", fqid="hub/api#mid", rule=self._over_cap(2))
        out = validate.oversize_jit_rules([mid, big, self._pinned()])
        self.assertEqual([f for f, _ in out], ["hub/api#big", "hub/api#mid"])
        self.assertGreater(out[0][1], out[1][1])

    def test_warning_does_not_fail_the_run(self):
        r = self._rule(rule=self._over_cap())
        report = validate.validate([r, self._pinned()])
        self.assertEqual(report["errors"], [])
        self.assertEqual([f for f, _ in report["oversize_jit"]], ["hub/api#x"])

    def test_untiered_scope_is_not_flagged(self):
        r = self._rule(fqid="sso/infrastructure#x", scope="sso", topic="infrastructure",
                       rule=self._over_cap())
        self.assertEqual(validate.oversize_jit_rules([r]), [])


if __name__ == "__main__":
    unittest.main()


class TestUnreachableGlobs(unittest.TestCase):
    """Reachability is a static question the hit-ledger cannot answer: a never-fired rule
    looks the same whether its globs are wrong or the area is simply untouched."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "app" / "Services").mkdir(parents=True)
        (self.root / "app" / "Services" / "Real.php").write_text("<?php")
        validate._tree.cache_clear()

    def tearDown(self):
        self.tmp.cleanup()
        validate._tree.cache_clear()

    def _rules(self, globs):
        write_registry(self.root, "t.yaml",
                       "scope: hub\ntopic: t\nrules:\n  - id: a\n    title: A\n"
                       f"    applies_to:\n      globs: {globs}\n")
        return lib.load_all([self.root])

    def test_glob_matching_a_real_file_is_reachable(self):
        rules = self._rules('["app/Services/**/*.php"]')
        self.assertEqual(validate.unreachable_globs(rules, [self.root]), [])

    def test_glob_matching_nothing_is_reported(self):
        rules = self._rules('["projects/billing/src/**/*.ts"]')
        out = validate.unreachable_globs(rules, [self.root])
        self.assertEqual([fq for fq, _ in out], ["hub/t#a"])

    def test_any_matching_glob_makes_the_rule_reachable(self):
        rules = self._rules('["nope/**/*.ts", "app/Services/**/*.php"]')
        self.assertEqual(validate.unreachable_globs(rules, [self.root]), [])

    def test_rule_without_globs_is_never_reported(self):
        write_registry(self.root, "t.yaml",
                       "scope: hub\ntopic: t\nrules:\n  - id: a\n    title: A\n")
        self.assertEqual(validate.unreachable_globs(lib.load_all([self.root]), [self.root]), [])

    def test_digest_only_rule_is_exempt(self):
        write_registry(self.root, "t.yaml",
                       "scope: hub\ntopic: t\nrules:\n  - id: a\n    title: A\n"
                       "    digest_only: true\n"
                       "    applies_to:\n      globs: [\"nope/**/*.ts\"]\n")
        self.assertEqual(validate.unreachable_globs(lib.load_all([self.root]), [self.root]), [])

    def test_sweep_only_rule_is_still_reachable(self):
        write_registry(self.root, "t.yaml",
                       "scope: hub\ntopic: t\nrules:\n  - id: a\n    title: A\n"
                       "    sweep_only: true\n"
                       "    applies_to:\n      globs: [\"app/Services/**/*.php\"]\n")
        self.assertEqual(validate.unreachable_globs(lib.load_all([self.root]), [self.root]), [])

    def test_walk_sees_gitignored_files(self):
        # `git ls-files` would miss these; several rules legitimately target `*/.env`
        (self.root / "svc").mkdir()
        (self.root / "svc" / ".env").write_text("X=1")
        rules = self._rules('["*/.env"]')
        self.assertEqual(validate.unreachable_globs(rules, [self.root]), [])

    def _satellite(self, globs):
        # registry under umbrella/libs/<name>; globs are relative to the clone
        sat = self.root / "umbrella" / "libs" / "some-lib"
        write_registry(sat, "t.yaml",
                       "scope: some-lib\ntopic: t\nrules:\n  - id: a\n    title: A\n"
                       f"    applies_to:\n      globs: {globs}\n")
        roots = lib.scope_roots(self.root, SAT)
        return lib.load_all(roots), roots

    def _clone(self):
        (self.root / "checkouts" / "some-lib" / "src").mkdir(parents=True)
        (self.root / "checkouts" / "some-lib" / "src" / "m.py").write_text("")

    def test_satellite_glob_is_probed_against_its_clone(self):
        self._clone()
        rules, roots = self._satellite('["src/**/*.py"]')
        self.assertEqual(validate.unreachable_globs(rules, roots, SAT), [])

    def test_satellite_glob_missing_from_its_clone_is_reported(self):
        self._clone()
        rules, roots = self._satellite('["lib/**/*.rb"]')
        self.assertEqual([fq for fq, _ in validate.unreachable_globs(rules, roots, SAT)],
                         ["some-lib/t#a"])

    def test_satellite_without_a_local_clone_is_exempt(self):
        rules, roots = self._satellite('["src/**/*.py"]')
        self.assertEqual(validate.unreachable_globs(rules, roots, SAT), [])


class TestMutedChecks(unittest.TestCase):
    def _rule(self, **kw):
        base = dict(fqid="hub/x#y", scope="hub", topic="x", id="y", title="t",
                    check={"shell": "true", "flag_when": "> 0"})
        base.update(kw)
        return lib.Rule(**base)

    def test_sweep_only_with_check_is_flagged(self):
        # file_matches() decides before evaluate() reaches the check branch, so the
        # check runs only under --include-sweep-only: never at edit or commit time,
        # and the readiness sweep is the only caller that passes it.
        self.assertEqual(validate.muted_checks([self._rule(sweep_only=True)]),
                         [("hub/x#y", "sweep_only")])

    def test_digest_only_with_check_is_flagged(self):
        self.assertEqual(validate.muted_checks([self._rule(digest_only=True)]),
                         [("hub/x#y", "digest_only")])

    def test_check_without_muting_flag_is_clean(self):
        self.assertEqual(validate.muted_checks([self._rule()]), [])

    def test_muting_flag_without_check_is_clean(self):
        self.assertEqual(validate.muted_checks([self._rule(check=None, sweep_only=True)]), [])

    @needs_real
    def test_real_registry_is_clean(self):
        # Guards the current state: today no checked rule carries either flag.
        self.assertEqual(validate.muted_checks(lib.load_all(validate._default_roots(REAL))), [])

    def test_surfaces_as_an_error(self):
        report = validate.validate([self._rule(sweep_only=True)])
        self.assertIn(("muted_check", "hub/x#y", "sweep_only"), report["errors"])


class TestScopeMismatch(unittest.TestCase):
    """Every registry must declare the scope of the root it lives under: `root_scope` in the
    project root, the scope directory's name anywhere else. The edit hook keeps only rules
    whose scope is `root_scope` or the edited file's service, so a mis-scoped registry
    validates and renders yet never reaches an edit."""

    CFG = {**lib.CONFIG_DEFAULTS, "root_scope": "hub",
           "extra_scopes": ["umbrella/frontend", "umbrella/libs/*"]}

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)

    def reg(self, where, rel, scope, rules=True):
        body = "rules:\n  - id: a\n    title: A\n" if rules else "rules: []\n"
        header = f"scope: {scope}\n" if scope is not None else ""
        write_registry(self.root / where, rel, f"{header}topic: {Path(rel).stem}\n{body}")

    def mismatches(self, config):
        found = validate.scope_mismatches(lib.scope_roots(self.root, config), self.root, config)
        return [m[:3] for m in found]

    def build_clean(self):
        self.reg("", "api.yaml", "hub")
        self.reg("", "epics/feature.yaml", "hub")
        self.reg("svc", "domain.yaml", "svc")
        self.reg("umbrella/frontend", "ui.yaml", "frontend")
        self.reg("umbrella/libs/pages", "pages.yaml", "pages")
        write_registry(self.root, "config.yaml", "root_scope: hub\n")

    def test_matching_layout_is_clean(self):
        # root, epics, a top-level service, a deeper extra scope and a satellite-style glob
        self.build_clean()
        self.assertEqual(self.mismatches(self.CFG), [])

    def test_root_registry_with_another_scope_is_reported(self):
        self.reg("", "api.yaml", "hub")
        self.assertEqual(self.mismatches(lib.CONFIG_DEFAULTS),
                         [(".claude/knowledge/api.yaml", "hub", "project")])

    def test_epics_registry_is_held_to_the_root_scope(self):
        self.build_clean()
        self.reg("", "epics/feature.yaml", "epics")
        self.assertEqual(self.mismatches(self.CFG),
                         [(".claude/knowledge/epics/feature.yaml", "epics", "hub")])

    def test_service_and_extra_scope_registries_use_their_directory_name(self):
        self.build_clean()
        self.reg("svc", "domain.yaml", "hub")
        self.reg("umbrella/libs/pages", "pages.yaml", "libs")
        self.assertEqual(self.mismatches(self.CFG), [
            ("svc/.claude/knowledge/domain.yaml", "hub", "svc"),
            ("umbrella/libs/pages/.claude/knowledge/pages.yaml", "libs", "pages")])

    def test_missing_scope_header_is_reported_but_config_is_not(self):
        self.build_clean()
        self.reg("", "nohead.yaml", None)
        self.assertEqual(self.mismatches(self.CFG),
                         [(".claude/knowledge/nohead.yaml", None, "hub")])

    def test_cli_reports_an_error_and_exits_1(self):
        import json
        import subprocess
        import sys
        self.reg("", "api.yaml", "hub")
        env = {k: v for k, v in os.environ.items() if k != "CLAUDE_PROJECT_DIR"}
        env["KNOWLEDGE_LOCAL_DIR"] = str(self.root / "local")
        script = str(Path(validate.__file__).resolve())
        proc = subprocess.run([sys.executable, script, "--root", str(self.root)], env=env,
                              capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 1, proc.stderr)
        line = [ln for ln in proc.stdout.splitlines() if "scope_mismatch" in ln]
        self.assertEqual(len(line), 1, proc.stdout)
        self.assertTrue(line[0].startswith("ERROR scope_mismatch: .claude/knowledge/api.yaml "))
        self.assertIn("project", line[0])
        proc = subprocess.run([sys.executable, script, "--root", str(self.root), "--json"],
                              env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 1, proc.stderr)
        found = [f for f in json.loads(proc.stdout) if "scope_mismatch" in f["text"]]
        self.assertEqual([(f["category"], f["fqids"]) for f in found],
                         [("ERROR", ["hub/api#a"])])
