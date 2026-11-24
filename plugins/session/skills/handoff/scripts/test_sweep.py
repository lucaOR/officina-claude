#!/usr/bin/env python3
"""Tests for the handoff-note sweep. Plain stdlib unittest:
    python3 plugins/session/skills/handoff/scripts/test_sweep.py
"""
import importlib.util
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

_spec = importlib.util.spec_from_file_location(
    "sweep", Path(__file__).with_name("sweep.py"))
sweep = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sweep)


def touch(path: Path, age_seconds: float = 0) -> None:
    path.write_text("x", encoding="utf-8")
    if age_seconds:
        stamp = time.time() - age_seconds
        os.utime(path, (stamp, stamp))


class CandidatesTest(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        self.repo = Path(tempfile.mkdtemp())
        (self.repo / ".claude").mkdir()
        self._env = mock.patch.dict(os.environ, {
            "HOME": str(self.home), "CLAUDE_PROJECT_DIR": str(self.repo)})
        self._env.start()

    def tearDown(self):
        self._env.stop()

    def test_finds_home_and_repo_notes(self):
        home_handoff = self.home / ".claude" / "handoff"
        home_handoff.mkdir(parents=True)
        touch(home_handoff / "abc.md")
        touch(self.repo / ".claude" / "handoff.local.worker.md")
        touch(self.repo / ".claude" / "backlog.yaml")  # must not be picked up
        found = {p.name for p in sweep.candidates()}
        self.assertEqual(found, {"abc.md", "handoff.local.worker.md"})

    def test_missing_directories_yield_nothing(self):
        self.assertEqual(list(sweep.candidates()), [])


class SweepOneTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())

    def test_unread_note_is_left_alone(self):
        note = self.dir / "abc.md"
        touch(note)
        sweep.sweep_one(note, time.time())
        self.assertTrue(note.exists())

    def test_recently_consumed_note_survives_the_grace_period(self):
        note = self.dir / "abc.md"
        touch(note)
        touch(note.with_name(note.name + ".consumed"),
              age_seconds=sweep.GRACE_SECONDS - 60)
        sweep.sweep_one(note, time.time())
        self.assertTrue(note.exists())

    def test_note_past_grace_period_is_deleted_with_its_marker(self):
        note = self.dir / "abc.md"
        marker = note.with_name(note.name + ".consumed")
        touch(note)
        touch(marker, age_seconds=sweep.GRACE_SECONDS + 60)
        sweep.sweep_one(note, time.time())
        self.assertFalse(note.exists())
        self.assertFalse(marker.exists())


class ArchiveGateTest(unittest.TestCase):
    """Once /session:recall has run on this machine, a read note goes only after it is archived."""

    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        self.repo = Path(tempfile.mkdtemp())
        (self.repo / ".claude").mkdir()
        self._env = mock.patch.dict(os.environ, {
            "HOME": str(self.home), "CLAUDE_PROJECT_DIR": str(self.repo)})
        self._env.start()
        os.environ.pop("RECALL_HOME", None)
        self.addCleanup(self._env.stop)
        self.handoff = self.home / ".claude" / "handoff"
        self.handoff.mkdir(parents=True)
        self.archived = self.home / ".claude" / "recall" / "notes"

    def read_note(self, folder: Path, name: str) -> Path:
        note = folder / name
        touch(note)
        touch(note.with_name(name + ".consumed"), age_seconds=sweep.GRACE_SECONDS + 60)
        return note

    def test_without_a_recall_directory_the_sweep_behaves_as_before(self):
        note = self.read_note(self.handoff, "abc.md")
        sweep.sweep_one(note, time.time())
        self.assertFalse(note.exists())

    def test_read_note_without_an_archive_copy_stays(self):
        self.archived.mkdir(parents=True)
        note = self.read_note(self.handoff, "abc.md")
        sweep.sweep_one(note, time.time())
        self.assertTrue(note.exists())
        self.assertTrue(note.with_name("abc.md.consumed").exists())

    def test_read_note_with_an_archive_copy_is_deleted(self):
        self.archived.mkdir(parents=True)
        touch(self.archived / "abc.md")
        note = self.read_note(self.handoff, "abc.md")
        sweep.sweep_one(note, time.time())
        self.assertFalse(note.exists())

    def test_read_note_with_a_skip_marker_is_deleted(self):
        self.archived.mkdir(parents=True)
        touch(self.archived / "abc.skip")
        note = self.read_note(self.handoff, "abc.md")
        sweep.sweep_one(note, time.time())
        self.assertFalse(note.exists())

    def test_paired_session_notes_keep_the_old_rule(self):
        self.archived.mkdir(parents=True)
        note = self.read_note(self.repo / ".claude", "handoff.local.worker.md")
        sweep.sweep_one(note, time.time())
        self.assertFalse(note.exists())


class WiringTest(unittest.TestCase):
    """A hook not registered in the plugin's hooks/hooks.json never runs."""

    def settings(self) -> dict:
        plugin = Path(__file__).resolve().parents[3]   # scripts -> handoff -> skills -> session
        return json.loads((plugin / "hooks" / "hooks.json").read_text(encoding="utf-8"))

    def test_registered_on_sessionstart_startup_only(self):
        entries = self.settings()["hooks"]["SessionStart"]
        mine = [e for e in entries
                if any("sweep.py" in h.get("command", "") for h in e.get("hooks", []))]
        self.assertEqual(len(mine), 1, "must be registered exactly once under SessionStart")
        self.assertEqual(mine[0].get("matcher"), "startup",
                         "must not fire on resume/clear/compact, only a real new launch")


if __name__ == "__main__":
    unittest.main()
