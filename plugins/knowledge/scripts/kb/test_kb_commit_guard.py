#!/usr/bin/env python3
"""Tests for the commit-safety guard. Plain stdlib unittest (no pytest on this host):
    python3 .claude/scripts/kb/test_kb_commit_guard.py
or:
    python3 -m unittest .claude/scripts/kb/test_kb_commit_guard.py

Every test runs against a throwaway `tempfile.mkdtemp()` git repo, built and inspected with real
`git` subprocess calls — never mocked git. The design this guard implements was burned twice by
getting git's exit-code semantics wrong by inspection instead of by testing against real git, so
these tests reproduce real git states (a file tracked at HEAD, an untracked file, a repo with no
`.git` at all, HEAD moving between two commits) rather than asserting against assumptions about
what git *should* return.

Test cases below are numbered to match the guard's spec 1:1.
"""
import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "kb_commit_guard", Path(__file__).with_name("kb_commit_guard.py"))
kcg = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(kcg)


# ---------------------------------------------------------------------------
# Fixture helpers — real git, real throwaway repos.
# ---------------------------------------------------------------------------

def _run(cmd, cwd, check=True):
    return subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True, check=check)


def make_repo() -> Path:
    root = Path(tempfile.mkdtemp())
    _run(["git", "init", "-q"], root)
    _run(["git", "config", "user.email", "guard-test@example.com"], root)
    _run(["git", "config", "user.name", "Guard Test"], root)
    return root


def write_file(root: Path, rel: str, content: str) -> Path:
    p = Path(root) / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    return p


def commit_all(root: Path, message: str = "commit") -> None:
    _run(["git", "add", "-A"], root)
    _run(["git", "commit", "-q", "-m", message], root)


def commit_path(root: Path, rel: str, message: str = "commit") -> None:
    _run(["git", "add", "--", rel], root)
    _run(["git", "commit", "-q", "-m", message], root)


def git_show(root: Path, ref: str, rel: str) -> str:
    return _run(["git", "show", f"{ref}:{rel}"], root).stdout


def git_status(root: Path) -> str:
    return _run(["git", "status", "--porcelain"], root).stdout


def symlinked_service(root: Path, service: str) -> None:
    """Reproduce this repo's real layout: <service>/.claude -> ../scaffolding/<service>/.claude."""
    real = Path(root) / "scaffolding" / service / ".claude"
    real.mkdir(parents=True, exist_ok=True)
    link = Path(root) / service / ".claude"
    link.parent.mkdir(parents=True, exist_ok=True)
    link.symlink_to(Path("..") / ".." / "scaffolding" / service / ".claude")
    write_file(root, ".claude/knowledge/config.yaml",
               "scribe:\n  path_translations:\n"
               "    - {from: \"{service}/.claude\", to: \"scaffolding/{service}/.claude\"}\n")


# ---------------------------------------------------------------------------
# normalize_path / to_manifest_path
# ---------------------------------------------------------------------------

class NormalizePathTest(unittest.TestCase):
    def test_case2_symlink_and_scaffolding_forms_normalize_identically(self):
        root = make_repo()
        symlinked_service(root, "billing-api")

        via_symlink = kcg.normalize_path("billing-api/.claude/knowledge/import.yaml", root)
        via_scaffolding = kcg.normalize_path(
            "scaffolding/billing-api/.claude/knowledge/import.yaml", root)

        self.assertEqual(via_symlink, "scaffolding/billing-api/.claude/knowledge/import.yaml")
        self.assertEqual(via_symlink, via_scaffolding)

    def test_root_level_claude_is_left_alone(self):
        # Root .claude/ is directly tracked, not a symlink — must never be rewritten.
        root = make_repo()
        self.assertEqual(kcg.normalize_path(".claude/knowledge/workflow.yaml", root),
                          ".claude/knowledge/workflow.yaml")

    def test_non_symlinked_service_dir_is_left_alone(self):
        # A plain '<name>/.claude' that is NOT a symlink (e.g. a directory that merely happens to
        # be named '.claude') must not be rewritten — only a real symlink triggers translation.
        root = make_repo()
        (Path(root) / "plain-service" / ".claude" / "knowledge").mkdir(parents=True)
        self.assertEqual(kcg.normalize_path("plain-service/.claude/knowledge/x.yaml", root),
                          "plain-service/.claude/knowledge/x.yaml")

    def test_already_scaffolding_form_is_idempotent(self):
        root = make_repo()
        symlinked_service(root, "sso")
        p = "scaffolding/sso/.claude/knowledge/overlay.yaml"
        self.assertEqual(kcg.normalize_path(p, root), p)


