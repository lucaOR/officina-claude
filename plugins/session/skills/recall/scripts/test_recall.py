#!/usr/bin/env python3
"""Tests for /session:recall's script. Plain stdlib unittest, synthetic transcripts only:
    cd plugins/session/skills/recall/scripts && python3 -m unittest test_recall
"""
import contextlib
import fcntl
import gzip
import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import recall  # noqa: E402

SLUG = "-work-app"


def sid(n: int) -> str:
    return f"{n:08x}-0000-4000-8000-{n:012x}"


def stamp(day: str, i: int) -> str:
    return f"{day}T10:{i // 60:02d}:{i % 60:02d}.000Z"


def write_session(pdir: Path, session: str, turns, parent=None, day="2026-11-20", blocks=None):
    """A transcript with one prompt and one reply per turn, plus bookkeeping noise."""
    pdir.mkdir(parents=True, exist_ok=True)
    entries = []
    for i, (prompt, reply) in enumerate(turns):
        if i == 0 and parent:
            prompt = f"{prompt} -- HANDOFF v1 mode=mid parent={parent}"
        entries.append({"type": "user", "timestamp": stamp(day, 2 * i),
                        "message": {"role": "user", "content": prompt}})
        entries.append({"type": "assistant", "timestamp": stamp(day, 2 * i + 1),
                        "message": {"role": "assistant",
                                    "content": [{"type": "text", "text": reply}]}})
        entries.append({"type": "api-request-blob", "blob": "noise " * 50})
    entries += blocks or []
    path = pdir / f"{session}.jsonl"
    path.write_text("".join(json.dumps(e) + "\n" for e in entries), encoding="utf-8")
    return path


class Base(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.home, True)
        self.projects = self.home / ".claude" / "projects"
        self.pdir = self.projects / SLUG
        self.pdir.mkdir(parents=True)
        env = mock.patch.dict(os.environ, {"HOME": str(self.home), "CLAUDE_PROJECT_DIR": "/work/app"})
        env.start()
        self.addCleanup(env.stop)
        for var in ("RECALL_HOME", "RECALL_DISABLE", "RECALL_NO_FTS5", "RECALL_DEPTH",
                    "RECALL_RETENTION_DAYS", "CLAUDE_CODE_SESSION_ID", "HANDOFF_TRANSCRIPT_DIR"):
            os.environ.pop(var, None)
        self.store = self.home / ".claude" / "recall"

    def cli(self, *argv, stdin=""):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), mock.patch("sys.stdin", io.StringIO(stdin)):
            code = recall.main(list(argv))
        return code, out.getvalue()

    def ingest(self, pdir=None):
        code, out = self.cli("ingest", "--project", str(pdir or self.pdir))
        self.assertEqual(code, 0, out)

    def search(self, session, *words, extra=()):
        code, out = self.cli("search", "--session", session, f"--project={SLUG}", *extra, *words)
        self.assertEqual(code, 0, out)
        return out

    def hit_lines(self, out):
        return [line for line in out.splitlines() if line.startswith("T")]


