import subprocess
import sys
import tempfile, unittest
from pathlib import Path
import lib


def write_registry(root: Path, rel: str, text: str) -> None:
    p = root / ".claude" / "knowledge" / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)


class TestLib(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_load_sets_fqid_and_defaults(self):
        write_registry(self.root, "static-analysis.yaml",
            "scope: hub\ntopic: static-analysis\nrules:\n"
            "  - id: s1142\n    title: 3 returns\n")
        rules = lib.load_all([self.root])
        self.assertEqual(len(rules), 1)
        r = rules[0]
        self.assertEqual(r.fqid, "hub/static-analysis#s1142")
        self.assertEqual(r.severity, "recommended")        # default
        self.assertEqual(r.override_policy, "overridable")  # default

    def test_file_matches_globs_and_services(self):
        write_registry(self.root, "static-analysis.yaml",
            "scope: hub\ntopic: static-analysis\nrules:\n"
            "  - id: s1142\n    title: x\n    applies_to:\n"
            "      services: [catalog-api]\n      globs: ['app/**/*.php']\n")
        r = lib.load_all([self.root])[0]
        self.assertTrue(lib.file_matches(r, "app/Services/Foo.php", "catalog-api"))
        self.assertTrue(lib.file_matches(r, "app/Foo.php", "catalog-api"))  # depth-1 now matches
        self.assertFalse(lib.file_matches(r, "app/Services/Foo.php", "billing-api"))  # service excluded
        self.assertFalse(lib.file_matches(r, "README.md", "catalog-api"))           # glob excluded

    def test_services_and_no_globs_matches_nothing_in_the_workspace_space(self):
        # service=None is the workspace path space: check-on-edit's resolve() yields it only
        # for a file outside every service, so the services filter cannot discriminate there.
        # With no globs either, nothing is left to filter on and the rule matched EVERY file --
        # hub/architecture#billing-resolves-company-scope-via-catalog reminded on
        # all 11 files of a branch that touched nothing but .claude/.
        write_registry(self.root, "architecture.yaml",
            "scope: hub\ntopic: architecture\nrules:\n"
            "  - id: billing-scope\n    title: x\n    applies_to:\n"
            "      services: [billing-api, catalog-api]\n")
        r = lib.load_all([self.root])[0]
        self.assertFalse(lib.file_matches(r, ".claude/hooks/pair-brief.py", None))
        self.assertTrue(lib.file_matches(r, "app/Foo.php", "billing-api"))  # its own space

    def test_services_with_a_workspace_glob_still_matches_in_the_workspace_space(self):
        # The counterweight, and the reason the guard above is conditioned on `not globs`:
        # 17 hub rules pair a services list with a workspace-relative glob
        # (.claude/scenarios/**, services.manifest, brands.registry). Those globs are
        # reachable ONLY at service=None, so filtering on services there would silence them.
        write_registry(self.root, "testing.yaml",
            "scope: hub\ntopic: testing\nrules:\n"
            "  - id: scenario-rule\n    title: x\n    applies_to:\n"
            "      services: [billing-api]\n"
            "      globs: ['.claude/scenarios/**/*.mjs']\n")
        r = lib.load_all([self.root])[0]
        self.assertTrue(lib.file_matches(r, ".claude/scenarios/_lib/run.mjs", None))
        self.assertFalse(lib.file_matches(r, ".claude/hooks/pair-brief.py", None))

    def test_rule_without_services_still_matches_a_file_that_is_in_no_service(self):
        # The third case: an unscoped hub rule is the whole point of a cross-service run.
        write_registry(self.root, "workflow.yaml",
            "scope: hub\ntopic: workflow\nrules:\n"
            "  - id: any-file\n    title: x\n")
        r = lib.load_all([self.root])[0]
        self.assertTrue(lib.file_matches(r, ".claude/hooks/pair-brief.py", None))

    def test_glob_match_recursive_and_single_level(self):
        # ** is recursive: matches zero or more leading segments
        self.assertTrue(lib.glob_match("app/**/*.php", "app/Foo.php"))           # depth-1
        self.assertTrue(lib.glob_match("app/**/*.php", "app/Services/Deep/Bar.php"))  # deep
        # * does NOT cross a path separator
        self.assertTrue(lib.glob_match("app/Services/*.php", "app/Services/Foo.php"))
        self.assertFalse(lib.glob_match("app/Services/*.php", "app/Services/Sub/Foo.php"))
        # non-matching extension/root
        self.assertFalse(lib.glob_match("app/**/*.php", "README.md"))
        # ** matches zero intermediate segments (a/**/b matches a/b directly)
        self.assertTrue(lib.glob_match("a/**/b", "a/b"))
        # ** at the start matches root-level files
        self.assertTrue(lib.glob_match("**/*.php", "Foo.php"))

    def test_resolve_overrides_suppresses_target(self):
        write_registry(self.root, "static-analysis.yaml",
            "scope: hub\ntopic: code\nrules:\n  - id: layers\n    title: laravel layers\n")
        write_registry(self.root, "svc.yaml",
            "scope: sso\ntopic: code\nrules:\n  - id: overlay\n    title: upstream\n"
            "    overrides: [hub/code#layers]\n")
        rules = lib.load_all([self.root])
        effective, conflicts = lib.resolve_overrides(rules, "sso")
        fqids = {r.fqid for r in effective}
        self.assertIn("sso/code#overlay", fqids)
        self.assertNotIn("hub/code#layers", fqids)  # suppressed for sso
        self.assertEqual(conflicts, [])

    def test_override_of_binding_is_conflict(self):
        write_registry(self.root, "static-analysis.yaml",
            "scope: hub\ntopic: api\nrules:\n  - id: scope-lookup\n    title: idor\n"
            "    override_policy: binding\n")
        write_registry(self.root, "svc.yaml",
            "scope: sso\ntopic: api\nrules:\n  - id: x\n    title: y\n"
            "    overrides: [hub/api#scope-lookup]\n")
        rules = lib.load_all([self.root])
        _, conflicts = lib.resolve_overrides(rules, "sso")
        self.assertIn(("override_of_binding", "sso/api#x", "hub/api#scope-lookup"), conflicts)

    def test_digest_only_rule_never_file_matches(self):
        write_registry(self.root, "workflow.yaml",
            "scope: hub\ntopic: workflow\nrules:\n"
            "  - id: process-only\n    title: a process rule\n    digest_only: true\n")
        r = lib.load_all([self.root])[0]
        self.assertTrue(r.digest_only)
        self.assertFalse(lib.file_matches(r, "app/Foo.php", "catalog-api"))  # would match if not digest_only
        self.assertFalse(lib.file_matches(r, "anything.txt", None))

    def test_sweep_only_rule_excluded_unless_included(self):
        write_registry(self.root, "conventions.yaml",
            "scope: hub\ntopic: conventions\nrules:\n"
            "  - id: noisy\n    title: a noisy judgment rule\n    sweep_only: true\n"
            "    applies_to:\n      globs: ['app/**/*.php']\n")
        r = lib.load_all([self.root])[0]
        self.assertTrue(r.sweep_only)
        self.assertFalse(lib.file_matches(r, "app/Foo.php", "catalog-api"))
        self.assertTrue(lib.file_matches(r, "app/Foo.php", "catalog-api",
                                         include_sweep_only=True))

    def test_sweep_only_defaults_false(self):
        write_registry(self.root, "conventions.yaml",
            "scope: hub\ntopic: conventions\nrules:\n  - id: plain\n    title: x\n")
        r = lib.load_all([self.root])[0]
        self.assertFalse(r.sweep_only)

    def test_no_jit_parses_and_leaves_file_matching_alone(self):
        """`no_jit` gates only the PreToolUse injection hook, which does its own filtering.
        file_matches() drives the reminder channel and must ignore the field entirely —
        a no_jit rule still earns its REVIEW line wherever it would have earned one."""
        write_registry(self.root, "conventions.yaml",
            "scope: hub\ntopic: conventions\nrules:\n"
            "  - id: review-time-only\n    title: a comment-phrasing nit\n    no_jit: true\n"
            "    applies_to:\n      globs: ['app/**/*.php']\n")
        r = lib.load_all([self.root])[0]
        self.assertTrue(r.no_jit)
        self.assertTrue(lib.file_matches(r, "app/Foo.php", "catalog-api"))

    def test_no_jit_defaults_false(self):
        write_registry(self.root, "conventions.yaml",
            "scope: hub\ntopic: conventions\nrules:\n  - id: plain\n    title: x\n")
        r = lib.load_all([self.root])[0]
        self.assertFalse(r.no_jit)

    def test_resident_defaults_false_and_parses_true(self):
        write_registry(self.root, "workflow.yaml",
            "scope: hub\ntopic: workflow\nrules:\n"
            "  - id: plain\n    title: a plain rule\n"
            "  - id: pinned\n    title: a pinned rule\n    resident: true\n")
        by_id = {r.id: r for r in lib.load_all([self.root])}
        self.assertFalse(by_id["plain"].resident)
        self.assertTrue(by_id["pinned"].resident)

    def test_resident_is_orthogonal_to_digest_only(self):
        # A resident digest_only rule is the common case: it can never be recovered by
        # the JIT hook, so it has to stay in the digest.
        write_registry(self.root, "workflow.yaml",
            "scope: hub\ntopic: workflow\nrules:\n"
            "  - id: both\n    title: x\n    digest_only: true\n    resident: true\n")
        r = lib.load_all([self.root])[0]
        self.assertTrue(r.resident)
        self.assertTrue(r.digest_only)
        self.assertFalse(lib.file_matches(r, "app/Foo.php", "catalog-api"))

    def test_scope_roots_finds_root_and_service_scopes(self):
        write_registry(self.root, "api.yaml", "scope: hub\ntopic: api\nrules: []\n")
        (self.root / "svc" / ".claude" / "knowledge").mkdir(parents=True)
        (self.root / "svc" / ".claude" / "knowledge" / "api.yaml").write_text(
            "scope: svc\ntopic: api\nrules: []\n")
        (self.root / "not-a-scope").mkdir()
        roots = lib.scope_roots(self.root)
        self.assertEqual(roots[0], self.root)                 # root scope comes first
        self.assertIn(self.root / "svc", roots)
        self.assertNotIn(self.root / "not-a-scope", roots)

    def test_scope_roots_finds_extra_scope(self):
        write_registry(self.root, "api.yaml", "scope: hub\ntopic: api\nrules: []\n")
        (self.root / "umbrella" / "some-lib" / ".claude" / "knowledge").mkdir(parents=True)
        (self.root / "umbrella" / "some-lib" / ".claude" / "knowledge" / "api.yaml").write_text(
            "scope: some-lib\ntopic: api\nrules: []\n")
        config = {**lib.CONFIG_DEFAULTS, "extra_scopes": ["umbrella/*"]}
        self.assertIn(self.root / "umbrella" / "some-lib", lib.scope_roots(self.root, config))
        self.assertNotIn(self.root / "umbrella" / "some-lib", lib.scope_roots(self.root))


SCRIPTS = Path(__file__).resolve().parent
VENDORED = SCRIPTS / "vendor" / "yaml"


class TestYamlSource(unittest.TestCase):
    def test_vendored_copy_loads_when_no_system_yaml(self):
        code = ("import sys; sys.path.insert(0, %r); import lib; "
                "print(lib.yaml.__file__); print(lib.yaml.safe_load('a: [1, 2]')['a'])"
                % str(SCRIPTS))
        proc = subprocess.run([sys.executable, "-I", "-S", "-c", code],
                              capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        loaded, value = proc.stdout.split("\n")[:2]
        self.assertTrue(Path(loaded).is_relative_to(VENDORED), loaded)
        self.assertEqual(value, "[1, 2]")

    def test_system_yaml_wins_when_importable(self):
        if not any(Path(p, "yaml").is_dir() for p in sys.path if p):
            self.skipTest("no system PyYAML on this interpreter")
        self.assertFalse(Path(lib.yaml.__file__).is_relative_to(VENDORED.parent))


if __name__ == "__main__":
    unittest.main()
