#!/usr/bin/env python3
"""Tests for the recall transcript parser. Plain stdlib unittest, synthetic entries only:
    cd plugins/session/skills/recall/scripts && python3 -m unittest test_transcript
"""
import gzip
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import transcript as tr  # noqa: E402

PARENT = "11afcc13-257b-474e-ac82-9c25daaca682"


def user(content, **kw):
    return {"type": "user", "timestamp": kw.pop("ts", "2026-11-01T10:00:00.000Z"),
            "message": {"role": "user", "content": content}, **kw}


def assistant(*blocks, ts="2026-11-01T10:00:05.000Z"):
    return {"type": "assistant", "timestamp": ts,
            "message": {"role": "assistant", "content": list(blocks)}}


class RealPromptTest(unittest.TestCase):
    def test_typed_prompt_is_real(self):
        self.assertEqual(tr.real_prompt(user("fix the parser")), "fix the parser")

    def test_meta_entries_are_not_prompts(self):
        self.assertIsNone(tr.real_prompt(user("Base directory for this skill", isMeta=True)))

    def test_command_wrappers_and_notifications_are_not_prompts(self):
        for text in ("<command-name>/clear</command-name>",
                     "<command-message>session:handoff</command-message>",
                     "<local-command-stdout></local-command-stdout>",
                     "<task-notification>\n<task-id>x</task-id>"):
            self.assertIsNone(tr.real_prompt(user(text)), text)

    def test_system_reminders_are_stripped(self):
        e = user([{"type": "text", "text": "<system-reminder>noise</system-reminder>"},
                  {"type": "text", "text": "the real ask"}])
        self.assertEqual(tr.real_prompt(e), "the real ask")

    def test_tool_results_are_not_prompts(self):
        e = user([{"type": "tool_result", "tool_use_id": "t", "content": "out"}])
        self.assertIsNone(tr.real_prompt(e))


class KeepTest(unittest.TestCase):
    def test_conversation_entries_stay_and_bookkeeping_goes(self):
        entries = [{"type": t} for t in (
            "user", "assistant", "system", "summary", "custom-title", "ai-title",
            "api-request-blob", "api-request", "attachment", "file-history-snapshot", "mode")]
        self.assertEqual([e["type"] for e in tr.keep(entries)],
                         ["user", "assistant", "system", "summary", "custom-title", "ai-title"])

    def test_duplicate_tool_result_payload_is_dropped(self):
        e = user([{"type": "tool_result", "tool_use_id": "t", "content": "out"}],
                 toolUseResult={"stdout": "out"})
        self.assertNotIn("toolUseResult", tr.keep([e])[0])


class RowsTest(unittest.TestCase):
    def test_each_block_becomes_a_row_with_its_role_and_position(self):
        kept = [user("fix the parser"),
                assistant({"type": "thinking", "thinking": "hidden"},
                          {"type": "text", "text": "Looking."},
                          {"type": "tool_use", "name": "Bash", "input": {"command": "ls"}}),
                user([{"type": "tool_result", "tool_use_id": "t",
                       "content": [{"type": "text", "text": "a.py"}]}])]
        rows = tr.rows(kept)
        self.assertEqual([(r[0], r[1], r[3]) for r in rows], [
            ("user", "0", "fix the parser"),
            ("assistant", "1", "Looking."),
            ("tool_use", "1", 'Bash {"command": "ls"}'),
            ("tool_result", "2", "a.py")])
        self.assertEqual(rows[0][2], "2026-11-01T10:00:00.000Z")

    def test_tool_input_and_result_are_cut_to_2_kb(self):
        kept = [assistant({"type": "tool_use", "name": "Write", "input": {"x": "y" * 5000}}),
                user([{"type": "tool_result", "tool_use_id": "t", "content": "z" * 5000}])]
        self.assertEqual([len(r[3]) for r in tr.rows(kept)], [tr.CUT, tr.CUT])

    def test_subagent_rows_carry_the_subagent_role_and_file(self):
        rows = tr.rows([assistant({"type": "text", "text": "found it"})], subagent="agent-a1")
        self.assertEqual(rows, [("subagent", "agent-a1:0", "2026-11-01T10:00:05.000Z", "found it")])


    def test_recall_traffic_is_not_indexed(self):
        kept = [assistant({"type": "tool_use", "id": "a", "name": "Agent",
                           "input": {"subagent_type": "session:recall", "prompt": "RECALL v1 x"}},
                          {"type": "tool_use", "id": "b", "name": "Bash",
                           "input": {"command": "python3 recall.py search parser"}},
                          {"type": "tool_use", "id": "c", "name": "Bash", "input": {"command": "ls"}}),
                user([{"type": "tool_result", "tool_use_id": "a", "content": "old parser notes"},
                      {"type": "tool_result", "tool_use_id": "b", "content": "T1 hit parser"},
                      {"type": "tool_result", "tool_use_id": "c", "content": "a.py"}])]
        self.assertEqual([r[3] for r in tr.rows(kept)], ['Bash {"command": "ls"}', "a.py"])


class MetaTest(unittest.TestCase):
    def test_parent_comes_from_the_first_real_prompt(self):
        kept = [user("<command-name>/clear</command-name>"),
                user(f"read the note -- HANDOFF v1 mode=mid parent={PARENT}"),
                assistant({"type": "text", "text": "ok"}, ts="2026-11-01T11:00:00.000Z")]
        m = tr.meta(kept)
        self.assertEqual(m["parent"], PARENT)
        self.assertEqual((m["started"], m["ended"]),
                         ("2026-11-01T10:00:00.000Z", "2026-11-01T11:00:00.000Z"))

    def test_a_later_pointer_does_not_make_a_parent(self):
        kept = [user("start cold"), user(f"HANDOFF v1 mode=mid parent={PARENT}")]
        self.assertIsNone(tr.meta(kept)["parent"])

    def test_rename_title_wins_over_the_generated_title(self):
        kept = [{"type": "ai-title", "aiTitle": "generated"},
                {"type": "custom-title", "customTitle": "named"},
                {"type": "ai-title", "aiTitle": "generated later"}]
        self.assertEqual(tr.meta(kept)["title"], "named")

    def test_skip_marker_counts_only_in_a_real_prompt(self):
        self.assertTrue(tr.meta([user("secret stuff [recall:skip]")])["skip"])
        self.assertFalse(tr.meta([user("mentions [recall:skip]", isMeta=True)])["skip"])


class ReadEntriesTest(unittest.TestCase):
    def test_malformed_lines_are_skipped_and_gzip_is_read(self):
        d = Path(tempfile.mkdtemp())
        body = '{"type": "user"}\nnot json\n\n{"type": "assistant"}\n'
        (d / "a.jsonl").write_text(body, encoding="utf-8")
        with gzip.open(d / "a.jsonl.gz", "wt", encoding="utf-8") as fh:
            fh.write(body)
        for name in ("a.jsonl", "a.jsonl.gz"):
            self.assertEqual([e["type"] for e in tr.read_entries(d / name)], ["user", "assistant"])

    def test_a_missing_file_yields_nothing(self):
        self.assertEqual(list(tr.read_entries(Path("/nonexistent/x.jsonl"))), [])


if __name__ == "__main__":
    unittest.main()