class IngestTest(Base):
    def test_archive_keeps_the_conversation_with_private_modes(self):
        write_session(self.pdir, sid(1), [("hello", "hi")])
        self.ingest()
        gz = self.store / "archive" / SLUG / f"{sid(1)}.jsonl.gz"
        with gzip.open(gz, "rt", encoding="utf-8") as fh:
            types = [json.loads(line)["type"] for line in fh]
        self.assertEqual(types, ["user", "assistant"])
        self.assertEqual(stat.S_IMODE(gz.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.store.stat().st_mode), 0o700)

    def test_note_is_copied_indexed_and_its_goal_shown(self):
        write_session(self.pdir, sid(1), [("hello widget", "hi")])
        handoff = self.home / ".claude" / "handoff"
        handoff.mkdir(parents=True)
        (handoff / f"{sid(1)}.md").write_text("HANDOFF v1\ngoal: tune the widget cache\n")
        self.ingest()
        self.assertTrue((self.store / "notes" / f"{sid(1)}.md").is_file())
        out = self.search(sid(1), "widget")
        self.assertIn("@note note", out)
        self.assertEqual(len(self.hit_lines(out)), 2)
        self.assertEqual(out.count("goal: tune the widget cache"), 1, out)

    def test_the_note_copy_is_replaced_atomically_and_follows_a_changed_note(self):
        write_session(self.pdir, sid(1), [("hello", "hi")])
        handoff = self.home / ".claude" / "handoff"
        handoff.mkdir(parents=True)
        note = handoff / f"{sid(1)}.md"
        note.write_text("first text")
        self.ingest()
        note.write_text("second text, longer")
        replaced = []
        real = os.replace
        with mock.patch.object(recall.os, "replace",
                               side_effect=lambda a, b: (replaced.append(Path(b).name), real(a, b))[1]):
            self.ingest()
        self.assertIn(f"{sid(1)}.md", replaced)
        self.assertEqual((self.store / "notes" / f"{sid(1)}.md").read_text(), "second text, longer")
        self.assertEqual(list((self.store / "notes").glob("*.tmp")), [])

    def test_skip_marker_keeps_a_session_out_and_marks_its_note(self):
        write_session(self.pdir, sid(1), [("secret plans [recall:skip]", "kept quiet")])
        handoff = self.home / ".claude" / "handoff"
        handoff.mkdir(parents=True)
        (handoff / f"{sid(1)}.md").write_text("goal: secret\n")
        self.ingest()
        self.assertFalse((self.store / "archive" / SLUG / f"{sid(1)}.jsonl.gz").exists())
        self.assertTrue((self.store / "notes" / f"{sid(1)}.skip").is_file())
        self.assertFalse((self.store / "notes" / f"{sid(1)}.md").exists())
        self.assertEqual(self.hit_lines(self.search(sid(1), "quiet")), [])

    def test_a_message_typed_mid_turn_is_archived_searchable_and_shown(self):
        queued = {"type": "attachment", "timestamp": stamp("2026-11-20", 40), "attachment": {
            "type": "queued_command", "commandMode": "prompt", "origin": {"kind": "human"},
            "prompt": "mid-turn question about the ibex"}}
        write_session(self.pdir, sid(1), [("hello", "hi")], blocks=[queued])
        self.ingest()
        hit = self.hit_lines(self.search(sid(1), "ibex"))[0]
        self.assertIn(" user | ", hit)
        code, out = self.cli("show", sid(1), hit.split(" @")[1].split()[0])
        self.assertIn("mid-turn question about the ibex", out)

    def test_skip_marker_typed_mid_turn_keeps_the_session_out(self):
        queued = {"type": "attachment", "timestamp": stamp("2026-11-20", 40), "attachment": {
            "type": "queued_command", "commandMode": "prompt", "origin": {"kind": "human"},
            "prompt": "secret [recall:skip]"}}
        write_session(self.pdir, sid(1), [("plain talk about the lynx", "ok")], blocks=[queued])
        self.ingest()
        self.assertFalse((self.store / "archive" / SLUG / f"{sid(1)}.jsonl.gz").exists())
        self.assertEqual(self.hit_lines(self.search(sid(1), "lynx")), [])

    def test_grown_transcript_replaces_its_rows(self):
        write_session(self.pdir, sid(1), [("first apple", "ok")])
        self.ingest()
        write_session(self.pdir, sid(1), [("first apple", "ok"), ("then banana", "ok")])
        self.ingest()
        self.assertEqual(len(self.hit_lines(self.search(sid(1), "apple"))), 1)
        self.assertEqual(len(self.hit_lines(self.search(sid(1), "banana"))), 1)

    def test_held_lock_makes_ingest_exit_without_work(self):
        write_session(self.pdir, sid(1), [("hello", "hi")])
        self.store.mkdir(parents=True)
        with open(self.store / "ingest.lock", "a") as fh:
            fcntl.flock(fh, fcntl.LOCK_EX)
            self.ingest()
        self.assertFalse((self.store / "archive").exists())

    def test_sessions_past_retention_are_removed(self):
        old = (datetime.now(timezone.utc) - timedelta(days=200)).strftime("%Y-%m-%d")
        write_session(self.pdir, sid(1), [("ancient walrus", "ok")], day=old)
        write_session(self.pdir, sid(2), [("recent walrus", "ok")])
        self.ingest()
        self.assertFalse((self.store / "archive" / SLUG / f"{sid(1)}.jsonl.gz").exists())
        self.assertEqual(len(self.hit_lines(self.search(sid(2), "walrus"))), 1)


    def test_subagents_are_indexed_but_recall_s_own_subagent_is_not(self):
        write_session(self.pdir, sid(1), [("hello", "hi")])
        subs = self.pdir / sid(1) / "subagents"
        write_session(subs, "agent-a1", [("look for the badger", "badger found in a.py")])
        write_session(subs, "agent-r1", [("RECALL v1 badger", "T1 badger hit")])
        (subs / "agent-r1.meta.json").write_text('{"agentType": "session:recall"}')
        self.ingest()
        hits = self.hit_lines(self.search(sid(1), "badger"))
        self.assertEqual({h.split(" @")[1].split()[1] for h in hits}, {"subagent"})
        self.assertTrue(all("agent-a1:" in h for h in hits), hits)


