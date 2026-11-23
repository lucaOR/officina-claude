#!/usr/bin/env bash
# Offline pivot-gate runner. One fresh headless `claude -p` per check: no resume,
# no session persistence, no MCP, no project context. Verified against CLI 2.1.274.
#
#   ./run_gate.sh <intent.md> <fixture.md> <run-index> <outdir> [model]
#
# Flags and why each one is here:
#   --print                    non-interactive.
#   --output-format json       gives usage{} so tokens per check are measured, not estimated.
#   --no-session-persistence   nothing is written to ~/.claude/projects; each check is stateless.
#   --strict-mcp-config        with no --mcp-config, this loads zero MCP servers.
#   --restricted               drops Bash/code-running tools and WebFetch from the tool schema.
#   --disallowed-tools         drops the rest; the gate reads its whole input from the prompt.
#   --system-prompt            replaces the default system prompt with the gate contract.
#   cwd=/                      no CLAUDE.md is discovered, so no project rules leak in.
# `--bare` would be the right flag but it refuses OAuth and this machine has no
# ANTHROPIC_API_KEY, so it returns terminal_reason=api_error with zero usage.
set -euo pipefail
INTENT="$(realpath "$1")"; FIXTURE="$(realpath "$2")"; RUN="$3"
OUT="$(realpath "$4")"; MODEL="${5:-sonnet}"
SYS="$(cat "$(dirname "$(realpath "$0")")/gate_prompt.md")"
mkdir -p "$OUT"
NAME="$(basename "$FIXTURE" .md).run$RUN"

{
  printf '=== INTENT FILE ===\n'
  cat "$INTENT"
  printf '\n=== PROPOSED CHANGE ===\n'
  cat "$FIXTURE"
} > "$OUT/$NAME.input"

cd /
claude --print --output-format json --no-session-persistence --strict-mcp-config \
       --restricted --disallowed-tools "Read Write Edit Glob Grep Task WebSearch TodoWrite NotebookEdit" \
       --model "$MODEL" --system-prompt "$SYS" \
       < "$OUT/$NAME.input" > "$OUT/$NAME.json"

python3 - "$OUT/$NAME.json" <<'PY'
import json,sys,re
d=json.load(open(sys.argv[1]))
u=d.get("usage",{})
r=d.get("result","")
m=re.search(r'\{.*\}',r,re.S)
v=json.loads(m.group(0)) if m else {"verdict":"PARSE_FAIL","reason":r[:200]}
print(json.dumps({"verdict":v.get("verdict"),"definition_touched":v.get("definition_touched"),
 "reason":v.get("reason"),"in":u.get("input_tokens",0),
 "cache_create":u.get("cache_creation_input_tokens",0),"cache_read":u.get("cache_read_input_tokens",0),
 "out":u.get("output_tokens",0),"cost_usd":d.get("total_cost_usd"),
 "terminal_reason":d.get("terminal_reason")},indent=1))
PY
