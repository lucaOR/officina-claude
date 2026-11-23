import json
import subprocess
import time

from testsupport import CLI
from test_changes import ChangesTestCase


class QueueTest(ChangesTestCase):
    def setUp(self):
        super().setUp()
        self.info = self.state_dir(self.dir) / "server-info.json"
        self.info.parent.mkdir(parents=True)
        self.info.write_text(json.dumps({"port": 1, "key": "k", "pid": 1}))

    def ask(self, kind, target, text):
        return self.cli_json("ask", self.dir, kind, target, text)["question"]["id"]

    def next(self):
        return json.loads(self.cli("next", self.dir).stdout)

    def lines(self, name="questions.jsonl"):
        return [l for l in (self.dir / name).read_text().split("\n") if l.strip()]

    def thread(self, tid):
        return next(t for t in self.read("threads.json")["threads"] if t["id"] == tid)

    def apply_invalid(self, question):
        return self.cli("apply", self.dir, self.write({"upsert": [self.without_slot("D1", "scale")]}),
                        "--kind", "change", "--question", question)

    def popen(self, *args):
        p = subprocess.Popen(["node", str(CLI), *map(str, args)], env=self.env(), cwd=self.tmp,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: (p.kill(), p.wait(), p.stdout.close(), p.stderr.close()))
        return p

    def test_comment_creates_thread_and_question(self):
        r = self.cli_json("ask", self.dir, "comment", "D1", "why?")
        self.assertEqual((r["question"]["id"], r["thread"]["id"]), ("q1", "t1"))
        t = self.thread("t1")
        self.assertEqual((t["target"], t["kind"], t["state"]), ("D1", "comment", "open"))
        self.assertEqual([(m["by"], m["text"], m["question"]) for m in t["messages"]], [("user", "why?", "q1")])
        self.assertEqual(self.next()["id"], "q1")

    def test_comment_reuses_open_thread_but_change_opens_new(self):
        self.ask("comment", "D1", "a")
        self.ask("comment", "D1", "b")
        self.assertEqual(len(self.thread("t1")["messages"]), 2)
        self.ask("change", "D1", "c")
        self.assertEqual(self.thread("t2")["kind"], "change")
        self.cli_json("resolve", self.dir, "t1")
        self.ask("comment", "D1", "d")
        self.assertEqual(self.thread("t3")["kind"], "comment")

    def test_two_quick_asks_are_both_kept_in_order(self):
        self.cli("ask", self.dir, "comment", "D1", "a")
        self.cli("ask", self.dir, "change", "T1", "b")
        self.assertEqual(self.next()["id"], "q1")
        self.cli("answer", self.dir, "q1", "--text", "x")
        self.assertEqual(self.next()["id"], "q2")

    def test_answer_appends_reply_and_marks_handled(self):
        self.ask("comment", "D1", "why?")
        self.cli_json("answer", self.dir, "q1", "--text", "because", "--suggest-change")
        m = self.thread("t1")["messages"][-1]
        self.assertEqual((m["by"], m["text"], m["suggestChange"], m["question"]), ("claude", "because", True, "q1"))
        self.assertEqual(self.thread("t1")["state"], "open")
        self.assertIsNone(self.next())
        self.assertEqual(json.loads(self.lines("handled.jsonl")[0])["how"], "answer")

    def test_answering_twice_or_unknown_fails(self):
        self.ask("comment", "D1", "why?")
        self.cli_json("ack", self.dir, "q1")
        self.assertEqual(self.cli("answer", self.dir, "q1", "--text", "x").returncode, 1)
        self.assertEqual(self.cli("ack", self.dir, "q9").returncode, 1)

    def test_questions_file_never_shrinks(self):
        counts = []
        self.ask("comment", "D1", "a"); counts.append(len(self.lines()))
        self.cli_json("answer", self.dir, "q1", "--text", "x"); counts.append(len(self.lines()))
        self.cli_json("resolve", self.dir, "t1"); counts.append(len(self.lines()))
        self.ask("comment", "D2", "b"); counts.append(len(self.lines()))
        self.cli_json("ack", self.dir, "q2"); counts.append(len(self.lines()))
        self.assertEqual(counts, sorted(counts))
        self.assertEqual(counts[-1], 2)

    def test_resolve_keeps_messages(self):
        self.ask("comment", "D1", "a")
        self.cli_json("resolve", self.dir, "t1")
        t = self.thread("t1")
        self.assertEqual((t["state"], len(t["messages"])), ("resolved", 1))

    def test_to_change_queues_a_change_on_the_same_thread(self):
        self.ask("comment", "D1", "first")
        self.ask("comment", "D1", "make it bigger")
        q = self.cli_json("to-change", self.dir, "t1")
        self.assertEqual((q["id"], q["kind"], q["thread"], q["target"], q["text"]), ("q3", "change", "t1", "D1", "make it bigger"))
        self.assertEqual(self.thread("t1")["kind"], "change")

    def test_failed_apply_keeps_question_unanswered(self):
        q = self.ask("change", "D1", "drop the scale slot")
        r = self.apply_invalid(question=q)
        self.assertEqual(r.returncode, 1)
        self.assertEqual(self.next()["id"], q)

    def test_apply_marks_question_applied(self):
        q = self.ask("change", "D1", "retitle")
        d = self.decision("D1")
        d["title"] = "Renamed"
        r = self.cli("apply", self.dir, self.write({"upsert": [d]}), "--kind", "change", "--question", q)
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        self.assertIsNone(self.next())
        self.assertEqual(self.thread("t1")["messages"][-1]["text"], "Applied as c1.")
        self.assertEqual(self.changes()["log"][0]["question"], q)
        self.assertEqual(json.loads(self.lines("handled.jsonl")[0])["how"], "apply")

    def test_noop_apply_replies_nothing_to_change(self):
        q = self.ask("change", "D1", "nothing")
        r = self.cli("apply", self.dir, self.write({"upsert": [self.decision("D1")]}), "--kind", "change", "--question", q)
        self.assertEqual(r.returncode, 0)
        self.assertEqual(self.thread("t1")["messages"][-1]["text"], "Nothing to change.")
        self.assertIsNone(self.next())

    def test_malformed_line_is_skipped(self):
        self.ask("comment", "D1", "a")
        with open(self.dir / "questions.jsonl", "a") as f:
            f.write("{bad\n")
        self.assertEqual(self.ask("comment", "D2", "b"), "q3")
        with open(self.dir / "handled.jsonl", "a") as f:
            f.write("{bad\n")
        self.cli_json("ack", self.dir, "q1")
        self.assertEqual(self.next()["id"], "q3")

    def test_watch_returns_a_pending_question_at_once(self):
        self.ask("comment", "D1", "a")
        w = self.popen("watch", self.dir)
        self.assertEqual(w.wait(timeout=2), 0)
        self.assertEqual(json.loads(w.stdout.read())["id"], "q1")

    def test_watch_returns_a_pending_question_even_if_server_stopped(self):
        self.ask("comment", "D1", "a")
        self.info.unlink()
        w = self.popen("watch", self.dir)
        self.assertEqual(w.wait(timeout=2), 0)

    def test_watch_wakes_on_a_new_question(self):
        w = self.popen("watch", self.dir, "--interval-ms", 100)
        time.sleep(1.0)
        self.assertIsNone(w.poll())
        self.cli("ask", self.dir, "comment", "D1", "why?")
        self.assertEqual(w.wait(timeout=5), 0)
        self.assertEqual(json.loads(w.stdout.read())["target"], "D1")

    def test_watch_stops_with_the_server(self):
        w = self.popen("watch", self.dir, "--interval-ms", 100)
        time.sleep(0.5)
        self.info.unlink()
        self.assertEqual(w.wait(timeout=5), 4)
        self.assertEqual(json.loads(w.stdout.read()), {"stopped": True})


if __name__ == "__main__":
    import unittest
    unittest.main()
