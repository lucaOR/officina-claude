#!/usr/bin/env python3
"""SessionStart hook: remind a new session about plan reviews left unfinished.

A review is unfinished when it has an unanswered question, an open thread whose last message
is the user's, or a working copy different from the real plan (user decision U1). Reads the plan
folders under the plans dir (stdlib only, read-only). Prints nothing when every plan is clean.
Skips a torn jsonl line as lib/queue.mjs does, and otherwise fails open: any error means exit 0
with no output.
"""
import json
import os
import re
import sys
from pathlib import Path


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows = []
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue  # a torn or hand-edited line, skipped like queue.mjs does
    return rows


def read_json(path: Path, default: dict) -> dict:
    return json.loads(path.read_text()) if path.exists() else default


def plural(n: int, noun: str) -> str:
    return f"{n} {noun}" if n == 1 else f"{n} {noun}s"


def review_line(folder: Path, project: Path) -> str | None:
    handled = {row["question"] for row in read_jsonl(folder / "handled.jsonl")}
    unanswered = sum(1 for row in read_jsonl(folder / "questions.jsonl") if row["id"] not in handled)
    threads = read_json(folder / "threads.json", {"threads": []})["threads"]
    waiting = sum(1 for t in threads
                  if t.get("state") != "resolved" and t.get("messages") and t["messages"][-1].get("by") == "user")
    changes = len(read_json(folder / "changes.json", {"log": []})["log"])
    has_plan = (folder / "plan.json").exists()

    parts = []
    if unanswered:
        parts.append(plural(unanswered, "unanswered question"))
    if waiting:
        parts.append(f"{plural(waiting, 'thread')} waiting for a reply")
    if not has_plan:
        parts.append("no real plan yet")
    elif changes:
        parts.append(f"{plural(changes, 'change')} not in the real plan")
    elif read_json(folder / "working.json", {}) != read_json(folder / "plan.json", {}):
        parts.append("edits not in the real plan")  # author patches are not logged as changes
    if not parts:
        return None

    slug = re.sub(r"^\d{4}-\d{2}-\d{2}-", "", folder.name)
    reopen = os.path.relpath(folder, project)
    return f"Open plan review: {slug}, {', '.join(parts)}. Reopen: /planner-companion:plan reopen {reopen}"


def main() -> None:
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        project = Path(os.environ.get("CLAUDE_PROJECT_DIR") or payload.get("cwd") or os.getcwd())
        plans_dir = project / (os.environ.get("PLANNING_PLANS_DIR") or "docs/plans")
        if not plans_dir.is_dir():
            return
        folders = sorted((p for p in plans_dir.iterdir() if (p / "working.json").is_file()),
                         key=lambda p: p.name)
        lines = [line for line in (review_line(f, project) for f in folders) if line]
        if not lines:
            return
        body = "\n".join(lines)
        print(json.dumps({
            "systemMessage": body,
            "hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": body},
        }))
    except Exception:
        return


if __name__ == "__main__":
    main()
