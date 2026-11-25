import json
import tempfile
import unittest
from pathlib import Path

from capture import prepare


def _line(**kw):
    return json.dumps(kw)


class TestPrepareInput(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        d = Path(self.tmp.name)
        lines = [
            _line(type="user", message={"role": "user", "content": "it is not like figma"}),
            _line(type="assistant", message={"role": "assistant", "content": [
                {"type": "text", "text": "ok " + "x" * 500},
                {"type": "tool_use", "name": "Read", "input": {}}]}),
            _line(type="assistant", message={"role": "assistant", "content": [
                {"type": "tool_use", "name": "Edit", "input": {}}]}),
            _line(type="user", message={"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "1", "content": "RESULT-BODY"}]}),
            _line(type="user", isSidechain=True,
                  message={"role": "user", "content": "SIDECHAIN-ONLY"}),
            _line(type="user", isMeta=True,
                  message={"role": "user", "content": "META-ONLY"}),
            _line(type="user", message={"role": "user", "content": "<command-name>x</command-name>"}),
            "not json",
        ]
        self.transcript = d / "t.jsonl"
        self.transcript.write_text("\n".join(lines) + "\n")
        self.note = d / "note.md"
        self.note.write_text("the handoff")

    def test_auto_picks_handoff_when_note_exists(self):
        mode, text = prepare.prepare_input(self.transcript, self.note, 'auto')
        self.assertEqual(mode, 'handoff')
        self.assertIn('NOTE:', text)
        self.assertIn('TRANSCRIPT TAIL:', text)

    def test_auto_falls_back_to_transcript(self):
        mode, text = prepare.prepare_input(self.transcript, None, 'auto')
        self.assertEqual(mode, 'transcript')
        self.assertIn('USER: it is not like figma', text)
        self.assertNotIn('tool_result', text)
        self.assertNotIn('RESULT-BODY', text)

    def test_sidechain_and_meta_turns_skipped(self):
        _, text = prepare.prepare_input(self.transcript, None, 'transcript')
        self.assertNotIn('SIDECHAIN-ONLY', text)
        self.assertNotIn('META-ONLY', text)
        self.assertNotIn('command-name', text)

    def test_assistant_text_capped_and_tool_names_collapsed(self):
        _, text = prepare.prepare_input(self.transcript, None, 'transcript')
        self.assertNotIn('x' * 401, text)
        self.assertEqual(text.count('TOOLS:'), 1)
        self.assertIn('TOOLS: Read, Edit', text)

    def test_handoff_tail_is_capped(self):
        big = Path(self.tmp.name) / "big.jsonl"
        big.write_text("\n".join(
            _line(type="user", message={"role": "user", "content": "u%d " % i + "y" * 1000})
            for i in range(50)) + "\n")
        _, text = prepare.prepare_input(big, self.note, 'handoff')
        tail = text.split('TRANSCRIPT TAIL:\n', 1)[1]
        self.assertLessEqual(len(tail), 12000)

    def test_missing_transcript_in_transcript_mode(self):
        missing = Path(self.tmp.name) / "nope.jsonl"
        self.assertEqual(prepare.prepare_input(missing, None, 'transcript'), ('transcript', ''))

    def test_missing_transcript_in_handoff_mode_keeps_note(self):
        missing = Path(self.tmp.name) / "nope.jsonl"
        mode, text = prepare.prepare_input(missing, self.note, 'handoff')
        self.assertEqual(mode, 'handoff')
        self.assertIn('the handoff', text)

    def test_handoff_mode_without_note_falls_back_to_transcript(self):
        mode, text = prepare.prepare_input(self.transcript, None, 'handoff')
        self.assertEqual(mode, 'transcript')
        self.assertIn('USER: it is not like figma', text)


if __name__ == "__main__":
    unittest.main()
