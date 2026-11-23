<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/banner-dark.svg">
    <img src=".github/assets/banner-light.svg" alt="officina-claude, Claude Code plugins from the workshop: session, token-hygiene, planner-companion, diagrams and scenario-matrix">
  </picture>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/plugins-5-D97757" alt="5 plugins">
  <img src="https://img.shields.io/badge/Claude%20Code-plugin%20marketplace-1d1d1f" alt="Claude Code plugin marketplace">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2f7d4f" alt="MIT licence"></a>
</p>

<p align="center">
  Claude Code plugins from the workshop: session handoffs, token metrics, live plan co-design, offline diagrams and behaviour-driven scenario matrices.
</p>

<p align="center">
  <a href="#install">Install</a> · <a href="#pick-by-problem">Pick by problem</a> · <a href="#plugins">Plugins</a> · <a href="#requirements-and-scope">Requirements</a> · <a href="CONTRIBUTING.md">Contributing</a>
</p>

## Install

In Claude Code:

```
/plugin marketplace add lucaOR/officina-claude
/plugin install session@officina-claude
```

Install the other plugins the same way, with their own name before `@officina-claude`.

<details>
<summary>Offer the plugins to everyone who opens a project</summary>

To have a project offer the plugins to everyone who opens it, commit this to the
project's `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "officina-claude": {
      "source": { "source": "github", "repo": "lucaOR/officina-claude" }
    }
  },
  "enabledPlugins": {
    "session@officina-claude": true,
    "token-hygiene@officina-claude": true,
    "planner-companion@officina-claude": true,
    "diagrams@officina-claude": true,
    "scenario-matrix@officina-claude": true
  }
}
```

</details>

Plugin skills are namespaced by plugin: type `/session:handoff`, not
`/handoff`. The bare name does not resolve.

## Pick by problem

| Problem | Plugin |
|---|---|
| `/compact` summaries lose the thread, or a new session starts cold | [`session`](#session) |
| A vague idea needs pinning down before anyone writes code | [`session`](#session) (`/session:refine`) |
| You can't tell which sessions or habits burn your token budget | [`token-hygiene`](#token-hygiene) |
| A plan drifts from what you meant, and reviewing it in the terminal is slow | [`planner-companion`](#planner-companion) |
| You want a sequence, workflow or ER diagram without Mermaid, a browser or network | [`diagrams`](#diagrams) |
| Behaviour regressions slip through because nobody lists the scenarios | [`scenario-matrix`](#scenario-matrix) |

## Plugins

The examples below come from one demo project, a small bookshop's checkout. The screenshots and
diagrams are real plugin output. The handoff note and the scenario row are written by hand, in
the formats the plugins use.

### `session`

`/session:handoff` writes the session's state to a note under `~/.claude/handoff/` and prints a
one-line pointer to that note. You run `/clear` and paste the pointer, so the next session
starts from the note instead of from a `/compact` summary and the conversation it retains.
`/session:refine` interviews you about a vague idea before any of that, one question per
message, until the idea becomes an intent draft with a purpose, done-criteria and non-goals.
Once you commit that draft as `.claude/intents/<slug>.md`, each handoff note quotes its goal
verbatim, and the pivot gate checks each new note against it.

- `/session:handoff`: write the note and print the pointer. `boundary` or `mid` forces the
  mode, which is a result summary for a finished task and a working-state snapshot for an
  unfinished one.
- `/session:refine`: interview a vague idea into an intent draft at
  `~/.claude/refine/<slug>/draft.md`. `/session:refine resume <slug>` picks one up again.
- Hooks, which need no command: the pivot gate judges each note against its intent file in the
  background and reports the verdict at the next session start; the new session inherits the
  `/rename` title of the session it continues; and a sweep at session start deletes a note once
  it was read more than a day ago.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/handoff-loop-dark.svg">
  <img src=".github/assets/handoff-loop-light.svg" alt="Workflow diagram of the handoff loop: work on a task, /session:handoff writes a note, /clear, the next session reads the note, and a check asks whether the intent still matches. A yes continues the work, and a pivot goes back to the task.">
</picture>

A boundary note from the demo. The first line is the pointer that you paste after `/clear`,
and the rest is the note it points to:

```
read /home/you/.claude/handoff/8c41f0d2-7a3e-4b19-9e65-1f2a0c7d3b58.md — HANDOFF v1 mode=boundary parent=8c41f0d2-7a3e-4b19-9e65-1f2a0c7d3b58

