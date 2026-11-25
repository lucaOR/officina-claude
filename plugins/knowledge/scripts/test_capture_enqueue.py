import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from capture import enqueue
from kb import kb_queue


def row(statement, theme, **kw):
    r = {"statement": statement, "quote": "q" * 12, "kind": "convention",
         "scope_guess": "root", "theme": theme}
    r.update(kw)
    return r


def make_repo() -> Path:
    root = Path(tempfile.mkdtemp())
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    return root


class TestEnqueue(unittest.TestCase):
    def setUp(self):
        self.root = make_repo()

    def test_cap_and_dedupe(self):
        rows = [row(f"s{i}", "th") for i in range(8)] + [row("s0", "th")]
        self.assertEqual(enqueue.enqueue(rows, "sess1", self.root, cap=6), 6)
        # normalised duplicate of an already queued statement
        self.assertEqual(enqueue.enqueue([row("S0 ", "th")], "sess2", self.root), 0)

    def test_meta_written(self):
        enqueue.enqueue([row("Use  shrink-0", "flex")], "sess1", self.root)
        rec = kb_queue.read_unconsumed(self.root)[0]
        self.assertEqual(rec["text"], "Use shrink-0")
        self.assertEqual(rec["pusher"], "auto-capture")
        self.assertEqual(rec["meta"], {
            "source": "auto", "session": "sess1", "theme": "flex",
            "scope_guess": "root", "kind": "convention", "quote": "q" * 12})

    def test_dedupe_against_consumed_row(self):
        kb_queue.push("already done", root=self.root)
        path = kb_queue.queue_file_path(self.root)
        rec = json.loads(path.read_text())
        rec["consumed"] = True
        path.write_text(json.dumps(rec) + "\n")
        self.assertEqual(enqueue.enqueue([row("Already  Done", "t")], "s", self.root), 0)


if __name__ == "__main__":
    unittest.main()
