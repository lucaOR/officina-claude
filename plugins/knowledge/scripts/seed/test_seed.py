import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
K = HERE.parent.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

import lib  # noqa: E402
import sources  # noqa: E402
import testkit  # noqa: E402


class _Base(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.base = Path(tmp.name).resolve()
        self.home = self.base / "home"
        self.cfg = self.base / "cfg"
        self.home.mkdir()
        self.cfg.mkdir()
        self.env = {"HOME": str(self.home), "CLAUDE_CONFIG_DIR": str(self.cfg)}
        patcher = mock.patch.dict(os.environ, self.env)
        patcher.start()
        self.addCleanup(patcher.stop)
        os.environ.pop("KNOWLEDGE_LOCAL_DIR", None)

    def run_cli(self, script, *args):
        env = {k: v for k, v in os.environ.items() if k != "KNOWLEDGE_LOCAL_DIR"}
        env.update(self.env)
        return subprocess.run([sys.executable, str(HERE / script), *args],
                              capture_output=True, text=True, env=env)

    def write(self, root, rel, text="x\n"):
        p = Path(root) / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
        return p


class TestSources(_Base):
    def test_memory_dir_slug(self):
        root = self.base / "my.proj"
        root.mkdir()
        slug = "".join(c if c.isalnum() and c.isascii() else "-" for c in str(root))
        self.assertEqual(sources.memory_dir(root), self.cfg / "projects" / slug / "memory")
        self.assertTrue(slug.endswith("-my-proj"))

    def test_memory_dir_setting_wins(self):
        root = self.base / "p"
        self.write(self.cfg, "settings.json", json.dumps({"autoMemoryDirectory": "/c"}))
        self.assertEqual(sources.memory_dir(root), Path("/c"))
        self.write(root, ".claude/settings.local.json", json.dumps({"autoMemoryDirectory": "/l"}))
        self.assertEqual(sources.memory_dir(root), Path("/l"))

    def test_committed_project_settings_cannot_pick_the_memory_dir(self):
        # A cloned repository could otherwise point setup at any directory of the user's
        # markdown, which setup would offer to seed from and then retire.
        root = self.base / "p"
        self.write(root, ".claude/settings.json", json.dumps({"autoMemoryDirectory": "/a"}))
        slug = "".join(c if c.isalnum() and c.isascii() else "-" for c in str(root))
        self.assertEqual(sources.memory_dir(root), self.cfg / "projects" / slug / "memory")
        self.write(self.cfg, "settings.json", json.dumps({"autoMemoryDirectory": "/c"}))
        self.assertEqual(sources.memory_dir(root), Path("/c"))

    def test_discover_reports_an_ignored_committed_memory_dir(self):
        # Setup ignores a committed autoMemoryDirectory (Claude Code itself honours it under
        # workspace trust), so discover says which value it skipped and setup can tell the user.
        root = self.base / "p"
        root.mkdir()
        self.assertNotIn("memory_dir_ignored", sources.discover(root))
        self.write(root, ".claude/settings.json",
                   json.dumps({"autoMemoryDirectory": "~/team-notes"}))
        self.write(self.cfg, "settings.json", json.dumps({"autoMemoryDirectory": "/c"}))
        found = sources.discover(root)
        self.assertEqual(found["memory_dir_ignored"], "~/team-notes")
        self.assertEqual(sources.memory_dir(root), Path("/c"))
        proc = self.run_cli("sources.py", "--root", str(root))
        self.assertEqual(json.loads(proc.stdout)["memory_dir_ignored"], "~/team-notes")
        # A local setting wins over the committed one for Claude Code too, so nothing to report.
        self.write(root, ".claude/settings.local.json", json.dumps({"autoMemoryDirectory": "/l"}))
        self.assertNotIn("memory_dir_ignored", sources.discover(root))

    def test_memory_dir_of_a_linked_worktree_is_the_main_checkout_s(self):
        # Claude Code keys auto memory on the git repository, so every worktree of a
        # repository shares one memory directory.
        main = testkit.make_project(self.base)
        wt = testkit.make_worktree(main, self.base / "wt")
        slug = "".join(c if c.isalnum() and c.isascii() else "-" for c in str(main.resolve()))
        self.assertEqual(sources.memory_dir(wt), self.cfg / "projects" / slug / "memory")

    def test_memory_index_not_a_source(self):
        root = self.base / "p"
        root.mkdir()
        mem = sources.memory_dir(root)
        self.write(mem, "MEMORY.md", "- [a](a.md)\n")
        self.write(mem, "a.md")
        self.write(mem, "sub/b.md")
        names = [m["name"] for m in sources.discover(root)["memory"]]
        self.assertEqual(names, ["a.md"])

    def test_instructions_found_at_depth(self):
        root = testkit.make_project(self.base)
        for rel in ("CLAUDE.md", "sub/CLAUDE.md", "AGENTS.md", ".cursor/rules/a.mdc",
                    ".github/copilot-instructions.md", ".cursorrules"):
            self.write(root, rel)
        got = sources.discover(root)["instructions"]
        for rel in ("CLAUDE.md", "sub/CLAUDE.md", "AGENTS.md", ".cursor/rules/a.mdc",
                    ".github/copilot-instructions.md", ".cursorrules"):
            self.assertIn(rel, got)

    def test_claude_local_never_a_source(self):
        root = testkit.make_project(self.base)
        self.write(root, "CLAUDE.local.md")
        self.write(root, "MEMORY.md")
        d = sources.discover(root)
        self.assertNotIn("CLAUDE.local.md", d["instructions"])
        self.assertEqual(d["other_markdown"], {})

    def test_other_markdown_grouped_and_filtered(self):
        root = testkit.make_project(self.base)
        for rel in ("docs/a.md", "docs/deep/b.md", "top.md", "README.md", "docs/README.md",
                    "CHANGELOG.md", "LICENSE.md", "node_modules/x.md", "vendor/v.md",
                    "dist/d.md", "build/b.md", ".claude/knowledge/x.md", "CLAUDE.md"):
            self.write(root, rel)
        om = sources.discover(root)["other_markdown"]
        self.assertEqual(om, {"docs": ["docs/a.md", "docs/deep/b.md"], ".": ["top.md"]})

    def test_discover_reports_existing_kb(self):
        root = testkit.make_project(self.base)
        self.assertFalse(sources.discover(root)["kb_exists"])
        self.write(root, ".claude/knowledge/epics/launch.yaml", "rules: []\n")
        self.assertTrue(sources.discover(root)["kb_exists"])

    def test_kb_exists_needs_a_rule_file(self):
        # Setup writes config.yaml before it seeds, and a push creates .local/, so neither
        # may stop a later setup from seeding.
        root = testkit.make_project(self.base)
        self.write(root, ".claude/knowledge/config.yaml", "scribe:\n  commit: commit\n")
        self.assertFalse(sources.discover(root)["kb_exists"])
        pushed = testkit.make_project(self.base / "pushed")
        self.write(pushed, ".claude/knowledge/.local/queue.md", "")
        self.assertFalse(sources.discover(pushed)["kb_exists"])
        self.write(root, ".claude/knowledge/conventions.yaml", "rules: []\n")
        self.assertTrue(sources.discover(root)["kb_exists"])

    def test_discover_without_git(self):
        root = testkit.make_project(self.base, git=False)
        for rel in ("CLAUDE.md", "docs/a.md", ".git/x.md", "node_modules/n.md"):
            self.write(root, rel)
        d = sources.discover(root)
        self.assertEqual(d["instructions"], ["CLAUDE.md"])
        self.assertEqual(d["other_markdown"], {"docs": ["docs/a.md"]})

    def test_untracked_instruction_found_in_git(self):
        root = testkit.make_project(self.base)
        self.write(root, "CLAUDE.md")
        self.assertEqual(sources.discover(root)["instructions"], ["CLAUDE.md"])

    def test_cli_prints_json(self):
        root = testkit.make_project(self.base)
        self.write(root, "CLAUDE.md")
        proc = self.run_cli("sources.py", "--root", str(root))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout)["instructions"], ["CLAUDE.md"])