HANDOFF v1 mode=boundary parent=8c41f0d2-7a3e-4b19-9e65-1f2a0c7d3b58 depth=2 budget=38/120 intent=stock-reservation@3e9a7c21
goal: "A reader can never buy a copy that is already sold. Done when two readers who check out the last copy at once get one order and one sold-out message."
shipped: the reservation step in orders/checkout.ts:88 and its release on a declined card at orders/checkout.ts:131; checkout tests pass
owed: no commit yet; no test covers two readers checking out the last copy at once
next: write the two-readers test, then commit the reservation work with it
branch: feat/stock-reservation
transcript: /home/you/.claude/projects/-demo-bookshop/8c41f0d2-7a3e-4b19-9e65-1f2a0c7d3b58.jsonl
```

### `token-hygiene`

A `SessionEnd` hook records each session's token use, subagents included, in CSV files under
`~/.claude/metrics/`. `/token-hygiene:token-dashboard` turns those files into a local HTML
dashboard with billed tokens per day, the burn rate, cache behaviour and the split by activity
class. Claude then writes a short reading of the trend, which names what drives the burn and
the lever that would cut it.

- `/token-hygiene:token-dashboard`: build `docs/token-dashboard-v4.html` and read the trend. Ask
  for the file alone and Claude skips the commentary.
- The `SessionEnd` hook needs no command. Enable the plugin per project, as
  [Requirements and scope](#requirements-and-scope) explains.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/dashboard-dark.webp">
  <img src=".github/assets/dashboard-light.webp" alt="The token dashboard for the demo project: 613M billed tokens over 20 active days, tiles for fresh tokens, cache replay, burn rate, cost per response, delegated work and compactions, and a bar chart of billed tokens per day.">
</picture>

### `planner-companion`

`/planner-companion:plan` co-designs a plan with you on a live local web page, so you review it
there rather than in the terminal. After an interview in the terminal, Claude puts each decision
that changes what gets built on the page as a card with two or three options, a recommended pick
and what each option trades off. On the page you pick options, comment, request changes and undo
them, and a background watcher wakes the session to answer each one. When the plan is done,
the page's "Create the real plan" button writes it out as a `plan.md`.

- `/planner-companion:plan <what to plan>`: interview, then open the plan page and fill it.
- `/planner-companion:plan reopen <plan-folder>`: restart the page for an unfinished review. A
  `SessionStart` hook prints this line for every review left unfinished.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/plan-dark.webp">
  <img src=".github/assets/plan-light.webp" alt="The plan page for the bookshop checkout: an overview of four decisions, one still open, and three tasks, above a sequence diagram of the checkout from the reader to the stock service.">
</picture>

### `diagrams`

`/diagrams:diagram` draws a sequence diagram, a workflow or an entity-relationship diagram from
a few compact JSON rows. The renderer is plain Node with no dependencies, so it needs no
Mermaid, no browser and no network. It writes a standalone HTML page that follows the system's
light or dark theme, or an SVG file that carries its own styles. `planner-companion` draws its
plan diagrams with the same renderer.

- `/diagrams:diagram`: describe the diagram you want. Claude also uses the skill on its own when
  you ask for one of these three kinds of diagram.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/checkout-sequence-dark.svg">
  <img src=".github/assets/checkout-sequence-light.svg" alt="Sequence diagram of the bookshop checkout: the reader checks out the basket, the shop web posts the order, and the orders API reserves the books, charges the card through payments, commits the stock and returns the order summary.">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/catalogue-erd-dark.svg">
  <img src=".github/assets/catalogue-erd-light.svg" alt="Entity-relationship diagram of the bookshop catalogue: Author, Book, Customer, Order and OrderLine, with their keys and many-to-one relationships.">
</picture>

### `scenario-matrix`

`scenario-matrix` keeps a behaviour-driven test matrix for each epic in
`.claude/scenarios/<epic>.yaml`. Each row is one observable behaviour, and its `expected` comes
from the epic's intent, never from what the code does today. `/scenario-matrix:setup` installs a
Node harness sized to the project's stack, with adapters for a browser, HTTP, SQL databases,
Docker and more. `/scenario-matrix:matrix` compiles each row into an executable script, and
`/scenario-matrix:run` runs the scripts and writes a report of the bugs it found.

- `/scenario-matrix:setup`: detect the stack, propose the adapters and install them once you
  confirm. `--upgrade` refreshes the plugin-owned files, and `--add <adapter>` adds one more.
- `/scenario-matrix:matrix <epic> build | add "<behaviour>" | compile`: derive the matrix from
  the epic's intent, add one row, or compile rows into scripts.
- `/scenario-matrix:run <epic> [<id> | <family>]`: run one scenario, a family or the whole
  matrix. `--plan` lists which scripts are fresh, stale or uncompiled.

A row in `.claude/scenarios/checkout.yaml`, as the run left it:

```yaml
  - id: C-02
    behaviour: "two readers buy the last copy at once: one order, one sold-out message"
    reach: wiring
    priority: P1
    setup:
      - db: {target: scn_shop, sql: "UPDATE book SET stock = 1 WHERE id = 42"}
    steps:
      - action: "POST /orders for book 42 as two customers at the same moment"
    expected: "one 201 and one 409 sold_out; book 42 ends with stock = 0"
    status: drift
    last_run: "2026-11-20 KO"
    bug_ref: BUG-1
    script: _scripts/checkout/C-02.mjs
    compiled_from: 4b7e19c0a2d3
    compiled: "verified 2026-11-18"
