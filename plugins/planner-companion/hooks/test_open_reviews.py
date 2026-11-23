#!/usr/bin/env python3
"""Tests for the unfinished-plan-review SessionStart hook. Plain stdlib unittest:
    cd plugins/planner-companion/hooks && python3 -m unittest test_open_reviews
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HOOK = Path(__file__).with_name("open-reviews.py")


class OpenReviewsTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.project = Path(self._tmp.name)

    def run_hook(self, stdin="{}", plans_dir=None):
        env = {k: v for k, v in os.environ.items() if k != "PLANNING_PLANS_DIR"}
        env["CLAUDE_PROJECT_DIR"] = str(self.project)
        if plans_dir is not None:
            env["PLANNING_PLANS_DIR"] = plans_dir
        return subprocess.run([sys.executable, str(HOOK)], input=stdin,
                              capture_output=True, text=True, env=env)

    def make_plan(self, name="2026-11-19-demo", plans="docs/plans", questions=0, handled=0,
                  open_threads=0, answered_threads=0, resolved_threads=0, log=0, real_plan=True,
                  working="{}"):
        folder = self.project / plans / name
        folder.mkdir(parents=True)
        (folder / "working.json").write_text(working)
        if real_plan:
            (folder / "plan.json").write_text("{}")
        (folder / "changes.json").write_text(json.dumps({"next": log + 1, "log": [{"n": i} for i in range(log)]}))
        user, claude = {"by": "user", "text": "why?"}, {"by": "claude", "text": "because"}
        # open_threads: the user spoke last; answered_threads: Claude did; resolved_threads: user last, resolved.
        threads = [{"id": f"t{i}", "state": "open", "messages": [user]} for i in range(open_threads)]
        threads += [{"id": f"a{i}", "state": "open", "messages": [user, claude]} for i in range(answered_threads)]
        threads += [{"id": f"r{i}", "state": "resolved", "messages": [user]} for i in range(resolved_threads)]
        (folder / "threads.json").write_text(json.dumps({"next": 1, "threads": threads}))
        rows = [json.dumps({"id": f"q{i}"}) for i in range(questions)]
        (folder / "questions.jsonl").write_text("\n".join(rows) + "\n\n")
        done = [json.dumps({"question": f"q{i}"}) for i in range(handled)]
        (folder / "handled.jsonl").write_text("\n".join(done) + "\n")
        return folder

    def body(self, **kwargs):
        plans_dir = kwargs.pop("plans_dir", None)
        self.make_plan(plans=plans_dir or "docs/plans", **kwargs)
        result = self.run_hook(plans_dir=plans_dir)
        self.assertEqual(result.returncode, 0, result.stderr)
        out = json.loads(result.stdout)
        self.assertEqual(out["systemMessage"], out["hookSpecificOutput"]["additionalContext"])
        self.assertEqual(out["hookSpecificOutput"]["hookEventName"], "SessionStart")
        return out["systemMessage"]

    def test_silent_without_plans_dir(self):
        self.assertEqual(self.run_hook().stdout, "")

    def test_line_for_an_unfinished_review(self):
        body = self.body(questions=2, handled=0, open_threads=1, log=3)
        self.assertIn("Open plan review: demo, 2 unanswered questions, 1 thread waiting for a reply, 3 changes not in the real plan.", body)
        self.assertIn("Reopen: /planner-companion:plan reopen docs/plans/2026-11-19-demo", body)

    def test_singular_nouns_and_handled_questions(self):
        body = self.body(questions=3, handled=2, log=1)
        self.assertIn("demo, 1 unanswered question, 1 change not in the real plan.", body)
        self.assertNotIn("thread", body)

    def test_clean_plan_prints_nothing(self):
        self.make_plan(questions=2, handled=2, resolved_threads=1)
        self.assertEqual(self.run_hook().stdout, "")

    def test_missing_real_plan_is_reported(self):
        body = self.body(real_plan=False)
        self.assertIn("Open plan review: demo, no real plan yet.", body)

    def test_plans_dir_env(self):
        body = self.body(plans_dir="plans/x", log=2)
        self.assertIn("Reopen: /planner-companion:plan reopen plans/x/2026-11-19-demo", body)

    def test_one_sorted_line_per_plan_and_skips_non_plans(self):
        self.make_plan(name="2026-11-20-beta", log=1)
        self.make_plan(name="alpha", log=1)
        (self.project / "docs/plans/stray").mkdir()
        lines = json.loads(self.run_hook().stdout)["systemMessage"].split("\n")
        self.assertEqual(len(lines), 2)
        self.assertTrue(lines[0].startswith("Open plan review: beta,"))
        self.assertTrue(lines[1].startswith("Open plan review: alpha,"))

    def test_thread_claude_answered_last_is_not_counted(self):
        self.make_plan(answered_threads=2, resolved_threads=1)
        self.assertEqual(self.run_hook().stdout, "")

    def test_thread_with_a_user_reply_after_claude_is_counted(self):
        folder = self.make_plan(answered_threads=1)
        book = json.loads((folder / "threads.json").read_text())
        book["threads"][0]["messages"].append({"by": "user", "text": "and at scale?"})
        (folder / "threads.json").write_text(json.dumps(book))
        body = json.loads(self.run_hook().stdout)["systemMessage"]
        self.assertIn("Open plan review: demo, 1 thread waiting for a reply.", body)
        self.assertNotIn("question", body)

    def test_two_waiting_threads_are_plural(self):
        self.assertIn("demo, 2 threads waiting for a reply.", self.body(open_threads=2, answered_threads=3))

    def test_author_edits_after_the_real_plan_are_reported(self):
        body = self.body(working='{"goal": "edited after the update"}')
        self.assertIn("Open plan review: demo, edits not in the real plan.", body)
        folder = self.project / "docs/plans/2026-11-19-demo"
        (folder / "plan.json").write_text('{"goal": "edited after the update"}')
        self.assertEqual(self.run_hook().stdout, "")

    def test_empty_plans_dir_env_falls_back_to_docs_plans(self):
        body = self.body(plans_dir="", log=1)
        self.assertIn("Reopen: /planner-companion:plan reopen docs/plans/2026-11-19-demo", body)

    def test_torn_jsonl_line_is_skipped_and_other_plans_still_report(self):
        torn = self.make_plan(name="2026-11-19-torn", questions=2, handled=1)
        with open(torn / "questions.jsonl", "a") as f:
            f.write('{"id": "q3", "at": "2026-11')  # a write cut short
        with open(torn / "handled.jsonl", "a") as f:
            f.write('{"question": "q')
        self.make_plan(name="2026-11-19-healthy", log=2)
        lines = json.loads(self.run_hook().stdout)["systemMessage"].split("\n")
        self.assertEqual(lines, [
            "Open plan review: healthy, 2 changes not in the real plan. Reopen: /planner-companion:plan reopen docs/plans/2026-11-19-healthy",
            "Open plan review: torn, 1 unanswered question. Reopen: /planner-companion:plan reopen docs/plans/2026-11-19-torn",
        ])

    def test_fails_open_on_bad_stdin(self):
        self.make_plan(log=1)
        result = self.run_hook(stdin="not json")
        self.assertEqual((result.returncode, result.stdout), (0, ""))

    def test_fails_open_on_corrupt_file(self):
        self.make_plan(name="2026-11-19-good", log=1)
        bad = self.make_plan(name="2026-11-19-bad", log=1)
        (bad / "changes.json").write_text("{broken")
        result = self.run_hook()
        self.assertEqual((result.returncode, result.stdout), (0, ""))


if __name__ == "__main__":
    unittest.main()