class RetentionTest(Base):
    def days_ago(self, n):
        return (datetime.now(timezone.utc) - timedelta(days=n)).strftime("%Y-%m-%d")

    def archived(self, slug, n):
        return (self.store / "archive" / slug / f"{sid(n)}.jsonl.gz").exists()

    def test_each_project_expires_by_its_own_recorded_value(self):
        other = self.projects / "-work-other"
        write_session(self.pdir, sid(1), [("a", "ok")], day=self.days_ago(100))
        write_session(other, sid(2), [("b", "ok")], day=self.days_ago(100))
        self.ingest(other)                      # default 180: 100 days old stays
        os.environ["RECALL_RETENTION_DAYS"] = "30"
        self.ingest()                           # this project keeps 30 days
        self.assertFalse(self.archived(SLUG, 1))
        self.assertTrue(self.archived("-work-other", 2))
        del os.environ["RECALL_RETENTION_DAYS"]
        self.ingest()                           # an ingest elsewhere never applies a foreign value
        os.environ["RECALL_RETENTION_DAYS"] = "1"
        self.ingest()
        self.assertTrue(self.archived("-work-other", 2))

    def test_zero_or_below_means_the_project_never_expires(self):
        for value in ("0", "-5"):
            os.environ["RECALL_RETENTION_DAYS"] = value
            write_session(self.pdir, sid(1), [("a", "ok")], day=self.days_ago(1000))
            self.ingest()
            self.assertTrue(self.archived(SLUG, 1), value)

    def test_a_value_that_is_not_a_number_falls_back_to_180(self):
        os.environ["RECALL_RETENTION_DAYS"] = "soon"
        write_session(self.pdir, sid(1), [("a", "ok")], day=self.days_ago(100))
        write_session(self.pdir, sid(2), [("a", "ok")], day=self.days_ago(200))
        self.ingest()
        self.assertTrue(self.archived(SLUG, 1))
        self.assertFalse(self.archived(SLUG, 2))

    def test_a_project_that_never_recorded_a_value_gets_180(self):
        write_session(self.pdir, sid(1), [("a", "ok")], day=self.days_ago(200))
        self.ingest()
        self.assertFalse(self.archived(SLUG, 1))
        with mock.patch.dict(os.environ, {"RECALL_RETENTION_DAYS": "0"}):
            self.ingest(self.projects / "-work-empty")
        self.assertEqual(recall.load_state()["projects"]["-work-empty"]["retention"], 0)


class SkippedNoteLeakTest(Base):
    """A note of a skipped session must not enter the archive through a session that read it."""
    SECRET = "the secret narwhal plan"

    def reader(self, session, command_blocks):
        calls, results = [], []
        for i, (name, args) in enumerate(command_blocks):
            calls.append({"type": "tool_use", "id": f"t{i}", "name": name, "input": args})
            results.append({"type": "tool_result", "tool_use_id": f"t{i}", "content": self.SECRET})
        blocks = [{"type": "assistant", "timestamp": stamp("2026-11-20", 40),
                   "message": {"content": calls}},
                  {"type": "user", "timestamp": stamp("2026-11-20", 41),
                   "message": {"content": results}}]
        write_session(self.pdir, session, [("read the note", "ok")], blocks=blocks)

    def archive_text(self, session):
        with gzip.open(self.store / "archive" / SLUG / f"{session}.jsonl.gz", "rt") as fh:
            return fh.read()

    def test_the_note_text_is_left_out_whatever_order_the_sessions_are_ingested_in(self):
        note = str(self.home / ".claude" / "handoff" / f"{sid(2)}.md")
        # The reader sorts first, so it is ingested before its writer's skip marker exists.
        self.reader(sid(1), [("Read", {"file_path": note}),
                             ("Bash", {"command": f"sed -n 1,20p {note}"}),
                             ("Bash", {"command": f"cat ~/.claude/handoff/{sid(2)}.md"})])
        write_session(self.pdir, sid(2), [("plans [recall:skip]", "ok")])
        self.ingest()
        self.assertEqual(self.hit_lines(self.search(sid(1), "narwhal")), [])
        text = self.archive_text(sid(1))
        self.assertNotIn(self.SECRET, text)
        self.assertEqual(text.count("[left out: note of a skipped session]"), 3)
        self.assertIn("sed -n 1,20p", text)          # the calls themselves stay

    def test_the_note_of_an_ordinary_session_is_kept(self):
        note = str(self.home / ".claude" / "handoff" / f"{sid(2)}.md")
        self.reader(sid(1), [("Read", {"file_path": note})])
        write_session(self.pdir, sid(2), [("plain plans", "ok")])
        self.ingest()
        self.assertEqual(len(self.hit_lines(self.search(sid(1), "narwhal"))), 1)

    def test_a_forgotten_writer_counts_as_skipped(self):
        note = str(self.home / ".claude" / "handoff" / f"{sid(2)}.md")
        self.reader(sid(1), [("Read", {"file_path": note})])
        write_session(self.pdir, sid(2), [("plain plans", "ok")])
        recall.save_json("deny.json", [sid(2)])
        self.ingest()
        self.assertEqual(self.hit_lines(self.search(sid(1), "narwhal")), [])


    def test_two_reads_of_one_note_check_the_writer_once(self):
        note = str(self.home / ".claude" / "handoff" / f"{sid(2)}.md")
        self.reader(sid(1), [("Read", {"file_path": note}), ("Bash", {"command": f"cat {note}"})])
        write_session(self.pdir, sid(2), [("plain plans", "ok")])
        with mock.patch.object(recall, "skipped_session", wraps=recall.skipped_session) as spy:
            self.ingest()
        self.assertEqual([c.args[0] for c in spy.call_args_list].count(sid(2)), 1)


