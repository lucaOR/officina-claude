# Knowledge base

This directory holds the project's durable, team-relevant rules: conventions, gotchas and
decisions that every session should follow.

## Where things live

- The rules are YAML files grouped by topic, such as `conventions.yaml` or `testing.yaml`, in
  this directory. Each rule has an id, a title and a rule body, and may say which files it
  applies to.
- `_digest.md` is generated from those files. Do not edit it by hand; rebuild it with the
  plugin's `build_digest.py` or let the SessionStart hook do it.
- `config.yaml` holds per-project settings, for example whether the scribe commits or only
  stages its changes.

## Scope heuristics

The knowledge skills read this section when they decide a rule's scope. Name the services
(top-level directories with their own `.claude/knowledge/`) that share a stack, so a rule found
in one of them is scoped to all of them, and any service that is an exception.

- (none yet: this project has a single scope)

## Project-specific checks

`knowledge:knowledge-check` reads this section before it declares work done. List any check the
knowledge base does not run itself (a linter or static analyzer to run by hand, a scope whose
files are checked with `--eval-root <dir>`), with the command to run.

- (none yet)

## Adding knowledge

- From any session, push an observation with `/knowledge:kb <text>`. It goes to a local
  queue and nothing is written yet.
- The scribe (launched with `ccscribe`, or `claude --agent knowledge:scribe`) drains the
  queue with `/knowledge:kb run`, routes each item into the right YAML file and rebuilds
  the digest.
- Review the result with `git diff -- .claude/knowledge` before it is shared.
