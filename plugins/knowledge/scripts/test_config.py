"""The per-project config: defaults, tolerance for bad files, and each key's effect."""
import contextlib
import copy
import io
import os
import tempfile
import unittest
from pathlib import Path

import build_digest
import lib
import testkit
import validate
from kb import kb_commit_guard

RULE = "scope: {scope}\ntopic: t\nrules:\n  - id: a\n    title: A\n"


def registry(scope, extra=""):
    return {"scope": scope, "text": RULE.format(scope=scope) + extra}


class ConfigCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "project"
        self.root.mkdir()
        lib._config_warned = False

    def tearDown(self):
        self.tmp.cleanup()
        lib._config_warned = False
        validate._tree.cache_clear()

    def write(self, rel, text):
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")

    def kb(self, where, scope, extra=""):
        base = f"{where}/" if where else ""
        self.write(f"{base}.claude/knowledge/t.yaml", RULE.format(scope=scope) + extra)

    def test_capture_default_off_and_validation(self):
        self.assertEqual(lib.CONFIG_DEFAULTS['scribe']['capture'], 'off')
        self.assertTrue(lib._VALID_SCRIBE['capture']('auto'))
        self.assertFalse(lib._VALID_SCRIBE['capture']('always'))

    def config(self, text):
        self.write(".claude/knowledge/config.yaml", text)

    def load(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            cfg = lib.load_config(self.root)
        return cfg, err.getvalue()


class TestLoadConfig(ConfigCase):
    def test_absent_config_gives_defaults(self):
        cfg, err = self.load()
        self.assertEqual(cfg, lib.CONFIG_DEFAULTS)
        self.assertEqual(err, "")

    def test_defaults_are_not_shared_with_callers(self):
        cfg, _ = self.load()
        cfg["extra_scopes"].append("x")
        cfg["scribe"]["pathspecs"].append("x")
        self.assertEqual(lib.CONFIG_DEFAULTS["extra_scopes"], [])
        self.assertEqual(lib.CONFIG_DEFAULTS["scribe"]["pathspecs"], [".claude/knowledge"])

    def test_empty_file_gives_defaults(self):
        self.config("")
        cfg, err = self.load()
        self.assertEqual(cfg, lib.CONFIG_DEFAULTS)
        self.assertEqual(err, "")

    def test_malformed_yaml_gives_defaults_and_one_stderr_line(self):
        self.config("root_scope: [unclosed\n  : :\n")
        cfg, err = self.load()
        self.assertEqual(cfg, lib.CONFIG_DEFAULTS)
        self.assertEqual(len(err.strip().splitlines()), 1)
        _, again = self.load()
        self.assertEqual(again, "", "one line per process, not per load")

    def test_unknown_key_ignored_with_one_stderr_line(self):
        self.config("root_scope: mono\nmystery: 1\nscribe:\n  bogus: 2\n")
        cfg, err = self.load()
        self.assertEqual(cfg["root_scope"], "mono")
        self.assertNotIn("mystery", cfg)
        self.assertNotIn("bogus", cfg["scribe"])
        self.assertEqual(len(err.strip().splitlines()), 1)
        self.assertIn("mystery", err)

    def test_wrong_type_falls_back_per_key(self):
        self.config("extra_scopes: x\nscribe:\n  commit: push\n  lease_minutes: 5\nroot_scope: mono\n")
        cfg, _ = self.load()
        self.assertEqual(cfg["extra_scopes"], [])
        self.assertEqual(cfg["scribe"]["commit"], "commit")
        self.assertEqual(cfg["scribe"]["lease_minutes"], 5)
        self.assertEqual(cfg["root_scope"], "mono")

    def test_partial_scribe_block_merges(self):
        self.config("scribe:\n  commit: stage\n")
        cfg, err = self.load()
        expected = copy.deepcopy(lib.CONFIG_DEFAULTS["scribe"])
        expected["commit"] = "stage"
        self.assertEqual(cfg["scribe"], expected)
        self.assertEqual(err, "")

    def test_digest_guard_is_off_by_default(self):
        cfg, _ = self.load()
        self.assertIsNone(cfg["digest_guard"])

    def test_digest_guard_read_from_the_file(self):
        self.config("digest_guard: {resident: 30, max_bytes: 18432}\n")
        cfg, err = self.load()
        self.assertEqual(cfg["digest_guard"], {"resident": 30, "max_bytes": 18432})
        self.assertEqual(err, "")

    def test_bad_digest_guard_falls_back_to_off(self):
        for text in ("digest_guard: 30\n", "digest_guard: {resident: x}\n",
                     "digest_guard: {resident: 3, size: 10}\n", "digest_guard: {max_bytes: 0}\n"):
            with self.subTest(text=text):
                lib._config_warned = False
                self.config(text)
                cfg, err = self.load()
                self.assertIsNone(cfg["digest_guard"])
                self.assertIn("digest_guard", err)

    def test_config_yaml_is_not_a_registry(self):
        self.kb("", "project")
        self.config("root_scope: project\n")
        self.assertEqual([r.fqid for r in lib.load_all([self.root])], ["project/t#a"])


class TestScopes(ConfigCase):
    def test_top_level_scope_found_without_config(self):
        self.kb("", "project")
        self.kb("svc", "svc")
        self.assertEqual(lib.scope_roots(self.root), [self.root, self.root / "svc"])

    def test_extra_scopes_glob(self):
        self.kb("", "project")
        self.kb("packages/a", "a")
        self.kb("packages/b", "b")
        (self.root / "packages" / "c").mkdir()
        cfg = {**lib.CONFIG_DEFAULTS, "extra_scopes": ["packages/*"]}
        self.assertEqual(lib.scope_roots(self.root, cfg),
                         [self.root, self.root / "packages/a", self.root / "packages/b"])
        self.assertEqual(lib.scope_roots(self.root), [self.root])

    def test_extra_scopes_read_from_the_config_file(self):
        self.kb("", "project")
        self.kb("packages/a", "a")
        self.config("extra_scopes: ['packages/*']\n")
        self.assertIn(self.root / "packages/a", lib.scope_roots(self.root))

    def test_service_of_deepest_scope(self):
        self.kb("", "project")
        self.kb("packages/a", "a")
        self.kb("packages/a/inner", "inner")
        cfg = {**lib.CONFIG_DEFAULTS, "extra_scopes": ["packages/*", "packages/a/*"]}
        self.assertEqual(lib.service_of(self.root, self.root / "packages/a/src/x.ts", cfg), "a")
        self.assertEqual(lib.service_of(self.root, "packages/a/inner/y.ts", cfg), "inner")
        self.assertIsNone(lib.service_of(self.root, self.root / "README.md", cfg))

    def test_registry_root_uses_fallbacks(self):
        self.kb("umbrella/svc", "svc")
        cfg = {**lib.CONFIG_DEFAULTS, "registry_fallbacks": ["umbrella/{service}"]}
        self.assertEqual(lib.registry_root(self.root, "svc", cfg), self.root / "umbrella/svc")
        self.assertIsNone(lib.registry_root(self.root, "svc"))

    def test_stray_brace_in_a_template_degrades(self):
        # A template is substituted with .replace, not str.format: a stray brace must not
        # raise KeyError inside the fail-open edit hook and silently disable injection.
        self.kb("umbrella/svc", "svc")
        cfg = {**lib.CONFIG_DEFAULTS,
               "registry_fallbacks": ["odd/{svc}/{service}", "umbrella/{service}"]}
        self.assertEqual(lib.registry_root(self.root, "svc", cfg), self.root / "umbrella/svc")


class TestProbing(ConfigCase):
    CFG = {**lib.CONFIG_DEFAULTS, "extra_scopes": ["umbrella/*"],
           "probe_roots": [{"registry": "umbrella/*", "tree": "checkouts/{name}"}]}

    def rules(self, glob):
        self.kb("", "project")
        self.kb("umbrella/lib", "lib", f"    applies_to:\n      globs: ['{glob}']\n")
        roots = lib.scope_roots(self.root, self.CFG)
        return lib.load_all(roots), roots

    def test_probe_roots_present_tree_is_probed(self):
        self.write("checkouts/lib/src/m.py", "")
        rules, roots = self.rules("src/*.py")
        self.assertEqual(validate.unreachable_globs(rules, roots, self.CFG), [])
        rules, roots = self.rules("lib/*.rb")
        self.assertEqual([f for f, _ in validate.unreachable_globs(rules, roots, self.CFG)],
                         ["lib/t#a"])

    def test_stray_brace_in_a_probe_tree_degrades(self):
        cfg = {**self.CFG, "probe_roots": [{"registry": "umbrella/*", "tree": "{oops}/{name}"}]}
        rules, roots = self.rules("src/*.py")
        self.assertEqual(validate.unreachable_globs(rules, roots, cfg), [])

    def test_probe_roots_absent_tree_is_skipped(self):
        rules, roots = self.rules("src/*.py")
        self.assertEqual(validate.unreachable_globs(rules, roots, self.CFG), [])

    def test_unprobed_scope_reports_no_unreachable(self):
        self.write("checkouts/lib/src/m.py", "")
        rules, roots = self.rules("nothing/*.rb")
        self.assertEqual(len(validate.unreachable_globs(rules, roots, self.CFG)), 1)
        cfg = {**self.CFG, "unprobed_scopes": ["lib"]}
        self.assertEqual(validate.unreachable_globs(rules, roots, cfg), [])


class TestRootScope(ConfigCase):
    def rules(self):
        mk = lambda scope: lib.Rule(fqid=f"{scope}/t#a", scope=scope, topic="t", id="a", title="a",
                                    override_policy="binding", applies_to={"services": ["svc"]})
        return [mk("svc"), mk("hub")]

    def test_binding_only_in_root_scope(self):
        # Fan-out is a root-scope notion: only the configured root scope's rules are
        # reported, and overriding a binding rule stays an error in any scope.
        cfg = {**lib.CONFIG_DEFAULTS, "root_scope": "hub"}
        self.assertEqual([f for f, _, _ in validate.fan_out(self.rules(), config=cfg)],
                         ["hub/t#a"])
        self.assertEqual(validate.fan_out(self.rules()), [])
        override = lib.Rule(fqid="svc/t#o", scope="svc", topic="t", id="o", title="o",
                            overrides=["hub/t#a"])
        errors = validate.check_edges(self.rules() + [override])
        self.assertIn(("override_of_binding", "svc/t#o", "hub/t#a"), errors)


class TestDigestTrailer(ConfigCase):
    def rules(self, resident):
        return [lib.Rule(fqid="p/t#a", scope="p", topic="t", id="a", title="a",
                         rule="r", resident=resident)]

    def test_trailer_appended_only_when_tiered(self):
        cfg = {**lib.CONFIG_DEFAULTS, "digest_trailer": "TRAILER\n"}
        self.assertFalse(build_digest.render(self.rules(False), cfg).endswith("TRAILER\n"))
        tiered = build_digest.render(self.rules(True), cfg)
        self.assertTrue(tiered.endswith("\nTRAILER\n"))
        self.assertTrue(build_digest.render(self.rules(True)).endswith("\n" + lib.DEFAULT_TRAILER))

    def test_header_names_plugin_script(self):
        first = build_digest.render(self.rules(False)).splitlines()[0]
        self.assertEqual(first, "<!-- GENERATED from .claude/knowledge/*.yaml by the knowledge "
                                "plugin's build_digest.py — do not hand-edit. -->")

    def test_drift_check_uses_the_same_config(self):
        self.kb("", "p", "    resident: true\n")
        self.config("digest_trailer: |\n  custom trailer\n")
        cfg = lib.load_config(self.root)
        (self.root / ".claude/knowledge/_digest.md").write_text(
            build_digest.render(lib.load_all([self.root]), cfg))
        self.assertEqual(validate.digest_drift([self.root], cfg), [])
        self.assertEqual(len(validate.digest_drift([self.root])), 1)


class TestTranslate(unittest.TestCase):
    CFG = {**lib.CONFIG_DEFAULTS, "scribe": {**lib.CONFIG_DEFAULTS["scribe"], "path_translations": [
        {"from": "{service}/.claude", "to": "umbrella/{service}/.claude"}]}}

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "umbrella/svc/.claude").mkdir(parents=True)
        (self.root / "svc").mkdir()
        (self.root / "svc/.claude").symlink_to("../umbrella/svc/.claude")
        (self.root / "real/.claude").mkdir(parents=True)

    def tearDown(self):
        self.tmp.cleanup()

    def test_translate_only_symlinked(self):
        t = kb_commit_guard.translate
        self.assertEqual(t("real/.claude/knowledge/x.yaml", self.root, self.CFG),
                         "real/.claude/knowledge/x.yaml")
        self.assertEqual(t("svc/.claude/knowledge/x.yaml", self.root, self.CFG),
                         "umbrella/svc/.claude/knowledge/x.yaml")
        self.assertEqual(t("svc/.claude/knowledge/", self.root, self.CFG),
                         "umbrella/svc/.claude/knowledge/")
        self.assertEqual(t("umbrella/svc/.claude/knowledge/x.yaml", self.root, self.CFG),
                         "umbrella/svc/.claude/knowledge/x.yaml")
        self.assertEqual(t("svc/.claude/knowledge/x.yaml", self.root, lib.CONFIG_DEFAULTS),
                         "svc/.claude/knowledge/x.yaml")


if __name__ == "__main__":
    unittest.main()