```

The start of that run's report:

```markdown
# checkout run 2026-11-20
Suite: 3 scenarios — compiled 3/3 — 2 OK · 1 KO
Ran `run.mjs checkout` -> provisioned -> ran suite -> torn down
(the config's `lifecycle.down` command). Ambient dev stack restored.

| id   | behaviour                        | result | runtime | why |
|------|----------------------------------|--------|---------|-----|
| C-01 | books reserved before the charge | OK     | 2.4s    |     |
| C-02 | last copy, two readers at once   | KO     | 3.1s    | expected one 409, got two 201s (stock went to -1) |
| C-03 | declined card releases the stock | OK     | 2.7s    |     |

## Bugs found

### BUG-1 · the last copy can be sold twice
```

## Requirements and scope

- `python3` for the hooks and scripts of `session`, `token-hygiene` and `planner-companion`, and `node` for `token-hygiene`, `planner-companion` and `diagrams`. `scenario-matrix` needs no `python3`.
- `scenario-matrix` needs `node` 20 or later and `npm` in the target project; the `browser` adapter downloads Chromium.
- `planner-companion` needs Claude Code 2.1.328 or later. Its page wakes the session through a background
  `Bash` watcher, which was proven on that version and is untested on older ones.
- The refine reviewer and the pivot gate shell out to `claude -p`, so the CLI must be on `PATH`.
- Enable `token-hygiene` per project, not at user scope. Its CSVs under `~/.claude/metrics/`
  carry no project column, so a user-scope install mixes every project into one dataset.
- Per-project state stays in the project: intent files in `.claude/intents/`, paired-role
  notes in `.claude/handoff.local*.md`, the dashboard in `docs/`. Each session hook acts
  only on its own trigger (a handoff note written or read), so it stays quiet in a project
  that never writes one.

---

Released under the [MIT licence](LICENSE). To work on the plugins themselves, see
[CONTRIBUTING.md](CONTRIBUTING.md).
