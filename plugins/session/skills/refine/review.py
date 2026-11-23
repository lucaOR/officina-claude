#!/usr/bin/env python3
"""Integrity reviewer helper for the /refine skill.

usage: review.py init <dir> | check <dir> [--final] | accept <dir> | revert <dir> | lint <dir> [--final]

<dir> is the staging dir ~/.claude/refine/<slug>/ holding draft.md, snapshot.md, state.json.
`check` prints `clean`, `finding` or `unavailable: <cause>` as its first words and always exits 0.
"""
import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

PROMPT = Path(__file__).parent / "reviewer_prompt.md"
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
KINDS = ("purpose-shift", "unput-change", "misattributed", "assumption-filled",
         "how-before-what", "progress-toward-build")
FINDING_KEYS = ("kind", "quote", "evidence", "reason")
NOISE_PREFIXES = ("<local-command-", "<system-reminder>", "<cross-session-message", "<task-notification")
COMMAND_PREFIXES = ("<command-name>", "<command-message>")
ARGS_RE = re.compile(r"<command-args>(.*?)</command-args>", re.S)
FINAL_SECTIONS = ("Verbatim ask", "DEFINITIONS", "Done-criteria", "Non-goals", "Budget", "Open questions")
LOCAL_MODEL_VARS = ("ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
                    "ANTHROPIC_DEFAULT_HAIKU_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL")
DISALLOWED = "Read Write Edit Glob Grep Task WebSearch TodoWrite NotebookEdit"


class ReviewerUnavailable(Exception):
    pass


def _lines_after(transcript, since_line):
    with open(transcript) as fh:
        for n, line in enumerate(fh):
            if n < since_line or not line.strip():
                continue
            try:
                yield json.loads(line)
            except ValueError:
                continue


def _line_count(transcript):
    with open(transcript) as fh:
        return sum(1 for _ in fh)


def _ask_answers(rec):
    """User answers to an AskUserQuestion call, which arrive as a tool_result carrying toolUseResult.answers."""
    result = rec.get("toolUseResult")
    if rec.get("type") != "user" or not isinstance(result, dict) or not isinstance(result.get("answers"), dict):
        return None
    notes = result.get("annotations") if isinstance(result.get("annotations"), dict) else {}
    lines = []
    for question, answer in result["answers"].items():
        note = (notes.get(question) or {}).get("notes") if isinstance(notes.get(question), dict) else None
        lines.append(f"[answer to AskUserQuestion] {question} = {answer}" + (f" (note: {note})" if note else ""))
    return "\n".join(lines) or None


def _typed_text(rec):
    """The text the user typed in a `user` record, or None when it is not a user statement."""
    if rec.get("type") != "user" or rec.get("isMeta"):
        return None
    if rec.get("isCompactSummary") or rec.get("isVisibleInTranscriptOnly"):
        return None
    answers = _ask_answers(rec)
    if answers:
        return answers
    content = rec.get("message", {}).get("content")
    if isinstance(content, list):
        content = "\n".join(b.get("text", "") for b in content if b.get("type") == "text") or None
    if not isinstance(content, str):
        return None
    text = content.strip()
    if text.startswith(COMMAND_PREFIXES):
        m = ARGS_RE.search(text)
        return (m.group(1).strip() or None) if m else None
    if not text or text.startswith(NOISE_PREFIXES):
        return None
    return text


def user_messages(transcript, since_line):
    texts = (_typed_text(r) for r in _lines_after(transcript, since_line))
    return [t for t in texts if t]


def _ask_question_text(block):
    lines = []
    for q in block.get("input", {}).get("questions", []):
        lines.append(f"[AskUserQuestion] {q.get('question', '')}")
        lines += [f"- {o.get('label', '')}: {o.get('description', '')}" for o in q.get("options", [])]
    return "\n".join(lines)


def assistant_text(transcript, since_line):
    out = []
    for rec in _lines_after(transcript, since_line):
        if rec.get("type") != "assistant":
            continue
        for b in rec["message"]["content"]:
            if b.get("type") == "text" and b.get("text"):
                out.append(b["text"])
            if b.get("type") == "tool_use" and b.get("name") == "AskUserQuestion":
                out.append(_ask_question_text(b))
    return out


def _locate_by_name(session_id):
    if not session_id or not UUID_RE.match(session_id):
        return None
    for d in sorted((Path.home() / ".claude" / "projects").glob("*")):
        f = d / f"{session_id}.jsonl"
        if f.is_file():
            return f
    return None


def locate_transcript(session_id=None):
    """Transcript of `session_id` (default: CLAUDE_CODE_SESSION_ID), by name only.

    No newest-file fallback: with a concurrent session that would read the wrong
    conversation as "what the user said".
    """
    return _locate_by_name(session_id or os.environ.get("CLAUDE_CODE_SESSION_ID"))


