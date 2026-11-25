import unittest

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


if __name__ == "__main__":
    unittest.main()