class ManifestPathTest(unittest.TestCase):
    def test_case6_construction_time_normalization_is_cwd_independent(self):
        root = make_repo()
        symlinked_service(root, "billing-api")

        from_root = kcg.to_manifest_path(
            "billing-api/.claude/knowledge/x.yaml", root, cwd=root)
        from_subdir = kcg.to_manifest_path(
            ".claude/knowledge/x.yaml", root, cwd=Path(root) / "billing-api")
        from_scaffolding_form = kcg.to_manifest_path(
            "scaffolding/billing-api/.claude/knowledge/x.yaml", root, cwd=root)

        expected = "scaffolding/billing-api/.claude/knowledge/x.yaml"
        self.assertEqual(from_root, expected)
        self.assertEqual(from_subdir, expected)
        self.assertEqual(from_scaffolding_form, expected)

    def test_relative_path_escaping_root_raises_path_escapes_root_error(self):
        root = make_repo()
        with self.assertRaises(kcg.PathEscapesRootError):
            kcg.to_manifest_path("../../etc/passwd", root, cwd=root)

    def test_absolute_path_outside_root_raises_path_escapes_root_error(self):
        root = make_repo()
        outside = Path(tempfile.mkdtemp()) / "not-in-repo.yaml"
        with self.assertRaises(kcg.PathEscapesRootError):
            kcg.to_manifest_path(str(outside), root)


# ---------------------------------------------------------------------------
# snapshot / diff
# ---------------------------------------------------------------------------

class SnapshotDiffTest(unittest.TestCase):
    def test_case1_clean_before_and_after_is_silent(self):
        root = make_repo()
        write_file(root, "kb/knowledge/keep.yaml", "v1")
        commit_all(root, "baseline")
        pathspec = ["kb/knowledge/"]

        before = kcg.snapshot(root, pathspec)
        after = kcg.snapshot(root, pathspec)

        self.assertEqual(before, set())
        self.assertEqual(after, set())
        self.assertEqual(kcg.diff(before, after, manifest=[]), set())

    def test_case8_dirty_pathspec_before_any_writes_is_surfaced_immediately(self):
        root = make_repo()
        write_file(root, "kb/knowledge/keep.yaml", "v1")
        commit_all(root, "baseline")
        pathspec = ["kb/knowledge/"]

        # Dirty the pathspec BEFORE any run writes happen — no manifest exists yet.
        write_file(root, "kb/knowledge/keep.yaml", "v2 - modified before the run started")

        dirty = kcg.snapshot(root, pathspec)

        self.assertEqual(dirty, {"kb/knowledge/keep.yaml"},
                          "pre-existing dirt in the pathspec must be visible immediately, "
                          "before any write-manifest exists")

    def test_case9_foreign_file_mid_run_is_flagged_and_rollback_leaves_it_untouched(self):
        root = make_repo()
        write_file(root, "kb/knowledge/keep.yaml", "v1")
        commit_all(root, "baseline")
        pathspec = ["kb/knowledge/"]

        before = kcg.snapshot(root, pathspec)
        self.assertEqual(before, set())

        this_run_path = "kb/knowledge/this_run.yaml"
        write_file(root, this_run_path, "this run's own write")

        # An outside writer touches the pathspec mid-run, outside the manifest.
        foreign_path = "kb/knowledge/foreign.yaml"
        write_file(root, foreign_path, "left by an outside writer")

        after = kcg.snapshot(root, pathspec)
        manifest = [this_run_path]

        unaccounted = kcg.diff(before, after, manifest)
        self.assertEqual(unaccounted, {foreign_path},
                          "the foreign file must be reported as an abort signal")

        kcg.rollback(manifest, root)

        self.assertEqual(Path(root, foreign_path).read_text(encoding="utf-8"),
                          "left by an outside writer",
                          "rollback must only touch manifest paths, never the whole pathspec")
        self.assertFalse(Path(root, this_run_path).exists(),
                          "this run's own untracked write should have been rolled back")


# ---------------------------------------------------------------------------
# exists_at_head predicate
# ---------------------------------------------------------------------------

