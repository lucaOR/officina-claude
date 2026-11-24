---
name: recall
description: Use when the user invokes /session:recall, or when a session needs detail that an earlier session settled and its handoff note left out (a command, a decision, an error, why something was ruled out). Searches this session's own handoff chain first, then the rest of the project, and returns short excerpts through a subagent. Also /session:recall forget <session-id|this>.
---

# Recall

A session that starts from a handoff note sees only the note and a pointer to its parent's
transcript. Recall searches the record behind the note: an archive of this project's sessions,
indexed by a startup hook that runs detached. It searches the session's own handoff chain first,
then the rest of the project, and every archived project only when asked.

The main session never reads hits itself. A subagent searches, reads and trims them, and hands
back at most about 2 KB.

## Usage

- `/session:recall <query>`: search the chain, then the project.
- `/session:recall <query> --all`: also search every other archived project.
- `/session:recall <query> --depth N`: follow the chain N sessions back instead of 10.
- `/session:recall forget <session-id|this>`: delete a session from the archive.

## Steps for a search

1. Get this session's id and transcript directory:

   ```bash
   python3 "${CLAUDE_SKILL_DIR}/scripts/recall.py" whoami
   ```

   It prints `session=<id> project=<directory>`. If it fails, leave both empty: the search then
   covers the current project without a chain.
2. Dispatch the `session:recall` subagent with the Agent tool. Its prompt is exactly these
   lines, with the absolute path of this skill's `scripts/recall.py` as the script:

   ```
   RECALL v1 script=<absolute path to recall.py> session=<id> project=<directory>
   query: <the user's query, or what this session needs to know>
   options: <--all and/or --depth N, or nothing>
   ```

3. Relay the subagent's answer. Quote its excerpts as they are, with their session ids and
   dates, and do not pad them. If it reports that the index cannot be opened, offer to run
   `python3 "${CLAUDE_SKILL_DIR}/scripts/recall.py" rebuild`, which rebuilds the index from the
   archive.

Never run `recall.py search` or `show` in the main session, and never `Read` a file under
`~/.claude/recall/`. Both would put raw hits into this context, which is what the subagent is
for.

## Steps for forget

Run it in the main session and relay the line it prints:

```bash
python3 "${CLAUDE_SKILL_DIR}/scripts/recall.py" forget <session-id|this>
```

It deletes the session's archive copy, note copy and index rows, and later ingests skip it. The
original transcript stays until Claude Code's own cleanup deletes it, and the output says so.

## What gets archived

- Only projects where this plugin runs. The startup hook ingests the current project's
  transcript directory, and the first run there backfills it. A session of your own chain that
  lives in another directory, such as a worktree, is fetched when you search.
- Prompts, replies, tool calls and tool results, kept in full in the archive and cut to 2 KB in
  the index. Thinking, injected reminders and bookkeeping are left out.
- The handoff note each session wrote, which ranks above other rows. The note sweep deletes a
  read note only once it is archived.

## Switches

Set them in the `env` block of the project's `.claude/settings.json`:

- `RECALL_DISABLE=1`: the project is never archived, its existing archive is deleted, and a
  search there returns nothing.
- `RECALL_RETENTION_DAYS` (default 180): how long the archive keeps a session after it ends.
- `RECALL_DEPTH` (default 10): how far back the chain is followed.

To keep a single session out, put `[recall:skip]` anywhere in one of its prompts. That includes a
message typed while Claude is working and the arguments of a slash command.