def lint_draft(text, final):
    problems = []
    status = re.search(r"^status:\s*(\S+)", text, re.M)
    if status and status.group(1) == "done":
        problems.append("status header is `done`; only the user sets status")
    headings = re.findall(r"^## (.+?)\s*$", text, re.M)
    problems += _lint_purpose(text, headings)
    if final:
        problems.extend(_lint_final(text, headings))
    return problems


def _lint_purpose(text, headings):
    if not headings or headings[0] != "Purpose":
        return ["first section after the header must be `## Purpose`"]
    purpose = re.split(r"^## ", text.split("## Purpose", 1)[1], maxsplit=1, flags=re.M)[0]
    kind = re.search(r"^Kind:\s*([A-Za-z]+)", purpose, re.M)
    if kind and kind.group(1).lower() in ("problem", "opportunity", "both"):
        return []
    return ["Purpose needs a `Kind:` line whose kind is problem, opportunity or both"]


def _lint_final(text, headings):
    problems = []
    positions = [headings.index(s) if s in headings else -1 for s in FINAL_SECTIONS]
    problems += [f"final draft is missing section `{s}`" for s, p in zip(FINAL_SECTIONS, positions) if p < 0]
    present = [p for p in positions if p >= 0]
    if present != sorted(present):
        problems.append("final draft sections are out of order: expected " + ", ".join(FINAL_SECTIONS))
    if "DEFINITIONS" not in headings:
        return problems
    body = re.split(r"^## ", text.split("## DEFINITIONS", 1)[1], maxsplit=1, flags=re.M)[0]
    for bullet in re.split(r"^(?=- )", body, flags=re.M):
        if not bullet.startswith("- "):
            continue
        if "exhaustive" in bullet.lower():
            continue
        name = re.match(r"- \*\*(.+?)\*\*", bullet)
        problems.append(f"DEFINITIONS line `{name.group(1) if name else bullet[:40].strip()}` does not say whether it is exhaustive")
    return problems


def build_input(snapshot, draft, users, claude, final):
    def block(title, items):
        return f"=== {title} ===\n" + ("\n\n".join(f"[{i + 1}] {t}" for i, t in enumerate(items)) or "(none)")
    return "\n\n".join([
        f"=== MODE ===\n{'final' if final else 'round'}",
        f"=== LAST ACCEPTED SNAPSHOT ===\n{snapshot or '(empty)'}",
        f"=== CURRENT DRAFT ===\n{draft}",
        block("USER MESSAGES SINCE THE SNAPSHOT", users),
        block("CLAUDE TEXT SINCE THE SNAPSHOT", claude),
    ]) + "\n"


def _child_env():
    env = dict(os.environ)
    if os.environ.get("REFINE_REVIEW_LOCAL") != "1":
        return env
    model = os.environ.get("REFINE_REVIEW_LOCAL_MODEL", "qwen3.6:27b")
    env["ANTHROPIC_BASE_URL"] = os.environ.get("REFINE_REVIEW_LOCAL_URL", "http://localhost:11434")
    env["ANTHROPIC_AUTH_TOKEN"] = "ollama"
    env["ANTHROPIC_API_KEY"] = ""
    env.update({v: model for v in LOCAL_MODEL_VARS})
    return env


def _parse_findings(stdout):
    try:
        envelope = json.loads(stdout)
    except ValueError:
        raise ReviewerUnavailable("reviewer output is not JSON")
    if not isinstance(envelope, dict):
        raise ReviewerUnavailable("reviewer output is not a JSON object")
    if envelope.get("is_error"):
        raise ReviewerUnavailable("reviewer reported an error")
    m = re.search(r"\{.*\}", str(envelope.get("result", "")), re.S)
    try:
        verdict = json.loads(m.group(0)) if m else None
    except ValueError:
        verdict = None
    if not isinstance(verdict, dict) or not isinstance(verdict.get("findings"), list):
        raise ReviewerUnavailable("reviewer output has no findings list")
    for f in verdict["findings"]:
        if not isinstance(f, dict) or any(not isinstance(f.get(k), str) for k in FINDING_KEYS) or f["kind"] not in KINDS:
            raise ReviewerUnavailable("reviewer returned a malformed finding")
    verdict["meta"] = {"cost_usd": envelope.get("total_cost_usd"), "duration_ms": envelope.get("duration_ms"),
                       "usage": envelope.get("usage")}
    return verdict