class ExistsAtHeadTest(unittest.TestCase):
    def test_case3_exit_0_when_tracked_at_head(self):
        root = make_repo()
        write_file(root, "kb/knowledge/tracked.yaml", "original")
        commit_path(root, "kb/knowledge/tracked.yaml", "add tracked file")

        self.assertTrue(kcg.exists_at_head("kb/knowledge/tracked.yaml", root))

    def test_case4_exit_1_when_never_tracked_at_head(self):
        root = make_repo()
        write_file(root, "kb/knowledge/keep.yaml", "v1")
        commit_all(root, "baseline")
        write_file(root, "kb/knowledge/brand_new.yaml", "new this run")

        self.assertFalse(kcg.exists_at_head("kb/knowledge/brand_new.yaml", root))

    def test_case5a_real_non_repo_cwd_is_a_hard_error(self):
        non_repo = Path(tempfile.mkdtemp())  # no `git init` at all

        with self.assertRaises(kcg.GitError):
            kcg.exists_at_head("whatever/path.yaml", non_repo)

    def test_case5b_stubbed_unknown_exit_code_is_a_hard_error(self):
        root = make_repo()

        def weird_exit(args, cwd):
            if args[:3] == ["rev-parse", "--verify", "-q"]:
                return 2, "", "stubbed: git cannot really produce this here"
            return kcg.run_git(args, cwd)

        with self.assertRaises(kcg.GitError):
            kcg.exists_at_head("kb/knowledge/whatever.yaml", root, run=weird_exit)


# ---------------------------------------------------------------------------
# rollback
# ---------------------------------------------------------------------------

