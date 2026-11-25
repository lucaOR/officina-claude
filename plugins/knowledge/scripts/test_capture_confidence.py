import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from capture import confidence


def row(kind="convention", theme=None, session="s0"):
    return {"text": "t", "pusher": "auto-capture",
            "meta": {"kind": kind, "theme": theme, "session": session}}


class TestConfidence(unittest.TestCase):
    def test_single_user_ruling_listed(self):
        r = row(kind="user-ruling", theme="a", session="s1")
        self.assertAlmostEqual(confidence.score(r, [r], 0), 0.5)

    def test_single_pitfall_held(self):
        r = row(kind="pitfall", theme="a", session="s1")
        self.assertAlmostEqual(confidence.score(r, [r], 0), 0.2)
        self.assertLess(0.2, confidence.LISTED_MIN)

    def test_recurrence_across_sessions_lifts_pitfall(self):
        rs = [row(kind="pitfall", theme="a", session=f"s{i}") for i in (1, 2)]
        self.assertAlmostEqual(confidence.score(rs[0], rs, 0), 0.35)

    def test_same_session_does_not_count_as_recurrence(self):
        rs = [row(kind="pitfall", theme="a", session="s1")] * 3
        self.assertAlmostEqual(confidence.score(rs[0], rs, 0), 0.2)

    def test_ledger_hits_capped(self):
        r = row(kind="pitfall", theme="a", session="s1")
        self.assertAlmostEqual(confidence.score(r, [r], 1), 0.3)
        self.assertAlmostEqual(confidence.score(r, [r], 5), 0.4)

    def test_missing_theme_or_meta_tolerated(self):
        a = row(theme=None, session="s1")
        b = row(theme=None, session="s2")
        self.assertAlmostEqual(confidence.score(a, [a, b], 0), 0.2)
        bare = {"text": "t"}
        self.assertAlmostEqual(confidence.score(bare, [bare, a], 0), 0.2)
        self.assertEqual(confidence.theme_vocab([bare, a, b]), [])

    def test_vocab_top_by_count(self):
        rs = [row(theme="a")] * 3 + [row(theme="b")]
        self.assertEqual(confidence.theme_vocab(rs, 1), ["a"])

    def test_vocab_ties_alphabetical(self):
        rs = [row(theme="b"), row(theme="a")]
        self.assertEqual(confidence.theme_vocab(rs), ["a", "b"])


class TestCli(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        subprocess.run(["git", "init", "-q"], cwd=self.root, check=True)

    def push(self, text, **meta):
        from kb import kb_queue
        kb_queue.push(text, pusher="auto-capture", root=self.root, meta=meta or None)

    def run_cli(self):
        env = {k: v for k, v in os.environ.items() if k != "KNOWLEDGE_LOCAL_DIR"}
        proc = subprocess.run(
            [sys.executable, str(Path(confidence.__file__)), "--root", str(self.root)],
            capture_output=True, text=True, env=env, cwd="/", timeout=30)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return [json.loads(line) for line in proc.stdout.splitlines()]

    def test_scores_auto_rows_with_listed_flag(self):
        self.push("Ruled", source="auto", session="s1", theme="a", kind="user-ruling",
                  quote="q" * 12)
        self.push("Weak", source="auto", session="s1", theme="b", kind="pitfall",
                  quote="q" * 12)
        self.push("Human note")
        out = self.run_cli()
        self.assertEqual([r["text"] for r in out], ["Ruled", "Weak"])
        self.assertAlmostEqual(out[0]["score"], 0.5)
        self.assertTrue(out[0]["listed"])
        self.assertAlmostEqual(out[1]["score"], 0.2)
        self.assertFalse(out[1]["listed"])
        self.assertEqual(out[0]["quote"], "q" * 12)

    def test_recurrence_uses_the_whole_queue(self):
        self.push("One", source="auto", session="s1", theme="a", kind="pitfall", quote="q" * 12)
        self.push("Two", source="auto", session="s2", theme="a", kind="pitfall", quote="q" * 12)
        out = self.run_cli()
        self.assertAlmostEqual(out[0]["score"], 0.35)
        self.assertTrue(out[0]["listed"])

    def test_empty_queue_prints_nothing(self):
        self.assertEqual(self.run_cli(), [])


if __name__ == "__main__":
    unittest.main()