def run_reviewer(payload):
    try:
        system = PROMPT.read_text()
    except OSError:
        raise ReviewerUnavailable("reviewer prompt missing")
    cmd = [os.environ.get("REFINE_CLAUDE_BIN", "claude"), "--print", "--output-format", "json",
           "--no-session-persistence", "--strict-mcp-config", "--restricted",
           "--disallowed-tools", DISALLOWED, "--model", "sonnet", "--system-prompt", system]
    try:
        proc = subprocess.run(cmd, input=payload, capture_output=True, text=True, cwd="/", env=_child_env(),
                              timeout=float(os.environ.get("REFINE_REVIEW_KILL", "120")))
    except FileNotFoundError:
        raise ReviewerUnavailable("claude binary not found")
    except subprocess.TimeoutExpired:
        raise ReviewerUnavailable("reviewer timed out")
    except OSError as e:
        raise ReviewerUnavailable(f"reviewer could not start: {e.strerror}")
    if proc.returncode != 0:
        raise ReviewerUnavailable(f"reviewer exited {proc.returncode}")
    return _parse_findings(proc.stdout)


def _read(path, default=""):
    return Path(path).read_text() if Path(path).exists() else default


def _load_state(d):
    state = json.loads(_read(d / "state.json", "{}") or "{}")
    state.setdefault("cursors", {})
    state.setdefault("pending", {})
    state.setdefault("round", 0)
    return state


def _save_state(d, state):
    (d / "state.json").write_text(json.dumps(state, indent=1))


def _register(state):
    sid = os.environ.get("CLAUDE_CODE_SESSION_ID", "")
    if UUID_RE.match(sid):
        state["cursors"].setdefault(sid, 0)
    return sid


def cmd_init(d):
    d.mkdir(parents=True, exist_ok=True)
    state = _load_state(d)
    _register(state)
    _save_state(d, state)
    for name in ("draft.md", "snapshot.md"):
        if not (d / name).exists():
            (d / name).write_text("")
    return 0


def _gather(state):
    """User and assistant text from every cursor session; returns (users, claude, ends)."""
    users, claude, ends = [], [], {}
    for sid, cursor in state["cursors"].items():
        path = locate_transcript(sid)
        if path is None:
            raise ReviewerUnavailable("no transcript" if sid == os.environ.get("CLAUDE_CODE_SESSION_ID") else f"transcript {sid} missing")
        ends[sid] = _line_count(path)
        users += user_messages(path, cursor)
        claude += assistant_text(path, cursor)
    return users, claude, ends


def _format_findings(findings):
    lines = ["finding", "", "Reviewer findings (verbatim):"]
    for i, f in enumerate(findings, 1):
        lines += [f"{i}. [{f['kind']}] {f['reason']}", f"   quote: {f['quote']}", f"   evidence: {f['evidence']}"]
    return "\n".join(lines)


def cmd_check(d, final):
    d.mkdir(parents=True, exist_ok=True)
    state = _load_state(d)
    sid = _register(state)
    _save_state(d, state)
    if not sid:
        print("unavailable: no transcript")
        return 0
    try:
        users, claude, ends = _gather(state)
        snapshot, draft = _read(d / "snapshot.md"), _read(d / "draft.md")
        payload = build_input(snapshot, draft, users, claude, final)
        (d / "last_input.txt").write_text(payload)
        verdict = run_reviewer(payload)
    except ReviewerUnavailable as e:
        print(f"unavailable: {e}")
        return 0
    if verdict["findings"]:
        state["pending"] = ends
        (d / "reviewed.md").write_text(draft)
        _save_state(d, state)
        print(_format_findings(verdict["findings"]))
        return 0
    (d / "snapshot.md").write_text(draft)
    (d / "reviewed.md").unlink(missing_ok=True)
    state["cursors"] = dict(ends)
    state["pending"] = {}
    state["round"] += 1
    _save_state(d, state)
    print("clean")
    return 0


def _commit_pending(d, advance_snapshot):
    state = _load_state(d)
    if not state["pending"]:
        print("nothing pending")
        return 0
    reviewed = _read(d / "reviewed.md")
    if advance_snapshot and _read(d / "draft.md") != reviewed:
        print("refused: draft changed since the review; run check again")
        return 0
    if advance_snapshot:
        (d / "snapshot.md").write_text(reviewed)
        state["round"] += 1
    else:
        (d / "draft.md").write_text(_read(d / "snapshot.md"))
    (d / "reviewed.md").unlink(missing_ok=True)
    state["cursors"] = dict(state["pending"])
    state["pending"] = {}
    _save_state(d, state)
    print("accepted" if advance_snapshot else "reverted")
    return 0


def cmd_lint(d, final):
    problems = lint_draft(_read(d / "draft.md"), final)
    print("\n".join(problems) if problems else "ok")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(prog="review.py")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("init", "check", "accept", "revert", "lint"):
        p = sub.add_parser(name)
        p.add_argument("dir", type=Path)
        if name in ("check", "lint"):
            p.add_argument("--final", action="store_true")
    args = ap.parse_args(argv)
    if args.cmd == "init":
        return cmd_init(args.dir)
    if args.cmd == "check":
        return cmd_check(args.dir, args.final)
    if args.cmd == "lint":
        return cmd_lint(args.dir, args.final)
    return _commit_pending(args.dir, advance_snapshot=args.cmd == "accept")


if __name__ == "__main__":
    sys.exit(main())
