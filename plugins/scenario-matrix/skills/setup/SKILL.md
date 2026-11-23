---
name: setup
description: Use when the user invokes /scenario-matrix:setup to install the scenario-test harness into the current project (fresh scaffold, or adopting an existing harness in place), /scenario-matrix:setup --upgrade to refresh its plugin-owned files, or /scenario-matrix:setup --add <adapter> to add one more adapter.
argument-hint: "[--upgrade | --add <adapter>]"
---

# /scenario-matrix:setup

You install, upgrade or extend the scenario harness in the user's project. Every deterministic step is a `setup.mjs` subcommand, so you run it and read its output instead of doing the step by hand. Your own work is the judgement: the proposal, `hooks.mjs`, the project modules, and the user's decisions.

Run every command as `node ${CLAUDE_SKILL_DIR}/scripts/setup.mjs <subcommand> <repo> ...`, where `<repo>` is the project root.

## Exit codes

| Code | Meaning | What you do |
|---|---|---|
| 0 | done | continue |
| 1 | a runtime failure; after `verify` or `upgrade`, a failed check; `install`, `upgrade` or `add` with no manifest; adopt when `project-exports.mjs` already exists and the old `index.mjs` has export lines to move | show the output; for `verify` and `upgrade`, show the check table; for the adopt case, merge the lines by hand, then run `regen` |
| 3 | the scenarios directory is dirty or not in git | ask the user to commit or revert; never stash or commit for them |
| 4 | an old export name is no longer provided | see "Adopt: export loop" |
| 5 | `upgrade` or `add` met a file the project edited | see "Edited files" |
| 64 | usage error: a missing argument, an unknown flag, or a repo that is not a directory | fix the arguments and rerun |

## Routing

- No argument: run steps 1 to 6 below.
- `--upgrade`: run `upgrade`, and handle exit 5. `upgrade` runs the offline `verify` itself and prints its table, so step 6 is only needed for `--live`. When the newer plugin needs an npm dependency that `package.json` lacks, `upgrade` adds it (it never changes or removes a pin), names it in its output, and reruns `install` before the verify; tell the user which dependencies were added.
- `--add <adapter>`: run `add <repo> <adapter>`, handle exit 5, then step 6.

`upgrade` and `add` need an existing `.plugin-manifest.json`. If they fail for lack of one, tell the user to run `/scenario-matrix:setup` with no argument first.

## 1. Stack inventory

Run `detect <repo> --json`. It reports the mode (fresh, adopt or upgrade) and, for each adapter that matched, the evidence as `file:line`. If the mode is `upgrade`, say so and suggest `--upgrade` or `--add`, then stop.

## 2. Asset inventory

Read `assets` from the same output. It lists the existing harness files (`_lib`, matrices, scripts, infra), compose files, make targets, runnable bring-up, seed, dump and restore scripts, and `assets.loginState`, the saved browser login state (null when there is none).

## 3. Proposal

Show one table with exactly these columns: need, found, decision, evidence. Include one row per adapter that matched, and one row per asset that bears on a need: bring-up, seed and restore, login state, an existing harness. Cite the `file:line` from `detect` in the evidence column.

A technology with no catalog adapter gets the decision "no adapter: a project lever when a row first needs it".

Then ask the user to confirm or edit the table. Write nothing, and run no `apply`, before they do. Fold their edits into the adapter list.

## 4. Write

Run `plan <repo> --adapters a,b` and read it. Then run `apply <repo> --adapters a,b`.

The plan tells you what `apply` writes. Fresh mode copies the core and the chosen adapters, and generates `adapters.mjs`, `index.mjs` and `harness-api.md`. It seeds `hooks.mjs`, `project-exports.mjs`, `project-api.md`, the config and the docs from templates, and never overwrites one that already exists. Then fill the seeded `hooks.mjs` from the inventory: uncomment the hooks the project needs, and leave a comment wherever the inventory found nothing, as the template shows.

### Adopt

Adopt replaces the existing harness files in place. The plan also lists `replace`, `keep`, `tests replaced`, the export lines moved to `project-exports.mjs`, and `skillMentions`.

1. If `apply` exits 3, ask the user to commit or revert `.claude/scenarios/`, then rerun. The swap must be one reviewable diff.
2. Before you rely on any new test, move the project-specific cases of each replaced test into a `project-*.test.mjs` that tests `hooks.mjs` and the moved modules. Read the old test with `git show HEAD:<path>`. Other tests are kept as they are.
3. Write `hooks.mjs`. For each replaced file, read the old version with `git show HEAD:<path>` against `${CLAUDE_SKILL_DIR}/../../reference/harness-api.md`, and move its project-specific behaviour into hooks or into a project module. Project-owned files stay byte for byte.
4. Write `project-api.md` for the project's own levers and hooks.
5. List the project files that mention the old skills by their bare names (`skillMentions` from the plan). Do not edit them. Tell the user to update them.
6. An existing `package.json`, `README.md` and `AUTHORING.md` are the project's: setup only adds missing dependencies, and leaves the docs alone.

### Adopt: export loop

When `apply` or `regen` exits 4, it names the exports the old `index.mjs` provided and the new one does not. Add the missing names to `project-exports.mjs` or provide them through hooks, then run `regen <repo>`. Repeat until it exits 0.

### An unlisted technology

Write its lever only when a row first needs it. Before writing, answer these five questions in the lever's header comment:

1. How is it stood up for real?
2. How do you know it is ready, without waiting a fixed time?
3. What deterministic marker shows it processed something?
4. How do you force it to fail, and how do you undo that?
5. What does it do that the others don't?

## 5. Install

Run `install <repo>`. It installs the library dependencies and runs each chosen adapter's post-install command.

The plan lists system packages per distribution. Report them to the user to install. Never run `sudo` or a package manager for them yourself.

## 6. Verify

Run `verify <repo>`. It checks each matrix, runs the lint and plan checks, imports `index.mjs`, runs the project's tests, and prints a table. On exit 1, show the table and fix or ask.

The selftest is `verify <repo> --live`. Run it only when the stack is up and the user agrees. Otherwise say the selftest was skipped.

## Edited files

When `upgrade` or `add` exits 5, it names each plugin-owned file the project edited, and its output already carries one diff per file, the plugin's version against the project's. Show the user those diffs from the output, and for each file ask: keep theirs, take the plugin's, or stop. Then rerun with `--take f,g` for the files they want replaced and `--keep f,g` for the files they want kept. A file may not be in both lists. If they choose stop, change nothing.

## Rules

- Never edit a project-owned file except `project-exports.mjs`, `hooks.mjs`, the project modules and the `project-*.test.mjs` files this skill creates.
- Never stash or commit for the user.
- Never install system packages.
