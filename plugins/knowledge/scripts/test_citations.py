import json
import tempfile
import unittest
from pathlib import Path

import citations
import ledger
import usage


def _rec(rtype, role, blocks, ts="2026-08-18T10:00:00.000Z", session="s1"):
    return json.dumps({"type": rtype, "sessionId": session, "timestamp": ts,
                       "message": {"role": role, "content": blocks}})


class TestAssistantTexts(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def _write(self, *lines):
        p = self.root / "t.jsonl"
        p.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return p

    def test_keeps_assistant_text_blocks(self):
        p = self._write(_rec("assistant", "assistant", [{"type": "text", "text": "hi"}]))
        self.assertEqual([t for _, _, t in citations.assistant_texts(p)], ["hi"])

    def test_drops_tool_results(self):
        # check.py stdout lands here. Counting it turns every hook firing into a
        # citation of whatever the hook printed.
        p = self._write(_rec("user", "user",
                             [{"type": "tool_result", "content": "hub/x#y"}]))
        self.assertEqual(citations.assistant_texts(p), [])

    def test_drops_thinking_blocks(self):
        p = self._write(_rec("assistant", "assistant",
                             [{"type": "thinking", "thinking": "hub/x#y"}]))
        self.assertEqual(citations.assistant_texts(p), [])

    def test_drops_attachments(self):
        # The digest is an attachment and lists every fqid on its `also:` lines, so
        # counting attachments makes every session cite all 339 rules.
        p = self._write(json.dumps({"type": "attachment",
                                    "content": "also: hub/x#y"}))
        self.assertEqual(citations.assistant_texts(p), [])

    def test_skips_malformed_lines(self):
        p = self._write("{not json",
                        _rec("assistant", "assistant", [{"type": "text", "text": "ok"}]))
        self.assertEqual([t for _, _, t in citations.assistant_texts(p)], ["ok"])

    def test_timestamp_is_normalised_to_ledger_shape(self):
        p = self._write(_rec("assistant", "assistant", [{"type": "text", "text": "hi"}]))
        self.assertEqual(citations.assistant_texts(p)[0][0], "2026-08-18T10:00:00")


class TestCountIn(unittest.TestCase):
    def test_counts_per_session_and_keeps_earliest_ts(self):
        texts = [("2026-08-18T12:00:00", "s1", "see hub/x#y"),
                 ("2026-08-18T10:00:00", "s1", "hub/x#y and hub/x#z"),
                 ("2026-08-18T11:00:00", "s2", "hub/x#y")]
        got = citations.count_in(texts, {"hub/x#y", "hub/x#z"})
        self.assertEqual(got[("s1", "hub/x#y")], ("2026-08-18T10:00:00", 2))
        self.assertEqual(got[("s1", "hub/x#z")], ("2026-08-18T10:00:00", 1))
        self.assertEqual(got[("s2", "hub/x#y")], ("2026-08-18T11:00:00", 1))

    def test_unmentioned_rule_is_absent(self):
        self.assertEqual(citations.count_in([("t", "s", "nothing")], {"hub/x#y"}), {})


class TestScan(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "a.jsonl").write_text(
            _rec("assistant", "assistant",
                 [{"type": "text", "text": "per hub/x#y this is wrong"}]) + "\n",
            encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def test_produces_cited_usage_rows(self):
        rows = citations.scan(self.root, {"hub/x#y"})
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["channel"], "cited")
        self.assertEqual(rows[0]["fqid"], "hub/x#y")
        self.assertEqual(rows[0]["count"], 1)
        self.assertEqual(rows[0]["session"], "s1")


class TestRewriteCited(unittest.TestCase):
    """_rewrite_cited must never leave the store empty or truncated: it used to
    truncate in place (`store.open("w")`), which a concurrent appender
    (inject-rules-on-edit.py, writing jit_delivered rows with no shared lock) could
    observe mid-write or lose a row into. It now writes a sibling temp file and
    renames it into place atomically."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_no_tmp_file_left_behind_after_the_call(self):
        store = self.root / "kb-usage.jsonl"
        citations._rewrite_cited(store, [
            usage.build_row("hub/x#y", "cited", "2026-08-18T10:00:00", "s1")])
        tmp = store.with_suffix(store.suffix + ".tmp")
        self.assertFalse(tmp.exists())

    def test_non_cited_channels_survive_the_rewrite(self):
        # Regression guard against a truncate-without-rename bug: a row present
        # before the call, on a channel _rewrite_cited does not own, must still be
        # present after.
        store = self.root / "kb-usage.jsonl"
        delivered = usage.build_row("hub/x#y", "jit_delivered",
                                    "2026-08-18T09:00:00", "s0")
        old_cited = usage.build_row("hub/x#y", "cited", "2026-08-18T08:00:00", "s0")
        ledger.append(store, [delivered, old_cited])

        new_cited = usage.build_row("hub/x#y", "cited", "2026-08-18T10:00:00", "s1")
        citations._rewrite_cited(store, [new_cited])

        rows = ledger.load_ledger(store)
        self.assertIn(delivered, rows)
        self.assertNotIn(old_cited, rows)
        self.assertIn(new_cited, rows)