class TestRetire(_Base):
    def setup_memory(self):
        root = self.base / "p"
        root.mkdir()
        mem = sources.memory_dir(root)
        self.write(mem, "MEMORY.md", "- [A](a.md) — one\n- [B](b.md) — two\n")
        self.write(mem, "a.md", "alpha\n")
        return root, mem

    def test_retire_moves_and_unindexes(self):
        root, mem = self.setup_memory()
        proc = self.run_cli("retire.py", "--root", str(root), "--memory-file", "a.md",
                            "--date", "2026-11-23")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual((mem / ".retired/2026-11-23/a.md").read_text(), "alpha\n")
        self.assertFalse((mem / "a.md").exists())
        self.assertEqual((mem / "MEMORY.md").read_text(), "- [B](b.md) — two\n")

    def test_retire_missing_file_errors(self):
        root, mem = self.setup_memory()
        before = (mem / "MEMORY.md").read_text()
        proc = self.run_cli("retire.py", "--root", str(root), "--memory-file", "zz.md")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("zz.md", proc.stderr + proc.stdout)
        self.assertEqual((mem / "MEMORY.md").read_text(), before)
        self.assertFalse((mem / ".retired").exists())


class TestRegister(_Base):
    def known(self, source):
        self.write(self.cfg, "plugins/known_marketplaces.json", json.dumps(
            {"officina-claude": {"source": source, "installLocation": "/x", "lastUpdated": "t"}}))

    def settings(self, root):
        return json.loads((root / ".claude/settings.json").read_text())

    def test_register_settings_idempotent(self):
        root = self.base / "p"
        self.write(root, ".claude/settings.json", json.dumps({"permissions": {"allow": ["a"]}}))
        src = {"source": "github", "repo": "lucaOR/officina-claude"}
        self.known(src)
        for _ in range(2):
            proc = self.run_cli("register.py", "--root", str(root))
            self.assertEqual(proc.returncode, 0, proc.stderr)
        s = self.settings(root)
        self.assertEqual(s["permissions"], {"allow": ["a"]})
        self.assertEqual(s["enabledPlugins"], {"knowledge@officina-claude": True})
        self.assertEqual(s["extraKnownMarketplaces"], {"officina-claude": {"source": src}})
        text = (root / ".claude/settings.json").read_text()
        self.assertTrue(text.endswith("\n"))
        self.assertIn('\n  "', text)

    def test_register_without_known_marketplace(self):
        root = self.base / "p"
        proc = self.run_cli("register.py", "--root", str(root))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertFalse(out["marketplace_registered"])
        s = self.settings(root)
        self.assertEqual(s["enabledPlugins"], {"knowledge@officina-claude": True})
        self.assertNotIn("extraKnownMarketplaces", s)

    def test_register_keeps_existing_marketplace(self):
        root = self.base / "p"
        mine = {"source": "git", "url": "u"}
        self.write(root, ".claude/settings.json", json.dumps(
            {"extraKnownMarketplaces": {"officina-claude": {"source": mine}}}))
        self.known({"source": "github", "repo": "o/r"})
        self.run_cli("register.py", "--root", str(root))
        self.assertEqual(self.settings(root)["extraKnownMarketplaces"]["officina-claude"],
                         {"source": mine})