class LateExclusionTest(Base):
    """A writer excluded after its reader was ingested must still be scrubbed out of the reader."""
    SECRET = SkippedNoteLeakTest.SECRET
    reader = SkippedNoteLeakTest.reader
    archive_text = SkippedNoteLeakTest.archive_text
    PLACEHOLDER = "[left out: note of a skipped session]"

    def read_first(self):
        note = str(self.home / ".claude" / "handoff" / f"{sid(2)}.md")
        self.reader(sid(1), [("Read", {"file_path": note})])
        write_session(self.pdir, sid(2), [("plain plans", "ok")])
        self.ingest()
        self.assertEqual(len(self.hit_lines(self.search(sid(1), "narwhal"))), 1)

    def assert_scrubbed(self):
        self.assertEqual(self.hit_lines(self.search(sid(1), "narwhal")), [])
        text = self.archive_text(sid(1))
        self.assertNotIn(self.SECRET, text)
        self.assertIn(self.PLACEHOLDER, text)
        code, out = self.cli("show", sid(1), "2")
        self.assertNotIn(self.SECRET, out)

    def test_forgetting_the_writer_scrubs_a_reader_ingested_earlier(self):
        self.read_first()
        self.assertEqual(self.cli("forget", sid(2))[0], 0)
        self.assert_scrubbed()

    def test_it_works_when_the_readers_transcript_is_gone(self):
        self.read_first()
        (self.pdir / f"{sid(1)}.jsonl").unlink()
        self.cli("forget", sid(2))
        self.assert_scrubbed()

    def test_a_writer_found_to_be_skip_marked_on_a_later_ingest_scrubs_its_readers(self):
        self.read_first()
        write_session(self.pdir, sid(2), [("plans [recall:skip]", "ok")])
        self.ingest()
        self.assert_scrubbed()

    def test_a_writer_on_the_deny_list_scrubs_its_readers_when_ingested(self):
        self.read_first()
        recall.save_json("deny.json", [sid(2)])
        write_session(self.pdir, sid(2), [("plain plans again", "ok")])
        self.ingest()
        self.assert_scrubbed()

    def test_rebuild_keeps_the_placeholder_and_the_scrub_still_works_after_it(self):
        self.read_first()
        write_session(self.pdir, sid(2), [("plans [recall:skip]", "ok")])
        self.ingest()
        self.assertEqual(self.cli("rebuild")[0], 0)
        self.assert_scrubbed()

    def test_rebuild_relearns_who_read_whose_note(self):
        self.read_first()
        self.assertEqual(self.cli("rebuild")[0], 0)
        self.cli("forget", sid(2))
        self.assert_scrubbed()


