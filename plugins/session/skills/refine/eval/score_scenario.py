#!/usr/bin/env python3
"""Score the first assistant turn of a headless stream-json run.

usage: score_scenario.py <stream.jsonl> --expect with-skill|baseline
Prints one PASS/FAIL line per criterion; always exits 0 (it reports, the plan reads it).
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

BANNED_SKILLS = ("spike",)
WRITE_TOOLS = ("Write", "Edit", "NotebookEdit")
DESIGN_RE = re.compile(
    r"\b(architecture|implementation plan|file layout|components?|phase \d|step \d|"
    r"we could build|I'd build|design (doc|sketch)|approach(es)?\b|option [A-C1-3])", re.I)
RECOMMEND_RE = re.compile(
    r"\b(I recommend|my recommendation|I'd suggest|I suggest|I would suggest|"
    r"I'd go with|I would go with|you should|my (take|lean)|default to)\b", re.I)
PURPOSE_RE = re.compile(r"\b(problem|opportunity|purpose|what for|what is it for|trying to solve|prompted)\b", re.I)


def first_turn(path):
    """Assistant content blocks up to the first result record."""
    blocks = []
    for line in open(path):
        rec = json.loads(line)
        if rec.get("type") == "result":
            break
        if rec.get("type") == "assistant":
            blocks.extend(rec["message"]["content"])
    return blocks


def main_checkout(project=None):
    """The main checkout of the project the scenario ran against, given any of its worktrees.

    The scorer ships inside the session plugin, so its own location says nothing about the
    project under test: `project` (default: the cwd) names it instead."""
    start = Path(project or Path.cwd()).resolve()
    out = subprocess.run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
                         cwd=start, capture_output=True, text=True)
    if out.returncode != 0:
        return start
    return Path(out.stdout.strip()).parent


def _path_forms(path):
    home = Path.home()
    forms = [str(path)]
    if home in path.parents:
        rel = path.relative_to(home)
        forms += [f"~/{rel}", f"$HOME/{rel}", f"${{HOME}}/{rel}"]
    return forms


def _home_reach(input_values):
    """True when a call cds to, or is rooted at, the home directory itself."""
    home = re.escape(str(Path.home()))
    cd_home = re.compile(rf"\b(?:cd|pushd)\s+[\"']?(?:~|\$HOME|\$\{{HOME\}}|{home})[\"']?(?=[\s;&|)]|$)")
    rooted = {str(Path.home()), "~", "$HOME", "${HOME}"}
    return any(cd_home.search(v) or v.rstrip("/") in rooted for v in input_values)


def _blocks(rec):
    content = rec.get("message", {}).get("content")
    return content if isinstance(content, list) else []


def contaminated(path, project=None):
    """Evidence that a run reached the main checkout: in tool_use inputs of any turn,
    a main-checkout path or a cd/search rooted at $HOME; in tool_result text, a main-checkout path."""
    forms = _path_forms(main_checkout(project))
    hits = set()
    for line in open(path):
        rec = json.loads(line)
        for b in _blocks(rec):
            kind = b.get("type")
            if rec.get("type") == "assistant" and kind == "tool_use":
                dumped = json.dumps(b["input"])
                if _home_reach([v for v in b["input"].values() if isinstance(v, str)]):
                    hits.add("$HOME")
            elif rec.get("type") == "user" and kind == "tool_result":
                dumped = json.dumps(b.get("content"))
            else:
                continue
            hits.update(f for f in forms if f in dumped)
    return sorted(hits)


def refine_dir(p):
    return "/.claude/refine/" in p or p.startswith("~/.claude/refine/")


def criteria(blocks):
    calls = [b for b in blocks if b.get("type") == "tool_use"]
    text = "\n".join(b["text"] for b in blocks if b.get("type") == "text")
    skills = [c["input"].get("skill", "") for c in calls if c["name"] == "Skill"]
    bad_skill = [s for s in skills if s in BANNED_SKILLS]
    agents = [c for c in calls if c["name"] in ("Agent", "Task")]
    writes = [c for c in calls if c["name"] in WRITE_TOOLS and not refine_dir(c["input"].get("file_path", ""))]
    qs = len(re.findall(r"\?(\s|$)", text))
    return [
        ("1 no spike skill", not bad_skill, ",".join(bad_skill)),
        ("2 no subagent and no write outside ~/.claude/refine/", not agents and not writes, f"agents={len(agents)} writes={len(writes)}"),
        ("3 no design/plan/recommendation (regex; manual read decides)", not DESIGN_RE.search(text), (DESIGN_RE.search(text) or [""])[0]),
        ("4 one question, about the Purpose (regex; manual read decides)", qs == 1 and bool(PURPOSE_RE.search(text)), f"questions={qs}"),
        ("5 no recommended answer", not RECOMMEND_RE.search(text), (RECOMMEND_RE.search(text) or [""])[0]),
    ]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("stream")
    ap.add_argument("--expect", choices=("with-skill", "baseline"), required=True)
    ap.add_argument("--project", help="the project (or any worktree of it) the scenario ran "
                    "against; its main checkout must stay untouched. Default: the cwd.")
    args = ap.parse_args()
    for name, ok, detail in criteria(first_turn(args.stream)):
        print(f"{'PASS' if ok else 'FAIL'} {name}" + (f" [{detail}]" if detail else ""))
    hits = contaminated(args.stream, args.project)
    if hits:
        print(f"CONTAMINATED run reached the main checkout via {', '.join(hits)}; exclude and re-run")
    return 0


if __name__ == "__main__":
    sys.exit(main())
