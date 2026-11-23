---
effort: medium
name: knowledge-check
description: Use before a commit, or before declaring a branch or a whole task-set done, to verify the entire diff against project rules — runs the knowledge-base check engine over changed files and surfaces violations plus judgment-rule reminders. Not per turn and not after each task — every edit is already checked automatically by the PostToolUse check-on-edit hook. Evidence before "done".
---

# Knowledge Check

`<repo-root>` below stands for the absolute path of this project checkout: the
session's primary working directory, or the worktree's root when working in one.
Substitute it before running a command; never hardcode a machine-specific path.

Verify the current change set against the project knowledge base before any
completion claim. Read the project's `.claude/knowledge/_index.md` first: it
names the project-specific checks this skill defers to (step 2).

## Iron law

NO "DONE" WITHOUT A FRESH knowledge:knowledge-check RUN ON THE ACTUAL DIFF.

## Steps

1. Determine the changed files and which service they belong to. Inside a
   service repo: `git -C <service> diff --name-only HEAD` (plus staged/untracked
   as relevant). Paths are relative to the service root.

2. Run the engine (per service touched):
   `python3 "${CLAUDE_SKILL_DIR}/../../scripts/check.py" --root <repo-root> --source skill --baseline HEAD --service <service> <file> [<file> ...]`
   For cross-service-only files, omit `--service`.

   `--service <name>` alone evaluates the files under `<repo-root>/<name>`. When a
   scope's files are checked out somewhere else, pass that directory, relative to the
   root, as `--eval-root <dir>`:
   `python3 "${CLAUDE_SKILL_DIR}/../../scripts/check.py" --root <repo-root> --source skill --baseline HEAD --service <name> --eval-root <dir> <file> [<file> ...]`
   `--eval-root` is where the CHECKED FILES live, a separate concern from where the
   registry lives (the engine already finds that through the config's
   `registry_fallbacks`). The project's `_index.md` names any scope that needs it.

   `--baseline HEAD` diff-scopes the count-checks (the grep / ast-grep ones): a
   violation is reported only when your change introduced or worsened it, not for
   pre-existing debt already in a file you touched. The edit-time hook
   (the plugin's `check-on-edit.py` hook) passes the same baseline, so this run and
   that one agree.

   This engine runs the knowledge base's own checks and nothing else. A project can
   leave some checks to other tools, such as a static analyzer it runs by hand, and
   nothing runs those for you mid-session, so a clean `check.py` is not by itself
   evidence that they pass. Its `.claude/knowledge/_index.md` lists them under
   project-specific checks: run each one it names yourself before claiming done.

   A project may also gate such tools at commit time with a git hook of its own. That
   is a backstop for the human committing, not a substitute for checking your own
   diff, and a hook that fails OPEN when its tool cannot run proves nothing when a
   commit goes through.

   A separate optional pre-commit gate running THIS engine on the staged diff can be
   installed per repo by `/knowledge:setup`. It is NOT
   installed anywhere by default — do not assume a commit was gated by it.

3. Read the output:
   - `VIOLATIONS` — executable checks that failed. For each, create a TodoWrite
     item and fix before claiming done. A `[blocking]` violation must be cleared.
   - `REVIEW` — judgment rules with no executable check; read each rule body in
     the cited `.claude/knowledge/*.yaml` and confirm the diff complies. Create a
     TodoWrite item per reminder you cannot immediately confirm.

4. For deeper review (semantic conflicts, parity rules spanning files), delegate
   a sub-agent with the changed files + the matching rule bodies and ask it to
   confirm compliance. (project/class-scoped checks arrive in a later iteration.)

5. Only after violations are cleared and reminders confirmed: state the result
   WITH evidence (the check output), then proceed.

## Red flags — stop

- About to say "done"/"complete"/"looks good" without a fresh run this turn.
- Running on a stale file list (re-run after the last edit).
- Treating a `[blocking]` violation as optional.