class SearchTest(Base):
    def test_hit_in_the_parent_reports_its_distance(self):
        write_session(self.pdir, sid(1), [("the zebra bug", "fixed")])
        write_session(self.pdir, sid(2), [("continue", "ok")], parent=sid(1))
        self.ingest()
        hits = self.hit_lines(self.search(sid(2), "zebra"))
        self.assertEqual(len(hits), 1)
        self.assertTrue(hits[0].startswith("T1 1 back"), hits[0])
        self.assertIn(sid(1), hits[0])

    def test_rest_of_project_is_searched_only_below_5_chain_rows(self):
        write_session(self.pdir, sid(1), [(f"lantern {i}", "ok") for i in range(5)])
        write_session(self.pdir, sid(2), [("continue", "ok")], parent=sid(1))
        write_session(self.pdir, sid(3), [("unrelated lantern", "ok")])
        write_session(self.pdir, sid(4), [("one lantern", "ok")])
        write_session(self.pdir, sid(5), [("continue", "ok")], parent=sid(4))
        self.ingest()
        self.assertFalse(any(h.startswith("T2") for h in self.hit_lines(self.search(sid(2), "lantern"))))
        self.assertTrue(any(h.startswith("T2") for h in self.hit_lines(self.search(sid(5), "lantern"))))

    def test_asking_session_rows_do_not_hold_the_search_in_tier_1(self):
        # The asking session repeats its own question, so its rows must not count as the chain
        # having enough matches; they still show up as its own tier 1 hits.
        write_session(self.pdir, sid(1), [("start", "ok")])
        write_session(self.pdir, sid(2), [(f"what about the lantern {i}?", "looking") for i in range(5)],
                      parent=sid(1))
        write_session(self.pdir, sid(3), [("the lantern fix was a flag", "ok")])
        self.ingest()
        hits = self.hit_lines(self.search(sid(2), "lantern"))
        self.assertTrue(any(h.startswith("T2") and sid(3) in h for h in hits), hits)
        self.assertTrue(any(h.startswith("T1 this session") for h in hits), hits)

    def test_other_projects_only_with_all(self):
        other = self.projects / "-work-other"
        write_session(other, sid(9), [("the quokka", "ok")])
        write_session(self.pdir, sid(1), [("hello", "hi")])
        self.ingest(other)
        self.ingest()
        self.assertEqual(self.hit_lines(self.search(sid(1), "quokka")), [])
        hits = self.hit_lines(self.search(sid(1), "quokka", extra=("--all",)))
        self.assertTrue(hits and hits[0].startswith("T3"), hits)

    def test_rest_of_project_covers_directories_the_chain_touched(self):
        worktree = self.projects / "-work-app-wt"
        write_session(worktree, sid(1), [("started here", "ok")])
        write_session(worktree, sid(3), [("sibling heron", "ok")])
        write_session(self.pdir, sid(2), [("continue", "ok")], parent=sid(1))
        self.ingest(worktree)
        self.ingest()
        hits = self.hit_lines(self.search(sid(2), "heron"))
        self.assertTrue(hits and hits[0].startswith("T2"), hits)

    def test_wordings_merge_before_rows_are_counted(self):
        write_session(self.pdir, sid(1), [("alpha beta together", "ok")])
        self.ingest()
        out = self.search(sid(1), "alpha", "beta")
        self.assertIn("recall: 1 hit ", out)

    def test_output_is_capped_at_40_hits_of_300_characters(self):
        long = "needle " + "word " * 200
        write_session(self.pdir, sid(1), [(long, "needle too") for _ in range(30)])
        self.ingest()
        hits = self.hit_lines(self.search(sid(1), "needle"))
        self.assertEqual(len(hits), 40)
        self.assertTrue(all(len(h.split(" | ")[-1]) <= 300 for h in hits))

    def test_search_ingests_its_own_chain_across_directories(self):
        worktree = self.projects / "-work-app-wt"
        write_session(worktree, sid(1), [("far ocelot", "ok")])
        write_session(self.pdir, sid(2), [("near ocelot", "ok")], parent=sid(1))
        out = self.search(sid(2), "ocelot")
        self.assertEqual(len(self.hit_lines(out)), 2)
        self.assertIn("results may be incomplete", out)

    def test_wordings_come_from_stdin_one_per_line(self):
        write_session(self.pdir, sid(1), [("the `$(id)` quirk with gnu", "ok"), ("a heron", "ok")])
        self.ingest()
        code, out = self.cli("search", "--session", sid(1), f"--project={SLUG}", "--stdin",
                             stdin="heron\n\n  `$(id)` quirk  \n")
        self.assertEqual(code, 0, out)
        self.assertEqual(len(self.hit_lines(out)), 2, out)
        self.assertIn('"heron" | "`$(id)` quirk"', out)

    def test_positional_wordings_still_work_and_add_to_stdin(self):
        write_session(self.pdir, sid(1), [("a heron", "ok"), ("an egret", "ok")])
        self.ingest()
        code, out = self.cli("search", "--session", sid(1), f"--project={SLUG}", "--stdin",
                             "heron", stdin="egret\n")
        self.assertEqual(len(self.hit_lines(out)), 2, out)

    def test_a_search_with_no_wording_at_all_is_a_usage_error(self):
        with self.assertRaises(SystemExit):
            with contextlib.redirect_stderr(io.StringIO()):
                self.cli("search", "--session", sid(1))

    def test_the_agent_passes_the_wordings_through_a_quoted_heredoc(self):
        agent = (HERE.parents[2] / "agents" / "recall.md").read_text(encoding="utf-8")
        self.assertIn("--stdin <<'RECALL_WORDINGS'", agent)
        self.assertNotIn('"<query>" "<wording 2>"', agent)

    def test_a_query_without_word_characters_says_so_and_does_not_blame_the_index(self):
        write_session(self.pdir, sid(1), [("the heron", "ok")])
        self.ingest()
        for no_fts in (False, True):
            with mock.patch.dict(os.environ, {"RECALL_NO_FTS5": "1"} if no_fts else {}):
                code, out = self.cli("search", "--session", sid(1), f"--project={SLUG}", "?!", "...")
            self.assertEqual(code, 0, out)
            self.assertIn("note: the query has no searchable words", out)
            self.assertNotIn("rebuild", out)
            self.assertEqual(self.hit_lines(out), [])

    def test_a_wording_without_words_is_dropped_next_to_a_good_one(self):
        write_session(self.pdir, sid(1), [("the heron", "ok")])
        self.ingest()
        out = self.search(sid(1), "?!", "heron")
        self.assertEqual(len(self.hit_lines(out)), 1, out)
        self.assertNotIn("?!", out)

    def test_without_fts5_the_search_scans_and_says_so(self):
        os.environ["RECALL_NO_FTS5"] = "1"
        write_session(self.pdir, sid(1), [("plain Gecko", "ok")])
        self.ingest()
        out = self.search(sid(1), "gecko")
        self.assertEqual(len(self.hit_lines(out)), 1)
        self.assertIn("unranked", out)

    def test_unreadable_index_points_at_rebuild(self):
        write_session(self.pdir, sid(1), [("the mongoose", "ok")])
        self.ingest()
        for f in self.store.glob("index.sqlite*"):
            f.unlink()
        (self.store / "index.sqlite").write_bytes(b"not a database" * 100)
        code, out = self.cli("search", "--session", sid(1), f"--project={SLUG}", "mongoose")
        self.assertEqual(code, 1)
        self.assertIn("rebuild", out)
        self.assertEqual(self.cli("rebuild")[0], 0)
        self.assertEqual(len(self.hit_lines(self.search(sid(1), "mongoose"))), 1)

    def test_disabled_project_searches_nothing(self):
        os.environ["RECALL_DISABLE"] = "1"
        write_session(self.pdir, sid(1), [("the yak", "ok")])
        out = self.search(sid(1), "yak")
        self.assertIn("disabled", out)
        self.assertEqual(self.hit_lines(out), [])


