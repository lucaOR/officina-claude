# knowledge

A project knowledge base kept as atomic YAML rules, with the machinery that puts the right rule in front of Claude at the right moment and a scribe agent that keeps the base current. The system works in any project: a single repo, a repo with submodules, git worktrees, a devcontainer, or a project without git.

## What it does

The plugin preserves a six-step loop.

1. **Read.** At session start a digest (`_digest.md`) is injected. It holds a one-line gist of every rule, tiered so that the important rules stay resident.
2. **Write.** Before an `Edit`, `Write` or `MultiEdit`, the bodies of the rules whose `applies_to` matches the file are injected once per session, unless a rule sets `no_jit`.
3. **Check.** After the edit, the `check:` commands of the matching rules run on the file. A `blocking` violation stops the loop until it is fixed.
4. **Capture.** When a session learns something, `knowledge:knowledge-capture` classifies it as ROUTE (it becomes a rule), MEMORY (it is personal and stays in Claude memory), DROP (it is derivable or transient) or ASK. A working session never writes a ROUTE candidate itself. It pushes the observation with `/knowledge:kb <text>` into a queue.
5. **Curate.** A scribe session runs `/knowledge:kb run`. It drains the queue, folds in the check violations of the working diff, presents one combined plan, writes the rules you accept through `knowledge:knowledge-route`, rebuilds the digest and commits according to the project setting.
6. **Measure.** `check.py` and the hooks append to a hit ledger. `report.py` and the dashboard turn it into signals about rules that never fire or fire too often, and the scribe's health sweep brings those signals to you.

## Install

In Claude Code:

```
/plugin marketplace add lucaOR/officina-claude
/plugin install knowledge@officina-claude
```

The plugin needs `python3` on `PATH`. A bundled copy of PyYAML is vendored, so nothing else is installed. Linux, macOS and WSL are supported.

## Setup

Run `/knowledge:setup` in an ordinary session. It is safe to re-run. When the project's knowledge base already holds rules, it skips seeding and only offers the settings questions. A `config.yaml` left by an earlier run does not count, so a run whose seeding failed can seed again.

Setup first lists what it found and then asks in two rounds. The first round chooses the sources to seed from. The second round asks about the scribe commit setting, about registering the plugin for teammates in `.claude/settings.json`, about installing the git gate in this clone, and about installing the `ccscribe` shortcut. Questions that do not apply, such as the commit setting in a project without git, are dropped. When you added the marketplace from a local path, registering enables the plugin but leaves out the marketplace entry, because a local path would not work in anyone else's clone; setup says so, and teammates add the marketplace themselves.

**What seeding reads:**

- The auto-memory of this project, which is ticked by default (`~/.claude/projects/<project slug>/memory/`, where a linked git worktree uses its main checkout's slug as Claude Code does, or the directory named by the `autoMemoryDirectory` setting in your user settings or the project's `.claude/settings.local.json`). Setup ignores an `autoMemoryDirectory` set in the committed `.claude/settings.json`, which Claude Code itself honours under workspace trust, because a cloned repository could aim it at any directory of your files; setup says so when it skips one, and you can copy the value into `.claude/settings.local.json` if you trust it. The `MEMORY.md` index is read but never seeded from.
- Instruction files, which are ticked by default: `CLAUDE.md` at any depth, `AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md`, `.cursorrules`, `.cursor/rules/**` and `.windsurfrules`.
- Other tracked markdown, which is unticked by default and listed grouped by directory.

**What seeding never touches:**

- `CLAUDE.local.md`, because it is personal.
- `README`, `CHANGELOG` and `LICENSE` files, vendored and generated directories, and the knowledge base itself.
- Memory of type `user` and personal working preferences. They are classified as MEMORY and stay where they are.
- Your git history. Setup never commits.

Each candidate lesson is classified with the iron law of `knowledge:knowledge-capture`. Facts that the code already records, and lessons that cite files which no longer exist, are dropped. Ambiguous ones become ASK items, which setup lists and never files silently. Each rule that is written carries a `source:` naming its origin, either `memory:<file>` or `<path>#<heading>`, followed by the seeding date. Setup then builds the digest, runs `validate.py` and prints a summary. You review the result with `git diff -- .claude/knowledge` and commit it yourself.

