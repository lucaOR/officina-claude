import json
import unittest

from capture import extract


class FakeProc:
    def __init__(self, stdout, returncode=0):
        self.stdout = stdout
        self.returncode = returncode


def _row(quote, **kw):
    r = {"statement": "s", "quote": quote, "kind": "convention",
         "scope_guess": "root", "theme": "t"}
    r.update(kw)
    return r


JSON_OK = "Here:\n" + json.dumps([_row("use shrink-0", theme="flex-icon-shrink")])
JSON_BAD_QUOTE = json.dumps([_row("never said this")])
SEVEN_ROWS_SOURCE = "USER: " + " ".join("rule-number-%d" % i for i in range(7))
SEVEN_ROWS_JSON = json.dumps([_row("rule-number-%d" % i) for i in range(7)])


class TestExtract(unittest.TestCase):
    def test_command_and_env(self):
        calls = []

        def runner(cmd, **kw):
            calls.append((cmd, kw))
            return FakeProc(JSON_OK)
        rows = extract.extract("USER: use shrink-0", ["flex-icon-shrink"], runner=runner)
        cmd, kw = calls[0]
        self.assertEqual(cmd[:8], ["claude", "-p", "--model", "haiku", "--tools", "",
                                   "--no-session-persistence", "--strict-mcp-config"])
        self.assertEqual(kw["cwd"], "/")
        self.assertEqual(kw["env"]["KNOWLEDGE_EXTRACT"], "1")
        self.assertEqual(kw["timeout"], 150)
        self.assertIn("KNOWN THEMES: flex-icon-shrink", kw["input"])
        self.assertEqual(len(rows), 1)

    def test_quote_not_in_source_is_dropped(self):
        rows = extract.extract("USER: use shrink-0", [],
                               runner=lambda c, **k: FakeProc(JSON_BAD_QUOTE))
        self.assertEqual(rows, [])

    def test_quote_whitespace_normalised(self):
        out = json.dumps([_row("use   shrink-0")])
        rows = extract.extract("USER: use\nshrink-0", [], runner=lambda c, **k: FakeProc(out))
        self.assertEqual(len(rows), 1)

    def test_non_string_field_dropped(self):
        out = json.dumps([_row("use shrink-0", theme=5)])
        self.assertEqual(extract.extract("use shrink-0", [], runner=lambda c, **k: FakeProc(out)), [])

    def test_invalid_json_returns_empty(self):
        self.assertEqual(extract.extract("x", [], runner=lambda c, **k: FakeProc("oops")), [])

    def test_nonzero_exit_and_exception(self):
        self.assertEqual(extract.extract("use shrink-0", [],
                         runner=lambda c, **k: FakeProc(JSON_OK, 1)), [])

        def boom(c, **k):
            raise TimeoutError()
        self.assertEqual(extract.extract("x", [], runner=boom), [])

    def test_vocab_is_in_prompt_and_cap_is_6(self):
        seen = {}

        def runner(c, **k):
            seen.update(k)
            return FakeProc(SEVEN_ROWS_JSON)
        rows = extract.extract(SEVEN_ROWS_SOURCE, ["t1"], runner=runner)
        self.assertEqual(len(rows), 6)
        self.assertIn("KNOWN THEMES: t1", seen["input"])

    def test_long_input_keeps_tail(self):
        seen = {}

        def runner(c, **k):
            seen.update(k)
            return FakeProc("[]")
        text = "HEAD-MARK " + "x" * (extract.MAX_INPUT_CHARS * 2) + " TAIL-MARK"
        extract.extract(text, [], runner=runner)
        self.assertIn("TAIL-MARK", seen["input"])
        self.assertNotIn("HEAD-MARK", seen["input"])

    def test_first_list_skips_lists_without_dicts(self):
        out = "see [1] then " + json.dumps([_row("use shrink-0")])
        rows = extract.extract("USER: use shrink-0", [], runner=lambda c, **k: FakeProc(out))
        self.assertEqual(len(rows), 1)

    def test_short_quote_dropped(self):
        out = json.dumps([_row("shrink-0")])
        self.assertEqual(extract.extract("USER: shrink-0", [],
                                         runner=lambda c, **k: FakeProc(out)), [])

    def test_cap_cuts_on_line_boundary(self):
        seen = {}

        def runner(c, **k):
            seen.update(k)
            return FakeProc("[]")
        n = extract.MAX_INPUT_CHARS
        text = "z" * (n + 100) + "\nlast"
        extract.extract(text, [], runner=runner)
        self.assertNotIn("zzz", seen["input"])
        self.assertTrue(seen["input"].endswith("\nlast"))

    def test_short_input_not_trimmed(self):
        seen = {}

        def runner(c, **k):
            seen.update(k)
            return FakeProc("[]")
        extract.extract("first line\nsecond", [], runner=runner)
        self.assertIn("first line", seen["input"])


if __name__ == "__main__":
    unittest.main()