class DateTest(Base):
    """`--on` puts the hits of a named day or period first, because a live run answered a
    dated question with a later session's finding."""

    def first_hit(self, out):
        return self.hit_lines(out)[0]

    def test_on_ranks_that_days_hits_above_a_stronger_later_hit(self):
        write_session(self.pdir, sid(1), [("the heron question", "no idea yet")], day="2026-11-06")
        write_session(self.pdir, sid(2), [("heron heron heron", "the heron answer")], day="2026-11-09")
        write_session(self.pdir, sid(3), [("start", "ok")], day="2026-11-24")
        self.ingest()
        self.assertIn(sid(2), self.first_hit(self.search(sid(3), "heron")))
        self.assertIn(sid(1), self.first_hit(self.search(sid(3), "heron", extra=("--on", "2026-11-06"))))

    def test_on_counts_only_that_days_chain_rows_before_widening(self):
        write_session(self.pdir, sid(1), [(f"lantern {i}", "ok") for i in range(5)], day="2026-11-20")
        write_session(self.pdir, sid(2), [("continue", "ok")], parent=sid(1), day="2026-11-24")
        write_session(self.pdir, sid(3), [("the lantern was unplugged", "ok")], day="2026-11-06")
        self.ingest()
        self.assertFalse(any(sid(3) in h for h in self.hit_lines(self.search(sid(2), "lantern"))))
        out = self.search(sid(2), "lantern", extra=("--on", "2026-11-06"))
        self.assertIn(sid(3), self.first_hit(out))

    def test_on_takes_a_period_and_the_header_counts_its_hits(self):
        for n, day in ((1, "2026-11-02"), (2, "2026-11-05"), (3, "2026-11-12")):
            write_session(self.pdir, sid(n), [(f"heron {n}", "ok")], day=day)
        write_session(self.pdir, sid(4), [("start", "ok")], day="2026-11-24")
        self.ingest()
        out = self.search(sid(4), "heron", extra=("--on", "2026-11-04..2026-11-10"))
        self.assertIn("on 2026-11-04..2026-11-10: 1", out.splitlines()[0])
        self.assertIn(sid(2), self.first_hit(out))

    def test_a_day_without_hits_says_so_and_still_lists_the_others(self):
        write_session(self.pdir, sid(1), [("heron", "ok")], day="2026-11-09")
        write_session(self.pdir, sid(2), [("start", "ok")], day="2026-11-24")
        self.ingest()
        out = self.search(sid(2), "heron", extra=("--on", "2026-11-06"))
        self.assertIn("note: no hits on 2026-11-06", out)
        self.assertIn(sid(1), self.first_hit(out))

    def test_a_malformed_date_is_a_usage_error(self):
        code, out = self.cli("search", "--session", sid(1), f"--project={SLUG}", "--on", "6/11", "heron")
        self.assertEqual(code, 2)
        self.assertIn("YYYY-MM-DD", out)


class ShowTest(Base):
    def test_show_returns_the_exchange_with_the_full_tool_result(self):
        blocks = [
            {"type": "assistant", "timestamp": stamp("2026-11-20", 50), "message": {"content": [
                {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "cat log"}}]}},
            {"type": "user", "timestamp": stamp("2026-11-20", 51), "message": {"content": [
                {"type": "tool_result", "tool_use_id": "t1",
                 "content": "pelican start " + "x" * 5000 + " END-OF-LOG"}]}}]
        write_session(self.pdir, sid(1), [("hello", "hi")], blocks=blocks)
        self.ingest()
        hit = self.hit_lines(self.search(sid(1), "pelican"))[0]
        pos = hit.split(" @")[1].split()[0]
        code, out = self.cli("show", sid(1), pos)
        self.assertEqual(code, 0)
        self.assertIn("END-OF-LOG", out)
        self.assertIn("cat log", out)


class ForgetTest(Base):
    def test_forget_removes_the_session_and_later_ingests_skip_it(self):
        write_session(self.pdir, sid(1), [("the narwhal", "ok")])
        self.ingest()
        code, out = self.cli("forget", sid(1))
        self.assertEqual(code, 0)
        self.assertIn("original transcript stays", out)
        self.assertFalse((self.store / "archive" / SLUG / f"{sid(1)}.jsonl.gz").exists())
        write_session(self.pdir, sid(1), [("the narwhal", "ok"), ("more", "ok")])
        self.ingest()
        self.assertEqual(self.hit_lines(self.search(sid(1), "narwhal")), [])
        self.assertFalse((self.store / "archive" / SLUG / f"{sid(1)}.jsonl.gz").exists())

    def test_forget_deletes_the_archive_even_when_the_index_has_no_row(self):
        write_session(self.pdir, sid(1), [("the numbat", "ok")], blocks=[])
        self.ingest()
        for f in self.store.glob("index.sqlite*"):
            f.unlink()
        sub = self.store / "archive" / SLUG / sid(1) / "subagents"
        sub.mkdir(parents=True)
        (sub / "a.jsonl.gz").write_bytes(b"x")
        self.assertEqual(self.cli("forget", sid(1))[0], 0)
        self.assertFalse((self.store / "archive" / SLUG / f"{sid(1)}.jsonl.gz").exists())
        self.assertFalse((self.store / "archive" / SLUG / sid(1)).exists())

    def test_forget_this_uses_the_current_session(self):
        write_session(self.pdir, sid(1), [("the okapi", "ok")])
        self.ingest()
        os.environ["CLAUDE_CODE_SESSION_ID"] = sid(1)
        self.assertEqual(self.cli("forget", "this")[0], 0)
        self.assertEqual(self.hit_lines(self.search(sid(1), "okapi")), [])