Afterwards setup asks once whether to retire the originals that were copied. A retired memory file moves to `<memory dir>/.retired/<date>/` and its line leaves `MEMORY.md`. A retired markdown passage is removed from its file, so the change shows in `git diff`, and only the part that was copied goes.

## Daily use

Any session can push an observation. State the fact and cite what backs it, and leave the wording of the rule to the scribe:

```
/knowledge:kb the export job retries three times, see jobs/export.py:88
```

The push is one locked append to `.claude/knowledge/.local/queue.md`. Nothing reads it back and no scribe needs to be running, so the queue is a durable capture list even if no scribe ever runs. A linked git worktree feeds the main checkout's queue. Everything under `.claude/knowledge/.local/` is per-machine state, and the directory contains its own `.gitignore`, so it never reaches a commit.

### Automatic capture

`scribe.capture` in `.claude/knowledge/config.yaml` controls automatic capture and is `off` by default, so nothing is captured until you opt in. The other modes are `auto`, `handoff` and `transcript`, which choose what the SessionEnd hook feeds the extractor. Extracted rows enter the same queue with `meta.source=auto`. The scribe scores them (0.2 base, plus a ruling bonus, cross-session recurrence and ledger hits), lists those scoring at least 0.35 with their quote and score under "Auto-captured candidates", and counts the rest as held. It never writes a rule from an auto row without your approval in the one plan. `/knowledge:kb learn` runs the extractor on the current session by hand.

The other skills are `knowledge:knowledge-capture` (what is worth keeping), `knowledge:knowledge-check` (run the checks over a diff) and `knowledge:knowledge-route` (write a rule into the right scope and topic). The hooks do the rest on their own: the digest at `SessionStart`, rule injection before an edit, and the checks after it. Each hook exits silently in a project that has no `.claude/knowledge/`.

## The scribe

The scribe is the only role that writes knowledge-base YAML. Start it in its own terminal:

```
claude --agent knowledge:scribe -n kb-scribe
```

Once setup has installed the shortcut, `ccscribe` runs the same command. Inside that session, run `/knowledge:kb run`. A `UserPromptSubmit` hook and a `PreToolUse` hook on the `Skill` tool block `run` in any session that is not the scribe, and in any subagent, the `knowledge:scribe` agent spawned as a subagent included, so the boundary is enforced by Claude Code and not by the model's judgement. The scribe is a session agent: start it as a session, never through the Agent tool. Only `run` and `run --audit` count as a drain, so a push such as `/knowledge:kb run tests before committing` goes through as an ordinary push.

A run proceeds in this order:

1. It takes a run lease in `.claude/knowledge/.local/scribe-lease.json`. When another run's lease is fresh, the run reports the holder and stops, and it offers a takeover only after you confirm that the other run is dead. A corrupt lease file counts as stale.
2. It refuses to start when the commit pathspec already holds uncommitted changes, so a scoped commit can never sweep in foreign work.
3. It reads the unconsumed queue rows, checks whether their cited `path:line` still resolves, folds in the check violations of the working diff, and presents one plan that sorts every item into ROUTE, MEMORY, DROP or ASK.
4. You disposition the plan item by item. The rules you accept are written through `knowledge:knowledge-route`, the digest is rebuilt, and the commit guard verifies that the run wrote nothing beyond what it intended.
5. The run commits, verifies the commit against what it wrote, and only then marks the rows consumed, so an abort never loses a capture. It never pushes.

### Health sweep

Every run also runs `validate.py`, which checks the rule graph for errors such as a dangling edge, a duplicate FQID, a registry whose `scope:` does not match the directory it sits in, or a digest out of sync. When the full sweep is due, the run adds the ledger signal from `report.py`: rules that never fire, rules that are violated often, and reminders that recur without a check. The sweep is due every `scribe.audit_every_days` days (7 by default, and 0 means every run), and `/knowledge:kb run --audit` forces it. The findings appear as a Health section of the same plan. You can accept a fix, keep a finding as-is (it then stays hidden until one of its rules changes; an `ERROR` finding is never hidden), or leave it for the next run.