class TestShortcut(_Base):
    def test_shortcut_never_overwrites(self):
        target = self.home / ".local/bin/ccscribe"
        self.write(self.home, ".local/bin/ccscribe", "mine\n")
        proc = self.run_cli("shortcut.py")
        self.assertEqual(proc.returncode, 1)
        self.assertIn(str(target), proc.stderr + proc.stdout)
        self.assertEqual(target.read_bytes(), b"mine\n")

    def test_shortcut_broken_symlink_counts_as_existing(self):
        (self.home / ".local/bin").mkdir(parents=True)
        (self.home / ".local/bin/ccscribe").symlink_to(self.home / "nowhere")
        self.assertEqual(self.run_cli("shortcut.py").returncode, 1)

    def test_shortcut_installed_executable(self):
        proc = self.run_cli("shortcut.py")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        target = self.home / ".local/bin/ccscribe"
        self.assertEqual(target.read_bytes(), (K / "templates/ccscribe").read_bytes())
        self.assertEqual(target.stat().st_mode & 0o777, 0o755)


class TestConfigWrite(_Base):
    def commit_of(self, root):
        return lib.load_config(root)["scribe"]["commit"]

    def test_config_commit_preserves_comments(self):
        root = self.base / "p"
        text = "# top\nroot_scope: mine  # keep\nscribe:\n    # about\n    audit_every_days: 3\n"
        self.write(root, ".claude/knowledge/config.yaml", text)
        proc = self.run_cli("config_write.py", "--root", str(root), "--commit", "stage")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = (root / ".claude/knowledge/config.yaml").read_text()
        self.assertIn("# top", out)
        self.assertIn("# keep", out)
        self.assertIn("    # about", out)
        self.assertEqual(self.commit_of(root), "stage")
        self.assertEqual(lib.load_config(root)["scribe"]["audit_every_days"], 3)
        self.assertEqual(lib.load_config(root)["root_scope"], "mine")

    def test_config_replaces_existing_commit(self):
        root = self.base / "p"
        self.write(root, ".claude/knowledge/config.yaml",
                   "scribe:\n  commit: commit  # c\n  lease_minutes: 5\n")
        self.run_cli("config_write.py", "--root", str(root), "--commit", "stage")
        out = (root / ".claude/knowledge/config.yaml").read_text()
        self.assertEqual(out.count("commit:"), 1)
        self.assertIn("# c", out)
        self.assertEqual(self.commit_of(root), "stage")

    def test_config_appends_scribe_block(self):
        root = self.base / "p"
        self.write(root, ".claude/knowledge/config.yaml", "root_scope: x")
        self.run_cli("config_write.py", "--root", str(root), "--commit", "stage")
        self.assertEqual(self.commit_of(root), "stage")
        self.assertEqual(lib.load_config(root)["root_scope"], "x")

    def test_config_creates_file(self):
        root = self.base / "p"
        proc = self.run_cli("config_write.py", "--root", str(root), "--commit", "commit")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(self.commit_of(root), "commit")

    def test_config_refuses_an_inline_scribe_value(self):
        # A flow-style `scribe: {...}` line does not match the block form; appending a second
        # `scribe:` block would make PyYAML keep only the last and silently drop the first.
        root = self.base / "p"
        text = "root_scope: x\nscribe: {pathspecs: [a, b], commit: commit}\n"
        self.write(root, ".claude/knowledge/config.yaml", text)
        proc = self.run_cli("config_write.py", "--root", str(root), "--commit", "stage")
        self.assertEqual(proc.returncode, 1, proc.stdout)
        self.assertIn("inline", proc.stderr)
        self.assertEqual((root / ".claude/knowledge/config.yaml").read_text(), text)

    def test_config_rejects_bad_value(self):
        root = self.base / "p"
        self.assertEqual(self.run_cli("config_write.py", "--root", str(root),
                                      "--commit", "push").returncode, 2)
        self.assertFalse((root / ".claude/knowledge/config.yaml").exists())


if __name__ == "__main__":
    unittest.main()