class ChainTest(Base):
    """A chain walk must pass through a session whose content is gone."""

    def make_chain(self):
        write_session(self.pdir, sid(1), [("the ancient lemur", "ok")])
        write_session(self.pdir, sid(2), [("middle step", "ok")], parent=sid(1))
        write_session(self.pdir, sid(3), [("latest step", "ok")], parent=sid(2))
        self.ingest()

    def assert_reaches_the_root(self):
        hits = self.hit_lines(self.search(sid(3), "lemur"))
        self.assertEqual(len(hits), 1, hits)
        self.assertTrue(hits[0].startswith("T1 2 back"), hits[0])

    def assert_middle_is_content_free(self):
        self.assertEqual(self.hit_lines(self.search(sid(3), "middle")), [])
        ix = recall.Index()
        row = ix.db.execute("SELECT project, parent, title, goal, note, excluded, row_lo "
                            "FROM session WHERE id = ?", (sid(2),)).fetchone()
        self.assertEqual(row, (SLUG, sid(1), None, None, None, 1, None))

    def test_forget_keeps_the_id_and_parent_link(self):
        self.make_chain()
        self.cli("forget", sid(2))
        self.assert_reaches_the_root()
        self.assert_middle_is_content_free()

    def test_forget_without_an_index_row_recovers_the_parent_from_the_transcript(self):
        self.make_chain()
        for f in self.store.glob("index.sqlite*"):
            f.unlink()
        self.cli("forget", sid(2))
        self.assertEqual(recall.read_marker(sid(2)), {"parent": sid(1), "project": SLUG})
        self.assertEqual(self.cli("rebuild")[0], 0)
        self.assert_reaches_the_root()
        self.assert_middle_is_content_free()

    def test_a_denied_session_that_grows_stays_a_link(self):
        self.make_chain()
        self.cli("forget", sid(2))
        write_session(self.pdir, sid(2), [("middle step", "ok"), ("more", "ok")], parent=sid(1))
        self.ingest()
        self.assert_reaches_the_root()
        self.assert_middle_is_content_free()

    def test_rebuild_recreates_the_links_of_forgotten_and_skipped_sessions(self):
        write_session(self.pdir, sid(1), [("the ancient lemur", "ok")])
        write_session(self.pdir, sid(2), [("middle [recall:skip]", "ok")], parent=sid(1))
        write_session(self.pdir, sid(3), [("latest step", "ok")], parent=sid(2))
        write_session(self.pdir, sid(4), [("forgotten step", "ok")], parent=sid(3))
        write_session(self.pdir, sid(5), [("newest step", "ok")], parent=sid(4))
        self.ingest()
        self.cli("forget", sid(4))
        self.assertEqual(self.cli("rebuild")[0], 0)
        hits = self.hit_lines(self.search(sid(5), "lemur"))
        self.assertEqual(len(hits), 1, hits)
        self.assertTrue(hits[0].startswith("T1 4 back"), hits[0])
        self.assertEqual(self.hit_lines(self.search(sid(5), "forgotten")), [])


class RebuildTest(Base):
    def test_rebuild_does_not_bring_back_a_forgotten_session(self):
        write_session(self.pdir, sid(1), [("the dugong", "ok")])
        write_session(self.pdir, sid(2), [("the dugong too", "ok")])
        self.ingest()
        recall.save_json("deny.json", [sid(1)])     # a forget whose archive deletion failed
        self.assertEqual(self.cli("rebuild")[0], 0)
        hits = self.hit_lines(self.search(sid(2), "dugong"))
        self.assertEqual(len(hits), 1)
        self.assertIn(sid(2), hits[0])

    def test_rebuild_skips_opted_out_projects(self):
        write_session(self.pdir, sid(1), [("the dugong", "ok")])
        self.ingest()
        recall.record_optout(SLUG)
        self.assertEqual(self.cli("rebuild")[0], 0)
        recall.record_optout(SLUG, False)      # re-enabled: only the rebuild could have kept rows
        self.assertEqual(self.hit_lines(self.search(sid(1), "dugong")), [])