class RollbackTest(unittest.TestCase):
    def test_case3_rollback_checks_out_tracked_path_from_head(self):
        root = make_repo()
        write_file(root, "kb/knowledge/tracked.yaml", "original")
        commit_path(root, "kb/knowledge/tracked.yaml", "add tracked file")
        write_file(root, "kb/knowledge/tracked.yaml", "modified by this run")

        kcg.rollback(["kb/knowledge/tracked.yaml"], root)

        self.assertEqual(Path(root, "kb/knowledge/tracked.yaml").read_text(encoding="utf-8"),
                          git_show(root, "HEAD", "kb/knowledge/tracked.yaml"))
        self.assertEqual(Path(root, "kb/knowledge/tracked.yaml").read_text(encoding="utf-8"),
                          "original")

    def test_case4_rollback_removes_never_tracked_path(self):
        root = make_repo()
        write_file(root, "kb/knowledge/keep.yaml", "v1")
        commit_all(root, "baseline")
        write_file(root, "kb/knowledge/brand_new.yaml", "new this run")

        kcg.rollback(["kb/knowledge/brand_new.yaml"], root)

        self.assertFalse(Path(root, "kb/knowledge/brand_new.yaml").exists())

    def test_case4_rollback_of_missing_path_is_a_noop_not_an_error(self):
        # rm -f semantics: no error if the file is already gone.
        root = make_repo()
        write_file(root, "kb/knowledge/keep.yaml", "v1")
        commit_all(root, "baseline")

        kcg.rollback(["kb/knowledge/never_existed.yaml"], root)  # must not raise

    def test_case5a_real_hard_error_does_not_fall_back_to_rm_f(self):
        non_repo = Path(tempfile.mkdtemp())
        target = write_file(non_repo, "some/file.yaml", "must survive")

        kcg.rollback(["some/file.yaml"], non_repo)

        self.assertTrue(target.exists(), "a hard git error must never be treated as license to rm -f")
        self.assertEqual(target.read_text(encoding="utf-8"), "must survive")

    def test_case5b_stubbed_hard_error_does_not_fall_back_to_rm_f_or_checkout(self):
        root = make_repo()
        write_file(root, "kb/knowledge/tracked.yaml", "original")
        commit_path(root, "kb/knowledge/tracked.yaml", "add tracked file")
        write_file(root, "kb/knowledge/tracked.yaml", "modified by this run, should survive")

        def weird_exit(args, cwd):
            if args[:3] == ["rev-parse", "--verify", "-q"]:
                return 2, "", "stubbed"
            return kcg.run_git(args, cwd)

        kcg.rollback(["kb/knowledge/tracked.yaml"], root, run=weird_exit)

        # Neither checkout (would restore "original") nor rm -f (would delete it) ran.
        self.assertEqual(Path(root, "kb/knowledge/tracked.yaml").read_text(encoding="utf-8"),
                          "modified by this run, should survive")

    def test_case7_mixed_manifest_resolves_both_paths_in_one_call_no_short_circuit(self):
        root = make_repo()
        write_file(root, "kb/knowledge/tracked.yaml", "original")
        commit_path(root, "kb/knowledge/tracked.yaml", "add tracked file")
        write_file(root, "kb/knowledge/tracked.yaml", "modified by this run")
        write_file(root, "kb/knowledge/brand_new.yaml", "new this run")

        manifest = ["kb/knowledge/tracked.yaml", "kb/knowledge/brand_new.yaml"]
        kcg.rollback(manifest, root)

        self.assertEqual(Path(root, "kb/knowledge/tracked.yaml").read_text(encoding="utf-8"),
                          "original", "exit-0 path must be checked out")
        self.assertFalse(Path(root, "kb/knowledge/brand_new.yaml").exists(),
                          "exit-1 path must be removed")

    def test_no_short_circuit_when_rm_f_raises_on_a_manifest_entry(self):
        # A manifest entry that resolves to a directory instead of a file makes _rm_f's
        # Path.unlink() raise IsADirectoryError (not FileNotFoundError) -- rollback must record
        # that as an "error" outcome and still process every other manifest path, never
        # aborting the loop partway through.
        root = make_repo()
        write_file(root, "kb/knowledge/keep.yaml", "v1")
        commit_all(root, "baseline")

        (Path(root) / "kb/knowledge/not_a_file").mkdir(parents=True)
        write_file(root, "kb/knowledge/not_a_file/inner.yaml", "unexpected directory")
        write_file(root, "kb/knowledge/brand_new.yaml", "new this run")

        manifest = ["kb/knowledge/not_a_file", "kb/knowledge/brand_new.yaml"]
        outcomes = kcg.rollback(manifest, root)

        by_path = {o.path: o for o in outcomes}
        self.assertEqual(by_path["kb/knowledge/not_a_file"].action, "error")
        self.assertFalse(by_path["kb/knowledge/not_a_file"].ok)
        self.assertFalse(Path(root, "kb/knowledge/brand_new.yaml").exists(),
                          "the failing entry must not stop rollback from processing the rest "
                          "of the manifest")

    def _head_moved_fixture(self):
        """This run creates `path` untracked (predicate would say exit 1 at write time). A
        SEPARATE commit then lands that exact path at HEAD, simulating a second process/scribe
        landing it first — before this run's rollback ever fires."""
        root = make_repo()
        write_file(root, "kb/knowledge/keep.yaml", "v1")
        commit_all(root, "baseline")

        rel = "kb/knowledge/raced.yaml"
        write_file(root, rel, "written by this run")
        write_file(root, rel, "committed by the second process")
        commit_path(root, rel, "second process lands the same path first")
        return root, rel

    def test_case10_predicate_is_re_evaluated_fresh_when_head_moves_mid_run(self):
        root, rel = self._head_moved_fixture()

        kcg.rollback([rel], root)

        self.assertEqual(Path(root, rel).read_text(encoding="utf-8"),
                          git_show(root, "HEAD", rel))
        self.assertEqual(Path(root, rel).read_text(encoding="utf-8"),
                          "committed by the second process")
        self.assertEqual(git_status(root), "",
                          "checkout from a fresh predicate read must leave the repo clean")

    def test_case10_negative_regression_guard_stale_predicate_would_leave_repo_dirty(self):
        """Proves the case10 assertions actually catch the bug they exist to catch: if the
        predicate's decision were stale/cached as 'not at HEAD' instead of freshly re-evaluated,
        rollback would `rm -f` a path that is actually tracked at HEAD, and `git status
        --porcelain` would show it as deleted (' D <path>') instead of being clean."""
        root, rel = self._head_moved_fixture()

        def force_missing(args, cwd):
            # Simulates a cached/stale predicate result from before the second commit landed.
            if args[:3] == ["rev-parse", "--verify", "-q"]:
                return 1, "", ""
            return kcg.run_git(args, cwd)

        kcg.rollback([rel], root, run=force_missing)

        self.assertFalse(Path(root, rel).exists(), "the stale-predicate stub forced an rm -f")
        status = git_status(root)
        self.assertIn(f" D {rel}", status,
                       "a real regression to a cached/stale predicate must show up as dirty git "
                       "status — if this assertion can't fail, the positive case10 test can't "
                       "either")


if __name__ == "__main__":
    unittest.main()
