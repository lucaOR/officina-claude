# Intent — standup-digest

opened: 2026-10-20
owner: someone
status: draft

## Purpose

Kind: problem. **(user)**

Leads lose their Friday afternoon rewriting standup notes into a summary for the director.

## Verbatim ask

"I spend Friday afternoons turning our standup notes into a summary for the director."

## DEFINITIONS

- **Digest**: a one-page summary of the week's standup notes, one per team. This is exhaustive.

## Done-criteria

1. A lead gets the digest without rewriting notes. **(user)**

## Non-goals

- Not a meeting recorder. **(user)**

## File layout

```
digest/
  collect.py      # reads the notes
  summarise.py    # builds the one-page summary
  send.py         # mails the director
```

## Tasks

1. Write collect.py with tests.
2. Write summarise.py.
3. Wire the three together in a cron job.

## Budget

about 20 turns

## Open questions

- (none yet)