class OptOutTest(Base):
    def test_search_hides_an_opted_out_project_before_its_purge_has_run(self):
        other = self.projects / "-work-other"
        write_session(other, sid(9), [("the quokka", "ok")])
        write_session(self.pdir, sid(1), [("hello quokka", "hi")], parent=sid(9))
        self.ingest(other)
        self.ingest()
        recall.record_optout("-work-other")           # recorded, purge not yet run
        for extra in ((), ("--all",)):
            hits = self.hit_lines(self.search(sid(1), "quokka", extra=extra))
            self.assertEqual([h.split(" @")[0].split(" | ")[-1] for h in hits], [sid(1)], hits)

    def test_opted_out_project_is_purged_and_not_fetched_from_elsewhere(self):
        write_session(self.pdir, sid(1), [("the tapir", "ok")])
        self.ingest()
        os.environ["RECALL_DISABLE"] = "1"
        recall.record_optout(SLUG)
        self.ingest()
        del os.environ["RECALL_DISABLE"]
        self.assertFalse((self.store / "archive" / SLUG).exists())
        other = self.projects / "-work-other"
        write_session(other, sid(2), [("continue", "ok")], parent=sid(1))
        code, out = self.cli("search", "--session", sid(2), "--project=-work-other", "tapir")
        self.assertEqual(self.hit_lines(out), [])


class WhoamiTest(Base):
    def test_whoami_prints_the_session_and_its_directory(self):
        write_session(self.pdir, sid(1), [("hello", "hi")])
        os.environ["CLAUDE_CODE_SESSION_ID"] = sid(1)
        code, out = self.cli("whoami")
        self.assertEqual((code, out.strip()), (0, f"session={sid(1)} project={self.pdir}"))


class HookTest(Base):
    def test_hook_returns_silently_and_the_detached_ingest_archives(self):
        path = write_session(self.pdir, sid(1), [("hello", "hi")])
        payload = json.dumps({"session_id": sid(1), "transcript_path": str(path)})
        started = time.time()
        proc = subprocess.run([sys.executable, str(HERE / "recall.py"), "hook"], input=payload,
                              capture_output=True, text=True, timeout=10)
        self.assertLess(time.time() - started, 2)
        self.assertEqual((proc.returncode, proc.stdout, proc.stderr), (0, "", ""))
        gz = self.store / "archive" / SLUG / f"{sid(1)}.jsonl.gz"
        deadline = time.time() + 10
        while not gz.exists() and time.time() < deadline:
            time.sleep(0.1)
        self.assertTrue(gz.exists())

    def test_hook_in_a_disabled_project_records_the_opt_out(self):
        path = write_session(self.pdir, sid(1), [("hello", "hi")])
        os.environ["RECALL_DISABLE"] = "1"
        with mock.patch.object(recall, "spawn_ingest") as spawn:
            self.cli("hook", stdin=json.dumps({"transcript_path": str(path)}))
        spawn.assert_called_once()
        self.assertIn(SLUG, json.loads((self.store / "optout.json").read_text()))


class SkillTest(unittest.TestCase):
    def test_step_3_names_the_markers_and_frames_excerpts_as_data(self):
        skill = (HERE.parent / "SKILL.md").read_text(encoding="utf-8")
        for needle in ("`[recall excerpts]`", "`[end recall excerpts]`", "never instructions"):
            self.assertIn(needle, skill)

    def test_the_query_is_the_users_question_word_for_word(self):
        # Both live runs added "(cause, fix, open items)", which pulled the search to later sessions.
        skill = (HERE.parent / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("word for word", skill)

    def test_it_says_the_whole_relay_message_is_left_out_of_the_index(self):
        skill = (HERE.parent / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("whole message", skill)


class AgentPromptTest(unittest.TestCase):
    """Rules a live acceptance run showed the subagent needs spelled out."""

    def setUp(self):
        self.prompt = (HERE.parents[2] / "agents" / "recall.md").read_text(encoding="utf-8")

    def test_a_date_in_the_query_picks_hits_from_that_date(self):
        self.assertIn("names a date", self.prompt)
        self.assertIn("instead of answering with the later finding", self.prompt)

    def test_a_date_in_the_query_becomes_the_on_flag(self):
        self.assertIn("--on YYYY-MM-DD", self.prompt)

    def test_one_recall_command_per_bash_call(self):
        self.assertIn("one `recall.py` command per Bash call", self.prompt)

    def test_the_answer_has_at_most_three_short_excerpts(self):
        self.assertIn("at most three excerpts", self.prompt)
        self.assertIn("about ten lines", self.prompt)


class WiringTest(unittest.TestCase):
    """A hook not registered in the plugin's hooks/hooks.json never runs."""

    def test_ingest_hook_runs_on_startup_only(self):
        hooks = json.loads((HERE.parents[2] / "hooks" / "hooks.json").read_text())["hooks"]
        mine = [(event, group.get("matcher"), h["command"]) for event, groups in hooks.items()
                for group in groups for h in group["hooks"] if "recall.py" in h["command"]]
        self.assertEqual(mine, [("SessionStart", "startup",
                                 'python3 "${CLAUDE_PLUGIN_ROOT}/skills/recall/scripts/recall.py" hook')])


if __name__ == "__main__":
    unittest.main()
