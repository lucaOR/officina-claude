"""Tests for the /handoff collector.

The collector shells out to git and picks the newest transcript in the project
directory. Both are pointed at a temporary directory so the test never depends
on the real repository state or on which sessions happen to be open.

Plain unittest: there is no pytest on this host.
"""
import importlib.util
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

COLLECT = Path(__file__).resolve().parent / "collect.py"


def _load_collect():
    """Import collect.py for its constants; the `main()` guard keeps it inert."""
    spec = importlib.util.spec_from_file_location("collect", COLLECT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


collect_mod = _load_collect()
# Session ids that must be ACCEPTED and REJECTED by collect.SESSION_ID_RE. They
# are asserted against that regex below rather than trusted, so tightening the
# pattern fails the assertion instead of quietly making every test vacuous.
VALID_ID = "1423c83a-b396-4420-b41a-4c5e1757a965"
OTHER_VALID_ID = "a8a3aa5b-d06c-4c04-a552-76ef43826d87"
REJECTED_ID = "../../../etc/passwd"


class CollectCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        self.git("init", "-b", "main")
        self.git("config", "user.email", "t@example.com")
        self.git("config", "user.name", "t")
        (self.repo / "a.txt").write_text("one\n")
        self.git("add", "a.txt")
        self.git("commit", "-m", "feat: first")

    def git(self, *args):
        subprocess.run(["git", *args], cwd=self.repo, check=True, capture_output=True)

    def collect(self, transcript_dir=None, home=None, session_id=None):
        # Every CLAUDE_* variable is stripped, not inherited: a real
        # CLAUDE_CODE_SESSION_ID or CLAUDE_PROJECT_DIR leaking in from the
        # session running the suite would steer the resolution under test.
        env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDE")}
        if transcript_dir:
            env["HANDOFF_TRANSCRIPT_DIR"] = str(transcript_dir)
        if home:
            env["HOME"] = str(home)
        if session_id:
            env["CLAUDE_CODE_SESSION_ID"] = session_id
        proc = subprocess.run(
            ["python3", str(COLLECT)], cwd=self.repo, env=env,
            capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return dict(
            line.split(": ", 1)
            for line in proc.stdout.strip().split("\n")
            if ": " in line
        )


class TestCollect(CollectCase):
    def test_reports_branch_and_last_commit(self):
        out = self.collect()
        self.assertEqual(out["branch"], "main")
        self.assertIn("feat: first", out["commits"])

    def test_reports_uncommitted_changes(self):
        (self.repo / "b.txt").write_text("two\n")
        out = self.collect()
        self.assertIn("b.txt", out["changed"])

    def test_picks_the_newest_transcript(self):
        tdir = self.tmp / "transcripts"
        tdir.mkdir()
        (tdir / "old-session.jsonl").write_text("{}\n")
        time.sleep(0.01)
        (tdir / "new-session.jsonl").write_text("{}\n")
        out = self.collect(transcript_dir=tdir)
        self.assertTrue(out["transcript"].startswith(str(tdir / "new-session.jsonl")))

    def test_transcript_line_is_explicit_when_none_exist(self):
        tdir = self.tmp / "empty"
        tdir.mkdir()
        out = self.collect(transcript_dir=tdir)
        self.assertEqual(out["transcript"], "(none found)")

    def test_session_id_is_the_newest_transcripts_bare_stem(self):
        tdir = self.tmp / "transcripts"
        tdir.mkdir()
        (tdir / "old-session.jsonl").write_text("{}\n")
        time.sleep(0.01)
        (tdir / "new-session.jsonl").write_text("{}\n")
        out = self.collect(transcript_dir=tdir)
        self.assertEqual(out["session_id"], "new-session")
        self.assertNotIn(".jsonl", out["session_id"])
        self.assertNotIn("(last written", out["session_id"])

    def test_session_id_is_explicit_when_none_exist(self):
        tdir = self.tmp / "empty"
        tdir.mkdir()
        out = self.collect(transcript_dir=tdir)
        self.assertEqual(out["session_id"], "(none found)")


class TestNotePath(CollectCase):
    """The path the note is written to, which the skill must not construct itself.

    It is derived from the session id, so the two things that make a note
    survivable are asserted here: two concurrent sessions get two files, and the
    file is outside the repository, where a worktree teardown and a `git add -A`
    cannot reach it.
    """

    def home_with(self, session_id):
        home = self.tmp / "home"
        (home / ".claude" / "projects").mkdir(parents=True)
        return home, self.collect(home=home, session_id=session_id)

    def test_note_path_is_named_by_session_id_under_home(self):
        home, out = self.home_with(VALID_ID)
        self.assertEqual(
            out["note_path"], str(home / ".claude" / "handoff" / f"{VALID_ID}.md")
        )

    def test_note_path_is_outside_the_repository(self):
        _, out = self.home_with(VALID_ID)
        self.assertNotIn(str(self.repo), out["note_path"])

    def test_concurrent_sessions_get_different_files(self):
        home = self.tmp / "home"
        (home / ".claude" / "projects").mkdir(parents=True)
        first = self.collect(home=home, session_id=VALID_ID)
        second = self.collect(home=home, session_id=OTHER_VALID_ID)
        self.assertNotEqual(first["note_path"], second["note_path"])

    def test_the_directory_is_created_so_the_write_cannot_fail_on_it(self):
        home, out = self.home_with(VALID_ID)
        self.assertTrue(Path(out["note_path"]).parent.is_dir())

    def test_an_unusable_id_falls_back_to_a_timestamp_not_a_path(self):
        # REJECTED_ID is traversal-shaped. It is refused as `parent=` already, and
        # it must not reach the filename either -- the id is interpolated into a
        # path here, and the newest-transcript fallback returns an unvalidated stem.
        home = self.tmp / "home"
        tdir = home / ".claude" / "projects" / "-slug"
        tdir.mkdir(parents=True)
        (tdir / "not-a-uuid.jsonl").write_text("{}\n")
        out = self.collect(home=home, transcript_dir=tdir, session_id=REJECTED_ID)
        name = Path(out["note_path"]).name
        self.assertTrue(name.startswith("unknown-"), name)
        self.assertEqual(
            Path(out["note_path"]).parent, home / ".claude" / "handoff"
        )


class TestSessionIdResolution(CollectCase):
    """The harness-exported session id must beat the directory guessed from cwd.

    A session started in the main checkout writes its transcript under the main
    checkout's slug even while its cwd is a worktree, so resolving by cwd reads
    a directory full of OTHER sessions' transcripts and returns one of them --
    a real id, silently wrong. These tests reproduce exactly that layout.
    """

    def projects(self):
        home = self.tmp / "home"
        cwd_slug = str(self.repo).replace("/", "-").replace(".", "-")
        root = home / ".claude" / "projects"
        (root / cwd_slug).mkdir(parents=True)
        (root / "-home-luca-main-checkout").mkdir()
        return home, root / cwd_slug, root / "-home-luca-main-checkout"

    def seed(self, cwd_dir, other_dir):
        """The wanted transcript elsewhere, a decoy that is NEWER in the cwd slug."""
        (other_dir / f"{VALID_ID}.jsonl").write_text("{}\n")
        time.sleep(0.01)
        (cwd_dir / f"{OTHER_VALID_ID}.jsonl").write_text("{}\n")

    def test_the_fixtures_match_the_pattern_they_stand_for(self):
        # Also guards TestNotePath: "not-a-uuid" must stay unusable as a filename.
        self.assertFalse(collect_mod.SESSION_ID_RE.match("not-a-uuid"))
        self.assertTrue(collect_mod.SESSION_ID_RE.match(VALID_ID))
        self.assertTrue(collect_mod.SESSION_ID_RE.match(OTHER_VALID_ID))
        self.assertFalse(collect_mod.SESSION_ID_RE.match(REJECTED_ID))

    def test_session_id_wins_over_the_directory_guessed_from_cwd(self):
        home, cwd_dir, other_dir = self.projects()
        self.seed(cwd_dir, other_dir)
        out = self.collect(home=home, session_id=VALID_ID)
        self.assertEqual(out["session_id"], VALID_ID)
        self.assertTrue(
            out["transcript"].startswith(str(other_dir / f"{VALID_ID}.jsonl")),
            out["transcript"],
        )

    def test_session_id_is_reported_even_when_its_file_is_missing(self):
        home, _, _ = self.projects()
        out = self.collect(home=home, session_id=VALID_ID)
        self.assertEqual(out["session_id"], VALID_ID)
        self.assertIn("no transcript file found", out["transcript"])

    def test_an_id_the_metrics_hook_could_never_match_is_ignored(self):
        # Unusable as `parent=`, so printing it would promise a recording that
        # cannot happen; the newest-transcript fallback takes over instead.
        home, cwd_dir, other_dir = self.projects()
        self.seed(cwd_dir, other_dir)
        out = self.collect(home=home, session_id=REJECTED_ID)
        self.assertEqual(out["session_id"], OTHER_VALID_ID)

    def test_without_a_session_id_it_falls_back_to_the_cwd_slug_directory(self):
        home, cwd_dir, other_dir = self.projects()
        self.seed(cwd_dir, other_dir)
        out = self.collect(home=home)
        self.assertEqual(out["session_id"], OTHER_VALID_ID)


if __name__ == "__main__":
    unittest.main()
