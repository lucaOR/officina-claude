---
effort: medium
name: setup
description: Use for `/knowledge:setup` — seed a first-draft knowledge base from Claude memory and the repo's instruction and markdown files, then record per-project answers (commit mode, team registration, git gate, the `ccscribe` shortcut). Safe to re-run; in a project that already has a knowledge base it skips seeding and only offers the settings questions. Never commits.
---

# Setup

This skill builds the first draft of a project's knowledge base from material that already
exists, and records a few per-project choices. Seeding only writes YAML rules and the digest
under `.claude/knowledge/`, and it never commits: the user reviews the diff and commits.

`<repo-root>` below is the absolute path of the project checkout, which is the session's
primary working directory. Substitute it before running a command.

## 1. Discover the sources

Run the discovery helper:

```
python3 "${CLAUDE_SKILL_DIR}/../../scripts/seed/sources.py" --root <repo-root>
```

It prints JSON with `kb_exists`, `memory` (Claude memory files), `instructions` (CLAUDE.md,
AGENTS.md and similar), `other_markdown` (grouped by top-level directory) and `memory_dir`.

Setup does not use an `autoMemoryDirectory` that the committed `.claude/settings.json` sets,
because a cloned repository could aim it at any directory of the user's files. When the JSON
has `memory_dir_ignored`, tell the user in one sentence that setup did not use that memory
directory because a committed file chose it, and that they can set `autoMemoryDirectory` in
`.claude/settings.local.json` if they trust it.

`kb_exists` is true when `.claude/knowledge/` already holds rule files. A `config.yaml` or a
`.local/` directory alone does not count, so a run whose seeding failed can seed again. If
`kb_exists` is true, skip seeding unless the user explicitly asks for it, and ask only call B
below. A repeat run must not duplicate rules or settings.

## 2. Ask the questions

`AskUserQuestion` allows at most 4 questions per call and 2 to 4 options per question, and it
always adds a free-text "Other" option. So the questions go out in two calls.

First print the discovered sources as plain text: the instruction files, the memory files, and
the other markdown grouped by directory.

**Call A, sources.** Ask this one question alone, as multiSelect, with at most 4 options:
"Instruction files (N)" labelled "(Recommended)", "Memory files (N)" labelled "(Recommended)",
and "Other markdown" (or the two largest other-markdown groups, if that reads better). The
default answer is instruction files plus memory files; other markdown is opt-in. Tell the
user they can type specific file names through "Other". Skip call A when `kb_exists` is true,
unless the user asked to seed.

**Call B, settings.** Ask these together, dropping any that do not apply, and put the default
option first, labelled "(Recommended)":

1. **Scribe commit setting**, `commit` (default) or `stage`. Drop it when the project is not a
   git repository.
2. **Register for teammates**, yes (default) or no. This adds the plugin and its marketplace to
   the project's `.claude/settings.json`.
3. **Install the git gate in this clone**, no (default) or yes. Drop it when the project is not
   a git repository.
4. **Install the `ccscribe` shortcut**, no (default) or yes.

## 3. Apply the settings answers

Run only the helpers the answers call for. Each prints JSON, and a non-zero exit carries a
message to relay to the user instead of retrying.

- Commit setting: `python3 "${CLAUDE_SKILL_DIR}/../../scripts/seed/config_write.py" --root <repo-root> --commit commit` (or `stage`). It exits 1 and changes nothing when the config writes `scribe:` inline (flow style); relay its message.
- Registration: `python3 "${CLAUDE_SKILL_DIR}/../../scripts/seed/register.py" --root <repo-root>`. When its output says no known marketplace was found, tell the user that only the plugin was enabled and the marketplace entry must be added by hand.
- Git gate: `"${CLAUDE_SKILL_DIR}/../../githooks/install-git-hooks.sh" <repo-root>`. It exits 1 and changes nothing when a foreign `pre-commit` or `post-commit` hook exists, or when `core.hooksPath` points inside the work tree, so report its message and move on.
- Shortcut: `python3 "${CLAUDE_SKILL_DIR}/../../scripts/seed/shortcut.py"`. It exits 1 when `~/.local/bin/ccscribe` already exists and never overwrites it. Tell the user that `~/.local/bin` must be on their `PATH` for `ccscribe` to run.

## 4. Seed the rules

Skip this section when the user ticked no sources or `kb_exists` is true.

1. Split each ticked source into candidate lessons, one durable statement each.
2. Classify every candidate with the iron law of `knowledge:knowledge-capture`, into exactly
   one lane:
   - Memory of type `user` and personal preferences are MEMORY, so they stay where they are.
   - Anything derivable from the code, or citing files that no longer exist, is DROP.
   - Anything ambiguous is ASK. Never drop or file a doubtful candidate silently.
   - A durable, team-relevant project rule is ROUTE.
3. Write each ROUTE item through `knowledge:knowledge-route`. Set `source` to
   `memory:<file>` for memory, or `<path>#<heading>` for a markdown file, followed by the
   seeding date, so every rule can be traced back to its origin. When seeding, skip the
   route skill's commit step and its `test_build_digest.py` guard: seeded rules must stay
   uncommitted for review, and a freshly seeded project has no `digest_guard` pin to check yet.
   Also skip its per-rule digest rebuild, because step 6 below rebuilds the digest once at
   the end and replaces the route skill's write-and-regenerate tail.
4. When the memory directory has more than about 30 files, split them into batches and hand
   each batch to a subagent that follows steps 1 to 3, so one context does not carry them all.
5. Copy `${CLAUDE_SKILL_DIR}/../../templates/_index.md` to `.claude/knowledge/_index.md` when
   that file is missing, and never overwrite an existing one.
6. Build the digest with `python3 "${CLAUDE_SKILL_DIR}/../../scripts/build_digest.py" --root <repo-root>`,
   then run `python3 "${CLAUDE_SKILL_DIR}/../../scripts/validate.py" --root <repo-root>` and fix
   what it reports.

## 5. Report and retire

Print the rules written per topic, the ASK items still waiting for an answer, and which
original passages and memory files were copied into rules. Tell the user to review
`git diff -- .claude/knowledge`, and do not commit.

Then ask once whether to retire the copied originals, with the options yes, no or pick:

- A copied memory file is retired with
  `python3 "${CLAUDE_SKILL_DIR}/../../scripts/seed/retire.py" --root <repo-root> --memory-file <name>`,
  which moves it under `.retired/<date>/` in the memory directory and removes its `MEMORY.md` line.
- A copied markdown passage is removed from its file with Edit, taking out only the copied
  passage and leaving the rest of the file untouched.

New knowledge after setup goes through `/knowledge:kb <text>`, and the scribe's
`/knowledge:kb run` writes it.
