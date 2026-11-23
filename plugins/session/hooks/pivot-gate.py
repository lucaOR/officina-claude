#!/usr/bin/env python3
"""Pivot gate: advisory escalation on every handoff note, delivered asynchronously.

Wired per .claude/intents/pivot-gate-wiring.md (amendment 1). The DEFINITIONS there are
the contract; this docstring only says where each one lands in the code.

Three roles, one file:
  - PostToolUse, matcher Write|Edit|Bash. Write/Edit: `tool_input.file_path` names a
    ~/.claude/handoff/<session-id>.md note. Bash: the command text names such a path AND
    the note's mtime is within the last minute, so a `cat` of an old note is not a write.
    On a hit: parse `intent=`, run the intents diff check, then either print `skipped`
    (no intent file) or write a `pending` sidecar and spawn the worker, fully detached.
    Prints nothing on queue.
  - Worker (`--worker <note>`): runs run_gate.sh unchanged (stateless `claude -p`,
    restricted tools, gate_prompt.md as system prompt, sonnet) against the intent file's
    HEAD blob, under a safety kill, and writes the final form into the sidecar.
  - SessionStart(startup|resume|clear, exhaustive; compact excluded, same writer, no reader):
    over notes in ~/.claude/handoff/ newer than 24h, reports each
    complete, unreported sidecar (escalations first, then unavailable, then passes) and
    marks it reported; re-spawns a note with no sidecar or a `pending` older than the
    re-spawn threshold; silent on a fresh `pending`.

The sidecar <note>.gate.json is one per note and the only thing the worker writes besides
its own temp dir, so concurrent workers share nothing.

Advisory only: every exit is 0; nothing here touches the note, the tool call or the intent
file. Output lines go on `systemMessage` + `hookSpecificOutput.additionalContext` + the
sidecar; plain stdout at exit 0 reaches neither the user nor the model.

Env knobs, for the done-criteria only: PIVOT_GATE_CLAUDE_BIN (a missing binary yields
the `unavailable` form), PIVOT_GATE_KILL (seconds), PIVOT_GATE_RESPAWN (seconds).
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HOOK_DIR = Path(__file__).resolve().parent / "pivot-gate"
RUN_GATE = HOOK_DIR / "run_gate.sh"
HANDOFF_DIR = Path.home() / ".claude" / "handoff"
SAFETY_KILL = int(os.environ.get("PIVOT_GATE_KILL", str(20 * 60)))       # UNMEASURED
RESPAWN_AFTER = int(os.environ.get("PIVOT_GATE_RESPAWN", str(25 * 60)))  # UNMEASURED, > kill
BASH_FRESHNESS = 60              # seconds; a Bash call that names an older note is a read
STARTUP_MAX_AGE = 24 * 3600
FINAL_FORMS = ("pass", "escalate", "skipped", "unavailable", "backfill")
REPORT_ORDER = {"escalate": 0, "unavailable": 1, "skipped": 2, "pass": 3}

NOTE_RE = re.compile(r"(~|\$HOME|/home/[^/\s\"']+)/\.claude/handoff/([A-Za-z0-9._-]+\.md)(?![\w.])")
HEADER_RE = re.compile(r"^HANDOFF v\d+ .*?\bintent=(\S+)", re.M)


def root() -> Path:
    return Path(os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd())


def is_note(p: Path) -> bool:
    return p.suffix == ".md" and p.parent == HANDOFF_DIR and p.is_file()


def sidecar(note: Path) -> Path:
    return note.with_name(note.name + ".gate.json")


def read_sidecar(note: Path) -> dict | None:
    try:
        return json.loads(sidecar(note).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def write_sidecar(note: Path, rec: dict) -> None:
    try:
        sidecar(note).write_text(json.dumps(rec, indent=1), encoding="utf-8")
    except OSError:
        pass


# --- which notes did this event touch -------------------------------------------------

def notes_from_tool(data: dict) -> list[Path]:
    tool = data.get("tool_name")
    inp = data.get("tool_input") or {}
    if tool in ("Write", "Edit"):
        fp = inp.get("file_path")
        if not isinstance(fp, str):
            return []
        p = Path(fp).expanduser()
        return [p] if is_note(p) else []
    if tool != "Bash":
        return []
    cmd = inp.get("command")
    if not isinstance(cmd, str):
        return []
    now = time.time()
    out = []
    for _, name in NOTE_RE.findall(cmd):
        p = HANDOFF_DIR / name
        if not is_note(p) or p in out:
            continue
        if now - p.stat().st_mtime > BASH_FRESHNESS:
            continue
        out.append(p)
    return out


def notes_for_startup() -> list[Path]:
    if not HANDOFF_DIR.is_dir():
        return []
    cutoff = time.time() - STARTUP_MAX_AGE
    found = [p for p in HANDOFF_DIR.glob("*.md") if p.is_file() and p.stat().st_mtime >= cutoff]
    return sorted(found, key=lambda p: p.stat().st_mtime)


# --- the fast part: header, diff check, queue ------------------------------------------

def intent_slug(note_text: str) -> str | None:
    """`<slug>@<hash8>` / `<slug>@dirty` / `<slug>` -> slug; `-` or no header -> None."""
    m = HEADER_RE.search(note_text)
    if not m:
        return None
    value = m.group(1)
    if value == "-":
        return None
    return value.split("@", 1)[0]


def git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=root(), capture_output=True, text=True)


def intent_blob(slug: str) -> tuple[str | None, bool]:
    """(HEAD blob text or None, working copy dirty?) for .claude/intents/<slug>.md."""
    rel = f".claude/intents/{slug}.md"
    dirty = git("diff", "--quiet", "HEAD", "--", rel).returncode != 0
    shown = git("show", f"HEAD:{rel}")
    if shown.returncode != 0:
        return None, dirty
    return shown.stdout, dirty


def queue(note: Path) -> list[str]:
    """Do the inline work for one note. Returns the lines to print now (skipped only)."""
    rec = {"note": str(note), "id": note.stem, "at": time.time(), "intent": None,
           "form": "pending", "lines": [], "reported_at": None}
    try:
        text = note.read_text(encoding="utf-8")
    except OSError as e:
        rec["form"] = "unavailable"
        rec["lines"] = [f"pivot-gate: unavailable {note.stem} — cannot read note: {e}"]
        write_sidecar(note, rec)
        return []
    slug = intent_slug(text)
    rec["intent"] = slug
    if slug is None:
        rec["form"] = "skipped"
        rec["lines"] = [f"pivot-gate: skipped {note.stem} — no intent file (intent=-)"]
        rec["reported_at"] = time.time()         # printed now, never repeated at startup
        write_sidecar(note, rec)
        return rec["lines"]
    intent_text, dirty = intent_blob(slug)
    if dirty:
        rec["lines"].append("pivot-gate: intent file has uncommitted changes — a draft, "
                            "not an amendment; the check ran against HEAD")
    if intent_text is None:
        rec["form"] = "unavailable"
        rec["lines"].append(f"pivot-gate: unavailable {note.stem} — no committed intent file for {slug}")
        write_sidecar(note, rec)
        return []
    rec["intent_head"] = git("rev-parse", f"HEAD:.claude/intents/{slug}.md").stdout.strip()[:8]
    write_sidecar(note, rec)
    spawn_worker(note)
    return []


def spawn_worker(note: Path) -> None:
    """Fully detached: own session, no inherited stdio, survives hook, session and terminal."""
    env = dict(os.environ, CLAUDE_PROJECT_DIR=str(root()))
    subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve()), "--worker", str(note)],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True, close_fds=True, cwd="/", env=env)


# --- the worker: one claude -p call, result into the sidecar ------------------------------

def run_check(intent_text: str, note: Path) -> dict:
    """Return the gate's verdict dict, or raise RuntimeError with the `unavailable` cause."""
    with tempfile.TemporaryDirectory(prefix="pivot-gate-") as tmp:
        intent_file = Path(tmp) / "intent.md"
        intent_file.write_text(intent_text, encoding="utf-8")
        out_dir = Path(tmp) / "out"
        env = dict(os.environ)
        claude_bin = os.environ.get("PIVOT_GATE_CLAUDE_BIN")
        if claude_bin:
            # run_gate.sh calls `claude` by name; a shim dir puts the override first on PATH.
            # A wrapper script, not a symlink: bash skips a dangling symlink on PATH and
            # falls through to the real binary, so a missing override would never be seen.
            shim = Path(tmp) / "bin"
            shim.mkdir()
            wrapper = shim / "claude"
            wrapper.write_text(f'#!/bin/sh\nexec "{claude_bin}" "$@"\n', encoding="utf-8")
            wrapper.chmod(0o755)
            env["PATH"] = f"{shim}{os.pathsep}{env.get('PATH', '')}"
        try:
            proc = subprocess.run(
                ["bash", str(RUN_GATE), str(intent_file), str(note), "0", str(out_dir), "sonnet"],
                capture_output=True, text=True, timeout=SAFETY_KILL, env=env)
        except subprocess.TimeoutExpired:
            raise RuntimeError(f"killed after {SAFETY_KILL}s")
        except FileNotFoundError as e:
            raise RuntimeError(f"missing CLI: {e}")
        if proc.returncode != 0:
            tail = (proc.stderr or proc.stdout).strip().splitlines()[-1:] or ["no output"]
            raise RuntimeError(f"exit {proc.returncode}: {tail[0][:160]}")
        result_file = out_dir / f"{note.stem}.run0.json"
        try:
            raw = json.loads(result_file.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            raise RuntimeError(f"unparseable CLI output: {e}")
    text = raw.get("result", "") if isinstance(raw, dict) else ""
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise RuntimeError(f"unparseable JSON verdict: {text[:120]!r}")
    try:
        verdict = json.loads(m.group(0))
    except ValueError as e:
        raise RuntimeError(f"unparseable JSON verdict: {e}")
    if verdict.get("verdict") not in ("pass", "escalate"):
        raise RuntimeError(f"unknown verdict {verdict.get('verdict')!r}")
    verdict["duration_s"] = round(raw.get("duration_ms", 0) / 1000, 1)
    verdict["cost_usd"] = raw.get("total_cost_usd")
    return verdict


def worker(note: Path) -> None:
    rec = read_sidecar(note) or {"note": str(note), "id": note.stem, "at": time.time(),
                                 "intent": None, "lines": [], "reported_at": None}
    rec["worker_started_at"] = time.time()
    rec["form"] = "pending"
    write_sidecar(note, rec)
    lines = [l for l in rec.get("lines", []) if "uncommitted changes" in l]   # keep the dirty line
    slug = rec.get("intent")
    intent_text, _ = intent_blob(slug) if slug else (None, False)
    if intent_text is None:
        rec["form"] = "unavailable"
        lines.append(f"pivot-gate: unavailable {note.stem} — no committed intent file for {slug}")
    else:
        try:
            v = run_check(intent_text, note)
            rec["verdict"] = v
            if v["verdict"] == "pass":
                rec["form"] = "pass"
                lines.append(f"pivot-gate: pass {note.stem}")
            else:
                rec["form"] = "escalate"
                lines += [
                    f"pivot-gate: ESCALATE {note.stem} {v.get('definition_touched')} — {v.get('reason')}",
                    f"  old: {v.get('old')}",
                    f"  new: {v.get('new')}",
                ]
        except RuntimeError as e:
            rec["form"] = "unavailable"
            lines.append(f"pivot-gate: unavailable {note.stem} — {e}")
    rec["lines"] = lines
    rec["finished_at"] = time.time()
    write_sidecar(note, rec)


# --- startup: report, re-spawn -----------------------------------------------------------

def startup() -> list[str]:
    now = time.time()
    to_report = []
    for note in notes_for_startup():
        rec = read_sidecar(note)
        if rec is None:
            queue(note)                          # never seen: same path as a fresh write
            continue
        form = rec.get("form")
        if form == "pending":
            started = rec.get("worker_started_at") or rec.get("at") or 0
            if now - started > RESPAWN_AFTER:
                spawn_worker(note)               # older than the kill, so dead by construction
            continue
        if form not in FINAL_FORMS or form == "backfill" or rec.get("reported_at"):
            continue
        to_report.append((REPORT_ORDER.get(form, 9), rec.get("finished_at") or 0, note, rec))
    lines = []
    for _, _, note, rec in sorted(to_report, key=lambda t: (t[0], t[1])):
        lines += rec.get("lines", [])
        rec["reported_at"] = now
        write_sidecar(note, rec)
    return lines


# --- entry --------------------------------------------------------------------------------

def emit(event: str, lines: list[str]) -> None:
    if not lines:
        return
    body = "\n".join(lines)
    print(json.dumps({
        "systemMessage": body,
        "hookSpecificOutput": {"hookEventName": event, "additionalContext": body},
    }))


def main() -> None:
    if len(sys.argv) == 3 and sys.argv[1] == "--worker":
        worker(Path(sys.argv[2]))
        return
    try:
        data = json.load(sys.stdin)
    except ValueError:
        return
    event = data.get("hook_event_name")
    if event == "PostToolUse":
        lines = []
        for note in notes_from_tool(data):
            if read_sidecar(note) is not None:
                continue                         # already gated, never re-gated
            lines += queue(note)
        emit(event, lines)
        return
    if event == "SessionStart" and data.get("source", "startup") in ("startup", "resume", "clear"):
        emit(event, startup())


if __name__ == "__main__":
    try:
        main()
    except Exception as e:                      # advisory: never fail the tool call
        print(json.dumps({"systemMessage": f"pivot-gate: unavailable — hook error: {e}"}))
    sys.exit(0)
