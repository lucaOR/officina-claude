---
effort: medium
name: token-dashboard
description: Use when the user invokes /token-hygiene:token-dashboard, or asks to build, refresh, or open the token-consumption dashboard, or asks how token usage / burn rate / cap consumption is trending, which days or activities burn the most tokens, or whether a token-saving change (caveman mode, knowledge digest, subagent compression) actually moved the numbers.
---

# Token dashboard

Renders `docs/token-dashboard-v4.html` from the personal metrics CSVs and
writes the trend commentary the HTML cannot write for itself.

The chart layer is **not** your job. `scripts/build-dashboard.mjs`
is a pure function of `~/.claude/metrics/*<suffix>.csv` — it does the parsing,
the aggregation and the rendering with zero model tokens. You run it, read its
printed summary, and interpret. Never re-parse the CSVs yourself, never
hand-build a chart, never paste CSV rows into context.

## Run it

```bash
node "${CLAUDE_SKILL_DIR}/scripts/build-dashboard.mjs"            # full available timeframe
node "${CLAUDE_SKILL_DIR}/scripts/build-dashboard.mjs" --json     # same, machine-readable
node "${CLAUDE_SKILL_DIR}/scripts/build-dashboard.mjs" --since 2026-07-20
node "${CLAUDE_SKILL_DIR}/scripts/build-dashboard.mjs" --no-html  # numbers only, skip the render
```

Default output is `docs/token-dashboard-v4.html` (unversioned, local-only).
`--help` lists every flag. The text form is compact and usually enough; reach
for `--json` when you need the per-week array or the top-day class splits.

The metrics themselves come from the `record-session-metrics.js` SessionEnd
hook, so the CSVs only gain rows when a session ends and quiesces. Rebuilding
twice in one session produces identical numbers — that is expected, not a bug.

## Then write the analysis

The script prints facts. Your value is the reading of them. Cover, in this order,
and only where the data supports it:

1. **Headline** — billed total, span, active days, and where the burn rate sits.
2. **Trend** — week over week from the `weekly` table. Check `active_days` on the
   latest week before calling a drop a trend; a partial week always looks lighter.
   Compare `billed_per_turn` and `fresh_per_min` separately: the first is the
   price of a response, the second is the pace of consumption, and they move
   for different reasons.
3. **Mix** — the five activity classes. A shift toward `investigate` means tool
   output is driving the burn; a shift toward `carry` means ambient scaffolding
   (system prompt, tool definitions, CLAUDE.md, compaction summaries) is.
   Those imply opposite levers, so name the lever, not just the number.
   `delegate` is the odd one out: it is not the main thread at all but work done
   inside subagents and workflow agents, so it moves with how much you fan out,
   not with how the conversation is run. Read it against the `delegated` line,
   which splits it into agent spawns and workflow agents and names the heaviest
   workflow run.
4. **Outliers** — the top days, what made them heavy (responses, session count,
   or price per response), and the peak hour.
5. **Mechanism** — `context_fit` regresses billed-per-response on peak resident
   context. A high R² means cost is essentially context residency, which makes
   compacting sooner and trimming what enters context the levers that matter.

State the caveats the script emits when they bear on a claim you are making —
especially that the replay split across classes is a residency heuristic, and
that figures never cross metrics generations.

## Boundaries

- **Design changes go in the template**, `scripts/dashboard.template.html` (in this skill's folder).
  It carries the `/*__DATA__*/` marker the script replaces, and its palette is
  validated against the `dataviz` skill's checks — re-run
  `scripts/validate_palette.js` if you touch the colors.
- **Never delete or rebuild the CSVs.** They are append-only aggregates and the
  only surviving record of sessions whose transcripts have rotated out.
- **Never mix generations.** `.v4` is current and is the first that counts subagent
  transcripts, so every one of its session, segment, day and hour totals includes
  delegated work that `.v3` never opened — on the corpus at the cut, 36% of all
  billed tokens. A `.v4` figure is therefore LARGER than the `.v3` figure for the
  same day, and the difference is not a regression to explain. `.v3` closed a
  response only on a new `message.id` and is otherwise sound; `.v2` re-billed
  responses that had interleaved tool results (+6.3% billed); the unsuffixed legacy
  CSVs double-count roughly 2.1x. All three are frozen. Each generation starts later
  than the last, so sessions whose transcripts rotated away survive only in the older
  set — read that history there, and never sum figures across generations.
- If the user only wants the file refreshed, run the script and report the path.
  Skip the commentary — it costs tokens they did not ask for.
