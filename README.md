# officina-claude

A Claude Code plugin marketplace: session handoffs, token metrics, live plan co-design, offline
diagrams and behaviour-driven scenario matrices, packaged so any project can install them.

| Plugin | What it ships |
|---|---|
| `session` | `/session:refine` (interview a vague idea into an intent draft), `/session:handoff` (a note that lets `/clear` replace `/compact`), and the hooks behind them: handoff-note sweep and consumption marker, title inheritance on resume, and the pivot gate that checks each handoff note against `.claude/intents/<slug>.md`. |
| `token-hygiene` | A `SessionEnd` hook that records per-session token metrics to `~/.claude/metrics/`, and `/token-hygiene:token-dashboard` to chart them. |
| `planner-companion` | Co-design a plan with Claude on a live local web page, with sequence, workflow and ERD diagrams drawn offline by the `diagrams` renderer. |
| `diagrams` | `/diagrams:diagram` draws a sequence, workflow or entity-relationship diagram from compact rows into a standalone HTML page or SVG file. The renderer has no dependencies and needs no network or browser. |
| `scenario-matrix` | `/scenario-matrix:setup` installs a behaviour-driven scenario harness sized to the project's stack; `:matrix` builds and compiles the matrix; `:run` runs it. |

Plugin skills are namespaced by plugin: type `/session:handoff`, not
`/handoff`. The bare name does not resolve.

## Install

In Claude Code:

```
/plugin marketplace add lucaOR/officina-claude
/plugin install session@officina-claude
```

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

### Requirements and scope

- `python3` for the hooks and scripts of `session`, `token-hygiene` and `planner-companion`, and `node` for `token-hygiene`, `planner-companion` and `diagrams`. `scenario-matrix` needs no `python3`.
- `scenario-matrix` needs `node` 20 or later and `npm` in the target project; the `browser` adapter downloads Chromium.
- A fresh clone of this repo needs `npm ci` in `plugins/scenario-matrix` before `bin/test`, because the runtime test assembly symlinks that package's `node_modules`.
- `planner-companion` needs Claude Code 2.1.328 or later. Its page wakes the session through a background
  `Bash` watcher, which was proven on that version and is untested on older ones.
- The refine reviewer and the pivot gate shell out to `claude -p`, so the CLI must be on `PATH`.
- Enable `token-hygiene` per project, not at user scope. Its CSVs under `~/.claude/metrics/`
  carry no project column, so a user-scope install mixes every project into one dataset.
- Per-project state stays in the project: intent files in `.claude/intents/`, paired-role
  notes in `.claude/handoff.local*.md`, the dashboard in `docs/`. Each session hook acts
  only on its own trigger (a handoff note written or read), so it stays quiet in a project
  that never writes one.

## Develop

```
claude --plugin-dir plugins/session        # load a plugin from this checkout
bin/test                                   # every offline test (stdlib unittest, no model calls)
claude plugin validate .                   # marketplace manifest
claude plugin validate plugins/<name>      # one plugin
```

Path rules that keep a plugin portable:

- Inside a `SKILL.md`, refer to the skill's own files as `${CLAUDE_SKILL_DIR}/...`.
- Inside an agent or a `hooks/hooks.json`, refer to plugin files as `${CLAUDE_PLUGIN_ROOT}/...`.
- Never reach into the project's `.claude/` for code. Only the project's data lives there.
- Hook scripts find the project through `$CLAUDE_PROJECT_DIR` and fail open.
- To share code between plugins, link it with a relative symlink that stays inside this repo.
  Installing a plugin copies the link's target in its place, so each installed plugin is
  self-contained. `planner-companion` gets the renderer this way: `skills/plan/scripts/lib/diagram`
  links to `plugins/diagrams/lib`, and `reference/diagram-rows.md` links to that plugin's row reference.

`scenario-matrix`'s `no-project-names` test keeps project-specific names out of the plugin.
It reads them from a gitignored `.project-terms` file at the repo root, one term per line,
and skips that check when the file is absent.

### Refine eval

`plugins/session/skills/refine/eval/` replays interview scenarios against a worktree of a
project that has the `session` plugin enabled. Pass the project to the scorer with
`score_scenario.py <stream> --expect ... --project <worktree>`.