### The commit setting

`scribe.commit` in `config.yaml` decides what the scribe does with the result. With `commit`, the default, it makes a pathspec-limited commit of `scribe.pathspecs` (by default `.claude/knowledge`). With `stage` it runs `git add` on the same pathspec and stops, so you make the commit; until you do, the next run refuses to start, because the staged files sit inside the pathspec. In a project without git the run only writes files. Setup records your answer.

## Git gate and shortcut

Both are optional, and setup installs them only when you say yes.

The git gate is a `pre-commit` hook that runs the executable checks on the staged diff and blocks the commit on a `[blocking]` violation. Judgment rules cannot be enforced by a shell hook, so they are left to `knowledge:knowledge-check`. An engine error never blocks a commit, because the gate fails open. A `post-commit` hook appends a ledger marker for each committed `.php`, `.yaml`, `.yml`, `.py` or `.sh` file, the suffixes the edit-time check covers. The gate is installed per clone, so each teammate decides for themselves. You can install it by hand with `plugins/knowledge/githooks/install-git-hooks.sh <repo>`. It records the plugin's install path, falls back to a lookup when a plugin update moves that path, and exits 1 without changing anything when a hook of another origin already exists or when `core.hooksPath` points into the work tree (a tracked hooks directory would carry this machine's path into a commit). In both cases it prints the command to call from your own hook instead.

The `ccscribe` shortcut is a short script in `~/.local/bin` that runs the scribe launch command, so `~/.local/bin` must be on your `PATH` for `ccscribe` to run. Setup never overwrites an existing `ccscribe`.

## Configuration

`.claude/knowledge/config.yaml` is optional. Without it every key takes its default, so a plain project needs no file. The keys are `root_scope`, `extra_scopes`, `registry_fallbacks`, `unprobed_scopes`, `probe_roots`, `gate_marker`, `digest_trailer`, `digest_guard` and the `scribe` block (`commit`, `pathspecs`, `path_translations`, `audit_every_days`, `lease_minutes`, `capture`). A key with the wrong type, or an unknown key, falls back to its default and prints one line on stderr. The meaning and default of each key are in [reference/schema.md](reference/schema.md#project-config).

## Rule schema

Rules live in `.claude/knowledge/<topic>.yaml` files, with a header of `scope:` and `topic:` (the filename stem) followed by a `rules:` list. Each rule has an `id`, a `title`, an `applies_to`, a `severity`, optional `check`, and edges such as `overrides` and `see_also`. A rule is addressed by its FQID, `<scope>/<topic>#<id>`. The complete field list is in [reference/schema.md](reference/schema.md).

## Background

The rule format was derived from Open Semantic Interchange (OSI), the vendor-neutral YAML specification for semantic-layer definitions. OSI entered the Apache Incubator in July 2026 and was renamed Apache Ossie, because other projects already used the OSI acronym. The sources are:

- The project site, [ossie.apache.org](https://ossie.apache.org/).
- The format, in the [core specification](https://github.com/apache/ossie/blob/main/core-spec/spec.md).
- The rename, announced in [Ossie enters the Apache Incubator](https://ossie.apache.org/updates/ossie-enters-apache-incubator/).

The knowledge base borrows four ideas from it:

- One YAML document per topic, with a header that names it. Ossie uses one document per semantic model.
- Names that are unique inside a document and referenced from outside by a qualified name. Ossie writes `dataset.field`, and here it is the FQID `<scope>/<topic>#<id>`.
- Definitions that exist at two scopes, with explicit rules for which one wins. Ossie has dataset-scoped and model-scoped metrics, and here there are root rules and service rules, resolved with `override_policy` and `overrides`.
- A neutral format that any tool can read and that does not depend on the tool that wrote it.
