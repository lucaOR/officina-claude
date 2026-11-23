"""Tests for review.py. Plain unittest: there is no pytest on this host.

Run: python3 -m unittest discover -s plugins/session/skills/refine -p 'test_*.py'
The transcript fixtures reproduce the record shapes seen in a real session
(command wrapper, tool result, meta caveat, system reminder, plain turns).
"""
import contextlib
import io
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
import review  # noqa: E402

SID_A = "aaaaaaaa-0000-4000-8000-000000000001"
SID_B = "bbbbbbbb-0000-4000-8000-000000000002"
SID_C = "cccccccc-0000-4000-8000-000000000003"
REVIEW = Path(__file__).parent / "review.py"


def urec(content, **extra):
    return {"type": "user", "message": {"role": "user", "content": content}, **extra}


def arec(text):
    return {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}}


def fixture_records():
    """12 lines: command wrapper, tool result, caveat, reminder, cross-session, plain turns."""
    return [
        urec("<command-message>refine</command-message>\n<command-name>/refine</command-name>\n"
             "<command-args>a skill that interviews me before building</command-args>"),
        arec("What problem prompted this?"),
        urec("Claude jumps into planning too early."),
        arec("Who feels it?"),
        urec([{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]),
        urec("<local-command-caveat>ignore</local-command-caveat>", isMeta=True),
        urec("<system-reminder>background</system-reminder>"),
        urec('<cross-session-message from="x">hello</cross-session-message>'),
        urec("<local-command-stdout>out</local-command-stdout>"),
        urec("<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>"),
        urec("Mostly me, on vague ideas."),
        arec("Noted."),
    ]


def write_jsonl(path, records):
    Path(path).write_text("\n".join(json.dumps(r) for r in records) + "\n")


DRAFT_OK = """# Intent — x

opened: 2026-10-20
owner: me
status: draft

## Purpose

Kind: problem. **(Claude's guess, for the user to confirm)**

why.

## Verbatim ask

ask

## DEFINITIONS

- **Thing**: the deliverable, this is exhaustive.

## Done-criteria

1

## Non-goals

n

## Budget

b

## Open questions

q
"""

CLEAN_ENVELOPE = {"type": "result", "is_error": False, "result": '{"findings": []}'}


def finding(reason="The Purpose moved from problem to opportunity without a ruling."):
    return {"kind": "purpose-shift", "quote": "Kind: opportunity", "evidence": "no user message", "reason": reason}


def envelope(findings):
    return {"type": "result", "is_error": False, "result": json.dumps({"findings": findings})}


class Base(unittest.TestCase):
    @property
    def last_payload(self):
        """The text the helper sent to the reviewer on its latest run."""
        return (self.dir / "last_input.txt").read_text()

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.dir = self.tmp / "slug"
        self.prompt = self.tmp / "prompt.md"
        self.prompt.write_text("reviewer contract")
        self.files = {}
        patches = [
            mock.patch.object(review, "PROMPT", self.prompt),
            mock.patch.object(review, "locate_transcript", self.locate),
            mock.patch.dict(os.environ, {"CLAUDE_CODE_SESSION_ID": SID_A}),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        for k in ("REFINE_CLAUDE_BIN", "REFINE_REVIEW_LOCAL", "REFINE_REVIEW_KILL"):
            os.environ.pop(k, None)

    def tearDown(self):
        self._tmp.cleanup()

    def locate(self, session_id=None):
        return self.files.get(session_id or os.environ.get("CLAUDE_CODE_SESSION_ID"))

    def transcript(self, sid, records):
        p = self.tmp / f"{sid}.jsonl"
        write_jsonl(p, records)
        self.files[sid] = p
        return p

    def stub(self, env, dump=None):
        """Install a shell stub standing in for `claude -p`."""
        body = "#!/bin/sh\n"
        if dump:
            body += f'env > "{dump}.env"\nprintf "%s\\n" "$@" > "{dump}.argv"\n'
        body += f"cat <<'EOF'\n{json.dumps(env)}\nEOF\n"
        path = self.tmp / "claude-stub"
        path.write_text(body)
        path.chmod(path.stat().st_mode | stat.S_IEXEC)
        os.environ["REFINE_CLAUDE_BIN"] = str(path)

    def init_dir(self, draft=DRAFT_OK):
        self.dir.mkdir(exist_ok=True)
        (self.dir / "draft.md").write_text(draft)
        review.main(["init", str(self.dir)])

    def check(self, *flags):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = review.main(["check", str(self.dir), *flags])
        self.assertEqual(code, 0)
        return buf.getvalue()

    def cmd(self, name):
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(review.main([name, str(self.dir)]), 0)

    def state(self):
        return json.loads((self.dir / "state.json").read_text())


class UserMessagesTest(Base):
    def test_user_messages_reads_command_args_as_first_message(self):
        p = self.transcript(SID_A, fixture_records())
        self.assertEqual(review.user_messages(p, 0)[0], "a skill that interviews me before building")

    def test_user_messages_skips_tool_results_meta_and_system_reminders(self):
        p = self.transcript(SID_A, fixture_records())
        self.assertEqual(review.user_messages(p, 0), [
            "a skill that interviews me before building",
            "Claude jumps into planning too early.",
            "Mostly me, on vague ideas.",
        ])

    def test_user_messages_respects_since_line(self):
        p = self.transcript(SID_A, fixture_records())
        self.assertEqual(review.user_messages(p, 3), ["Mostly me, on vague ideas."])

    def test_assistant_text_respects_since_line(self):
        p = self.transcript(SID_A, fixture_records())
        self.assertEqual(review.assistant_text(p, 2), ["Who feels it?", "Noted."])


class LocateTest(Base):
    def test_locate_transcript_uses_session_id_and_ignores_newer_files(self):
        home = self.tmp / "home"
        proj = home / ".claude" / "projects" / "-p"
        proj.mkdir(parents=True)
        mine = proj / f"{SID_A}.jsonl"
        mine.write_text("{}\n")
        other = proj / f"{SID_B}.jsonl"
        other.write_text("{}\n")
        os.utime(mine, (1, 1))
        os.utime(other, (9999999999, 9999999999))
        with mock.patch.object(review.Path, "home", return_value=home):
            found = review.__dict__["_locate_by_name"](SID_A)
            self.assertEqual(found, mine)
            self.assertIsNone(review.__dict__["_locate_by_name"](SID_C))
            self.assertIsNone(review.__dict__["_locate_by_name"]("../../etc/passwd"))


class LintTest(unittest.TestCase):
    def test_lint_accepts_complete_draft(self):
        self.assertEqual(review.lint_draft(DRAFT_OK, final=True), [])

    def test_lint_rejects_status_done(self):
        problems = review.lint_draft(DRAFT_OK.replace("status: draft", "status: done"), final=False)
        self.assertTrue(any("status" in p for p in problems))

    def test_lint_requires_purpose_first(self):
        text = DRAFT_OK.replace("## Purpose", "## Verbatim ask", 1)
        self.assertTrue(any("Purpose" in p for p in review.lint_draft(text, final=False)))

    def test_lint_requires_kind_line_in_purpose(self):
        self.assertEqual(review.lint_draft(DRAFT_OK, final=False), [])
        bad = DRAFT_OK.replace("Kind: problem. **(Claude's guess, for the user to confirm)**", "Kind: maybe")
        self.assertTrue(any("Kind" in p for p in review.lint_draft(bad, final=False)))
        both = DRAFT_OK.replace("Kind: problem.", "Kind: both,")
        self.assertEqual(review.lint_draft(both, final=False), [])

    def test_lint_final_lists_definitions_lines_without_exhaustive(self):
        text = DRAFT_OK.replace("- **Thing**: the deliverable, this is exhaustive.",
                                "- **Thing**: the deliverable.\n- **Other**: exhaustive here.\n- **Third**: open ended.")
        problems = review.lint_draft(text, final=True)
        self.assertEqual(len([p for p in problems if "exhaustive" in p]), 2)
        self.assertTrue(any("Thing" in p for p in problems))
        self.assertTrue(any("Third" in p for p in problems))
        self.assertEqual(review.lint_draft(text, final=False), [])

    def test_lint_final_requires_sections_in_order(self):
        text = DRAFT_OK.replace("## Budget\n\nb\n\n", "")
        self.assertTrue(any("Budget" in p for p in review.lint_draft(text, final=True)))


class CheckTest(Base):
    def test_check_clean_advances_snapshot_and_state(self):
        p = self.transcript(SID_A, fixture_records())
        self.init_dir()
        self.stub(CLEAN_ENVELOPE)
        out = self.check()
        self.assertEqual(out.split()[0], "clean")
        self.assertEqual((self.dir / "snapshot.md").read_text(), DRAFT_OK)
        self.assertEqual(self.state()["cursors"], {SID_A: len(p.read_text().splitlines())})

    def test_check_finding_prints_reviewer_words_verbatim_and_keeps_snapshot(self):
        self.transcript(SID_A, fixture_records())
        self.init_dir()
        reason = "Exact words: the Purpose moved, \"quoted\" and unicode café."
        self.stub(envelope([finding(reason)]))
        out = self.check()
        self.assertEqual(out.split()[0], "finding")
        self.assertIn(reason, out)
        self.assertEqual((self.dir / "snapshot.md").read_text(), "")

    def test_check_unavailable_on_missing_binary_keeps_snapshot(self):
        self.transcript(SID_A, fixture_records())
        self.init_dir()
        os.environ["REFINE_CLAUDE_BIN"] = str(self.tmp / "nope")
        out = self.check()
        self.assertEqual(out.split()[0], "unavailable:")
        self.assertEqual((self.dir / "snapshot.md").read_text(), "")

    def test_check_unavailable_on_malformed_json(self):
        self.transcript(SID_A, fixture_records())
        self.init_dir()
        self.stub({"type": "result", "is_error": False, "result": "not json at all"})
        self.assertEqual(self.check().split()[0], "unavailable:")

    def test_check_unavailable_on_unknown_finding_kind(self):
        self.transcript(SID_A, fixture_records())
        self.init_dir()
        bad = finding()
        bad["kind"] = "the-idea-is-poor"
        self.stub(envelope([bad]))
        self.assertEqual(self.check().split()[0], "unavailable:")

    def test_check_unavailable_on_timeout(self):
        self.transcript(SID_A, fixture_records())
        self.init_dir()
        slow = self.tmp / "slow"
        slow.write_text("#!/bin/sh\nsleep 5\n")
        slow.chmod(slow.stat().st_mode | stat.S_IEXEC)
        os.environ["REFINE_CLAUDE_BIN"] = str(slow)
        os.environ["REFINE_REVIEW_KILL"] = "1"
        self.assertEqual(self.check().split()[0], "unavailable:")

    def test_check_unavailable_when_no_session_id(self):
        self.init_dir()
        del os.environ["CLAUDE_CODE_SESSION_ID"]
        self.stub(CLEAN_ENVELOPE)
        out = self.check()
        self.assertEqual(out.strip(), "unavailable: no transcript")

    def test_check_unavailable_when_current_transcript_missing(self):
        self.init_dir()
        self.stub(CLEAN_ENVELOPE)
        self.assertEqual(self.check().strip(), "unavailable: no transcript")

    def test_resume_after_clear_reads_old_tail_and_new_file_from_zero(self):
        a = self.transcript(SID_A, fixture_records())
        b = self.transcript(SID_B, [urec("fresh start after clear"), arec("ok")])
        self.init_dir()
        st = self.state()
        st["cursors"] = {SID_A: 7}
        (self.dir / "state.json").write_text(json.dumps(st))
        os.environ["CLAUDE_CODE_SESSION_ID"] = SID_B
        self.stub(CLEAN_ENVELOPE)
        self.assertEqual(self.check().split()[0], "clean")
        self.assertEqual(self.state()["cursors"], {
            SID_A: len(a.read_text().splitlines()), SID_B: len(b.read_text().splitlines())})
        self.assertIn("fresh start after clear", self.last_payload)
        self.assertIn("Mostly me, on vague ideas.", self.last_payload)
        self.assertNotIn("Claude jumps into planning too early.", self.last_payload)


    def test_check_unavailable_when_cursor_session_file_missing_keeps_snapshot(self):
        self.transcript(SID_B, [urec("hi")])
        self.init_dir()
        st = self.state()
        st["cursors"] = {SID_A: 3}
        (self.dir / "state.json").write_text(json.dumps(st))
        os.environ["CLAUDE_CODE_SESSION_ID"] = SID_B
        self.stub(CLEAN_ENVELOPE)
        out = self.check()
        self.assertEqual(out.strip(), f"unavailable: transcript {SID_A} missing")
        self.assertEqual((self.dir / "snapshot.md").read_text(), "")

    def test_session_registered_even_when_snapshot_never_advances(self):
        a = self.transcript(SID_A, fixture_records())
        self.init_dir()
        self.stub(CLEAN_ENVELOPE)
        self.check()
        a_end = len(a.read_text().splitlines())
        self.assertEqual(self.state()["cursors"], {SID_A: a_end})
        self.transcript(SID_B, [urec("b message")])
        os.environ["CLAUDE_CODE_SESSION_ID"] = SID_B
        os.environ["REFINE_CLAUDE_BIN"] = str(self.tmp / "nope")
        self.assertEqual(self.check().split()[0], "unavailable:")
        self.assertEqual(self.state()["cursors"], {SID_A: a_end, SID_B: 0})
        write_jsonl(self.files[SID_A], fixture_records() + [urec("a tail line")])
        self.transcript(SID_C, [urec("c message")])
        os.environ["CLAUDE_CODE_SESSION_ID"] = SID_C
        self.stub(CLEAN_ENVELOPE)
        self.assertEqual(self.check().split()[0], "clean")
        seen = self.last_payload
        for expected in ("a tail line", "b message", "c message"):
            self.assertIn(expected, seen)
        self.assertNotIn("Claude jumps into planning too early.", seen)

    def test_resume_init_registers_session_idempotently(self):
        self.transcript(SID_A, fixture_records())
        self.init_dir()
        review.main(["init", str(self.dir)])
        self.assertEqual(self.state()["cursors"], {SID_A: 0})
        self.assertTrue((self.dir / "snapshot.md").exists())

    def test_unavailable_check_leaves_pending_unchanged(self):
        self.transcript(SID_A, fixture_records())
        self.init_dir()
        self.stub(envelope([finding()]))
        self.check()
        before = self.state()["pending"]
        self.assertTrue(before)
        os.environ["REFINE_CLAUDE_BIN"] = str(self.tmp / "nope")
        self.check()
        self.assertEqual(self.state()["pending"], before)

    def test_accept_advances_snapshot_after_finding(self):
        self.transcript(SID_A, fixture_records())
        self.init_dir()
        self.stub(envelope([finding()]))
        self.check()
        pending = self.state()["pending"]
        self.cmd("accept")
        self.assertEqual((self.dir / "snapshot.md").read_text(), DRAFT_OK)
        self.assertEqual(self.state()["pending"], {})
        self.assertEqual(self.state()["cursors"], pending)

    def test_accept_commits_pending_not_live_line_count(self):
        a = self.transcript(SID_A, fixture_records())
        self.init_dir()
        self.stub(envelope([finding()]))
        self.check()
        write_jsonl(a, fixture_records() + [urec("accept, and rename the Purpose to X")])
        self.cmd("accept")
        self.stub(CLEAN_ENVELOPE)
        self.check()
        self.assertIn("accept, and rename the Purpose to X", self.last_payload)

    def test_revert_restores_draft_from_snapshot(self):
        self.transcript(SID_A, fixture_records())
        self.init_dir()
        (self.dir / "snapshot.md").write_text("OLD DRAFT")
        self.stub(envelope([finding()]))
        self.check()
        self.cmd("revert")
        self.assertEqual((self.dir / "draft.md").read_text(), "OLD DRAFT")

    def test_revert_commits_pending_and_keeps_snapshot(self):
        a = self.transcript(SID_A, fixture_records())
        self.init_dir()
        self.stub(envelope([finding()]))
        self.check()
        pending = self.state()["pending"]
        write_jsonl(a, fixture_records() + [urec("revert it, I never said that")])
        self.cmd("revert")
        st = self.state()
        self.assertEqual(st["pending"], {})
        self.assertEqual(st["cursors"], pending)
        self.assertEqual((self.dir / "snapshot.md").read_text(), "")
        self.stub(CLEAN_ENVELOPE)
        self.check()
        self.assertIn("revert it, I never said that", self.last_payload)
        self.assertNotIn("Claude jumps into planning too early.", self.last_payload)


def ask_records():
    """AskUserQuestion shapes copied from a real session: tool_use input, then a tool_result
    carrying toolUseResult.answers and annotations."""
    q = "Which model should the test sessions run on?"
    use = {"type": "assistant", "message": {"role": "assistant", "content": [{
        "type": "tool_use", "id": "toolu_01", "name": "AskUserQuestion", "input": {"questions": [{
            "question": q, "header": "Test model", "multiSelect": False,
            "options": [{"label": "Opus, both arms", "description": "matches the jump"},
                        {"label": "Sonnet, both arms", "description": "keeps the baseline"}]}]}}]}}
    res = {"type": "user", "message": {"role": "user", "content": [{
        "type": "tool_result", "tool_use_id": "toolu_01",
        "content": 'Your questions have been answered: "Which model..."="Sonnet, both arms".'}]},
        "toolUseResult": {"questions": [{"question": q}], "answers": {q: "Sonnet, both arms"},
                          "annotations": {q: {"notes": "cheaper, and enough"}}}}
    return [use, res]


class RealShapeTest(Base):
    def test_user_messages_skips_compact_summary(self):
        summary = urec("This session is being continued from a previous conversation that ran out of context.",
                       isCompactSummary=True, isVisibleInTranscriptOnly=True)
        p = self.transcript(SID_A, [urec("plain turn"), summary, urec("after compact")])
        self.assertEqual(review.user_messages(p, 0), ["plain turn", "after compact"])

    def test_user_messages_unwraps_skill_order_command_record(self):
        p = self.transcript(SID_A, [urec("<command-message>refine</command-message>\n<command-name>/refine</command-name>\n"
                                         "<command-args>an idea in my words</command-args>")])
        self.assertEqual(review.user_messages(p, 0), ["an idea in my words"])

    def test_user_messages_skips_skill_order_command_without_args(self):
        p = self.transcript(SID_A, [urec("<command-message>handoff</command-message>\n<command-name>/handoff</command-name>")])
        self.assertEqual(review.user_messages(p, 0), [])

    def test_user_messages_reads_ask_user_question_answers_and_notes(self):
        p = self.transcript(SID_A, ask_records())
        msgs = review.user_messages(p, 0)
        self.assertEqual(len(msgs), 1)
        self.assertIn("Sonnet, both arms", msgs[0])
        self.assertIn("cheaper, and enough", msgs[0])

    def test_assistant_text_includes_ask_user_question_options(self):
        p = self.transcript(SID_A, ask_records())
        text = "\n".join(review.assistant_text(p, 0))
        self.assertIn("Which model should the test sessions run on?", text)
        self.assertIn("Opus, both arms", text)

    def test_parse_rejects_non_object_envelope(self):
        self.transcript(SID_A, fixture_records())
        self.init_dir()
        self.stub([])
        self.assertEqual(self.check().split()[0], "unavailable:")


class DraftReviewedTest(Base):
    def test_accept_refuses_when_draft_changed_since_review(self):
        self.transcript(SID_A, fixture_records())
        self.init_dir()
        self.stub(envelope([finding()]))
        self.check()
        (self.dir / "draft.md").write_text(DRAFT_OK + "\nunreviewed edit\n")
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            review.main(["accept", str(self.dir)])
        self.assertTrue(buf.getvalue().startswith("refused:"))
        self.assertEqual((self.dir / "snapshot.md").read_text(), "")
        self.assertTrue(self.state()["pending"])

    def test_accept_snapshots_the_reviewed_draft(self):
        self.transcript(SID_A, fixture_records())
        self.init_dir()
        self.stub(envelope([finding()]))
        self.check()
        self.cmd("accept")
        self.assertEqual((self.dir / "snapshot.md").read_text(), DRAFT_OK)

    def test_stray_accept_after_clean_check_reports_nothing_pending(self):
        self.transcript(SID_A, fixture_records())
        self.init_dir()
        self.stub(CLEAN_ENVELOPE)
        self.check()
        (self.dir / "draft.md").write_text(DRAFT_OK + "\nv3\n")
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            review.main(["accept", str(self.dir)])
        self.assertEqual(buf.getvalue().strip(), "nothing pending")
        self.assertEqual((self.dir / "snapshot.md").read_text(), DRAFT_OK)
        self.assertEqual(self.state()["round"], 1)

    def test_second_accept_is_a_no_op(self):
        self.transcript(SID_A, fixture_records())
        self.init_dir()
        self.stub(envelope([finding()]))
        self.check()
        self.cmd("accept")
        self.cmd("accept")
        self.assertEqual(self.state()["round"], 1)

    def test_revert_clears_pending(self):
        self.transcript(SID_A, fixture_records())
        self.init_dir()
        self.stub(envelope([finding()]))
        self.check()
        self.cmd("revert")
        self.cmd("revert")
        self.assertEqual(self.state()["pending"], {})


class EngineTest(Base):
    def test_local_switch_sets_child_env_only_when_on(self):
        self.transcript(SID_A, fixture_records())
        self.init_dir()
        dump = str(self.tmp / "dump")
        self.stub(CLEAN_ENVELOPE, dump)
        os.environ.pop("ANTHROPIC_BASE_URL", None)
        self.check()
        env = (self.tmp / "dump.env").read_text()
        argv = (self.tmp / "dump.argv").read_text().split("\n")
        self.assertNotIn("ANTHROPIC_BASE_URL", env)
        self.assertIn("--model", argv)
        self.assertEqual(argv[argv.index("--model") + 1], "sonnet")
        os.environ["REFINE_REVIEW_LOCAL"] = "1"
        self.check()
        env = dict(l.split("=", 1) for l in (self.tmp / "dump.env").read_text().splitlines() if "=" in l)
        self.assertEqual(env["ANTHROPIC_BASE_URL"], "http://localhost:11434")
        self.assertEqual(env["ANTHROPIC_AUTH_TOKEN"], "ollama")
        self.assertEqual(env["ANTHROPIC_API_KEY"], "")
        for var in ("ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
                    "ANTHROPIC_DEFAULT_HAIKU_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"):
            self.assertEqual(env[var], "qwen3.6:27b", var)
        self.assertNotIn("ANTHROPIC_BASE_URL", os.environ)

    def test_run_reviewer_returns_cost_and_duration_meta(self):
        env = dict(CLEAN_ENVELOPE, total_cost_usd=0.0123, duration_ms=4567, usage={"output_tokens": 9})
        self.stub(env)
        verdict = review.run_reviewer("payload")
        self.assertEqual(verdict["findings"], [])
        self.assertEqual(verdict["meta"], {"cost_usd": 0.0123, "duration_ms": 4567, "usage": {"output_tokens": 9}})


class CliTest(unittest.TestCase):
    def test_cli_rejects_transcript_flag(self):
        out = subprocess.run([sys.executable, str(REVIEW), "check", "/tmp/x", "--transcript", "/tmp/t.jsonl"],
                             capture_output=True, text=True)
        self.assertEqual(out.returncode, 2)


if __name__ == "__main__":
    unittest.main()
