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

    def test_forget_this_uses_the_current_session(self):
        write_session(self.pdir, sid(1), [("the okapi", "ok")])
        self.ingest()
        os.environ["CLAUDE_CODE_SESSION_ID"] = sid(1)
        self.assertEqual(self.cli("forget", "this")[0], 0)
        self.assertEqual(self.hit_lines(self.search(sid(1), "okapi")), [])


class OptOutTest(Base):
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
