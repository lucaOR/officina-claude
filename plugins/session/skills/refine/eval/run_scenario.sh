#!/usr/bin/env bash
# usage: run_scenario.sh <worktree-dir> <scenario-file> <out-dir> [--with-skill]
# Turns in the scenario file are separated by a line holding only '---'.
# --with-skill prefixes turn 1 with '/session:refine ' (the session plugin must be enabled in the worktree). Writes <out-dir>/<scenario>.stream.jsonl
# (one result record per turn). CLAUDE_PAIR/CLAUDE_ROLE are unset so pair-brief.py
# neither re-stamps the live pair roles nor injects the brief into the run.
set -euo pipefail
wt=$(cd "$1" && pwd); scn=$(realpath "$2"); out=$3; prefix=""
[ "${4:-}" = "--with-skill" ] && prefix="/session:refine "
mkdir -p "$out"; out=$(cd "$out" && pwd)
name=$(basename "$scn" .txt); stream="$out/$name.stream.jsonl"; : > "$stream"
# With the skill, the run writes into the real ~/.claude/refine/. Refuse to start on a dirty
# staging root, and MOVE (never delete) what the run left into the out-dir afterwards.
stage="$HOME/.claude/refine"
if [ -n "$prefix" ] && [ -d "$stage" ] && [ -n "$(ls -A "$stage")" ]; then
  echo "refusing: $stage is not empty; move it away first" >&2; exit 2
fi
turn=0; sid=""
run_turn() {
  local text=$1 args=(-p "$1" --model sonnet --output-format stream-json --verbose)
  [ -n "$sid" ] && args+=(--resume "$sid")
  (cd "$wt" && env -u CLAUDE_PAIR -u CLAUDE_ROLE claude "${args[@]}" </dev/null) >> "$stream"
  sid=$(python3 -c 'import json,sys
for l in open(sys.argv[1]):
    d=json.loads(l)
    if d.get("type")=="result": s=d["session_id"]
print(s)' "$stream")
}
buf=""; nl=$'\n'
flush() { [ -z "$buf" ] && return; turn=$((turn+1)); local t=$buf; [ $turn -eq 1 ] && t="$prefix$buf"; run_turn "$t"; buf=""; }
while IFS= read -r line || [ -n "$line" ]; do
  if [ "$line" = "---" ]; then flush; else buf="${buf:+$buf$nl}$line"; fi
done < "$scn"
flush
if [ -n "$prefix" ] && [ -d "$stage" ] && [ -n "$(ls -A "$stage")" ]; then
  mkdir -p "$out/$name.staging" && mv "$stage"/* "$out/$name.staging"/
fi
