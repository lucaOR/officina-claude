---
name: knowledge-route
description: Scribe-only write step for the knowledge base — invoked from inside a running `/knowledge:kb run` (KNOWLEDGE_ROLE=scribe) or from `/knowledge:setup`'s seeding to classify scope x kind, draft the YAML entry, run the write-time conflict lint, then on confirm write it and rebuild the digest. If you are an ordinary session that just learned a durable, team-relevant PROJECT rule or epic fact, do NOT invoke this directly — push it via `/knowledge:kb <text>` instead and let the scribe route it. NOT for personal preferences/workflow (those stay in auto-memory via save-insights/audit-memory).
---

# Knowledge Route

`<repo-root>` below stands for the absolute path of this project checkout: the
session's primary working directory, or the worktree's root when working in one.
Substitute it before running a command; never hardcode a machine-specific path.

Single chokepoint for adding or editing a rule/epic in the project knowledge base
(`.claude/knowledge/`). Makes the conflict lint enforceable at write time.

## When NOT to use
- Personal preference / explanation style / workflow habit -> auto-memory
  (`feedback_*` / `user_*`), via `save-insights`.
- Personal-environment setup or ephemeral project state -> auto-memory (`project_*`).
- Ordinary (non-scribe) session with a durable, team-relevant fact in hand -> push
  it via `/knowledge:kb <text>` instead of calling this skill directly; the scribe classifies
  and writes it at the next `/knowledge:kb run`.
This skill's callers are the scribe's `/knowledge:kb run` and `/knowledge:setup`'s seeding,
nothing else.
This skill owns ONLY durable, team-relevant project rules + epic facts. Everything
else a session learns (personal, personal-environment, in-flight work) stays in
auto-memory; the project's instruction file may spell out those buckets.

Read the project's `.claude/knowledge/_index.md` before step 1: it holds the routing
taxonomy and the project specifics this skill defers to (its scope heuristic, its
topics, and any extra scope whose digest is rebuilt from a nested directory).

## Steps

1. **Classify scope x kind** — every candidate has exactly one home:
   - Scope: cross-service -> the root scope (`root_scope` in the config, default
            `project`; root `.claude/knowledge/`).
            one named service -> that service (`<service>/.claude/knowledge/`, or the
            directory a `registry_fallbacks` template gives it). The file's `scope:`
            header must be the scope of the directory it sits in (see the schema), or
            `validate.py` reports `scope_mismatch` and the rule never injects.
   - Kind:  a convention/topic -> `<topic>.yaml` (reuse a topic the project already
            has; `_index.md` lists them).
            an epic -> `epics/<slug>.yaml`.
   Scope heuristic: the project's `_index.md` says which services share a stack. A rule
   about a stack several services share, found in one of them, is almost always a
   root-scope rule with `applies_to.services` naming each — NOT single-service, and NOT
   only the subset you can immediately confirm. If torn between single-service and the
   stack group (or unsure which siblings it reaches), ask the user rather than silently
   narrowing.

2. **Resolve the target file** from (scope, kind). Read it if it exists — match the
   id style, reuse the topic's conventions, and avoid a duplicate id.

3. **Draft the entry** per `${CLAUDE_SKILL_DIR}/../../reference/schema.md`. Required: `id`
   (kebab-case, unique in the file), `title`, `rule`. Add `applies_to` (for root-scope
   rules, list `services` explicitly; add `globs`/`languages` when they sharpen
   matching), `trigger`, `rationale`, `source` (origin file or incident date).
   - Add a `check` (`scope: file|class|project`, `shell`, `flag_when`) ONLY when the
     rule is mechanically verifiable. Pair the rule with the exact shell-runnable check.
   - `severity: blocking` only for a rule an external gate already enforces (the project's
     `_index.md` names its gates) or a hard-fail rule; otherwise omit (defaults to
     recommended).
   - `override_policy: binding` ONLY for a security invariant or a cross-service
     contract a service must never override. Default `overridable`. Do not let
     `binding` become a catch-all that quietly recreates "the root scope always wins".
   - `resident: true` ONLY when the rule must sit in the always-on digest. The default
     answer is no: the digest is injected at every session start and replayed on every
     API response, so a resident line is the most expensive place a rule can live.
     Set it when the rule is (`blocking` or `binding`) AND has no `check` — a checked
     rule is enforced by `check-on-edit.py` whether or not the model remembered it — or
     when the rule is `digest_only` and prescribes an action, since `lib.file_matches()`
     returns False for `digest_only` rules and the on-edit injector can never deliver it.
     Leave it off for architecture *explainers*: they describe how a subsystem is wired
     rather than what to do, so they earn their place in the registry, one lookup away
     (the digest's trailer says how to look a rule up), not in the prefix. A collapsed
     rule still shows its id on the digest's `also:` line.
     A resident rule delivers only its first 90 characters of `rule` text — the gist is
     truncated there — so put the directive in that opening span and never at the end of
     a long body.
   - Declare edges (`overrides` / `conflicts_with` / `see_also`) with full FQIDs.

4. **Run the focused write-time lint:**
   `python3 "${CLAUDE_SKILL_DIR}/../../scripts/validate.py" --root <repo-root> --focus <new-fqid>`
   - `ERROR` (`dangling_edge`, `override_of_binding`, `duplicate_fqid`,
     `double_override_same_scope`, `scope_mismatch`): MUST fix before writing.
   - `CANDIDATE` (same topic, overlapping `applies_to`, undeclared): read the named
     rules; either it is a genuine conflict (resolve it — add `overrides` /
     `conflicts_with`, or revise) or they are independent (leave it; the cluster is
     informational).
   - `FAN-OUT [zombie_default]`: every service overrides this root-scope rule — consider
     promoting the agreed rule up and dropping the overrides, or retiring it.
     `FAN-OUT [healthy]` (some but not all services override) is informational — a
     sanctioned exception, no action needed.

5. **Write + regenerate** (on user confirm): add the entry to the target YAML, then
   rebuild the affected digest:
   - root scope: `python3 "${CLAUDE_SKILL_DIR}/../../scripts/build_digest.py" --root <repo-root>`
   - service:  `python3 "${CLAUDE_SKILL_DIR}/../../scripts/build_digest.py" --root <repo-root>/<service>`
   - a scope in a nested directory (an `extra_scopes` match): `python3 "${CLAUDE_SKILL_DIR}/../../scripts/build_digest.py" --root <repo-root>/<scope dir>`
   Re-run `validate.py` (no `--focus`): the graph is healthy when there are no `ERROR`
   lines and it exits 0 — `WARN` lines are advisory and expected, not a sign anything is
   wrong.
   After regenerating, if `.claude/knowledge/config.yaml` sets `digest_guard`, RUN the
   digest guard — do not eyeball it:
   `python3 "${CLAUDE_SKILL_DIR}/../../scripts/test_build_digest.py" --root <repo-root>`
   (plain unittest, no pytest needed). It must print `OK`. Without a `digest_guard` key
   the project pins no numbers, so there is nothing to run: skip the guard.
   Two guards run over the real root digest, one per tier, and they mean different
   things. Their numbers come from the `digest_guard` key (`resident`, `max_bytes`); a
   guard whose number is not set there is skipped, and the run still prints `OK`.
   - `test_real_root_resident_tier_is_pinned` is the one a /knowledge:kb run can trip. It fails
     only if the entry you just wrote is marked `resident: true`, because that puts a
     full line into every session's always-on prefix. Decide whether it belongs there
     (residency is for a rule that prescribes an action which helps BEFORE an edit, so
     a post-edit reminder is the wrong delivery); if it does, bump `digest_guard.resident`
     in `.claude/knowledge/config.yaml` in the same commit (the file is inside the commit
     pathspec, so list it among the paths you wrote) and justify it in the commit message.
   - `test_real_root_digest_stays_under_the_backstop` is a loose ceiling
     (`digest_guard.max_bytes`), not a budget.
     A red here means something structural broke — a scope root rendering flat, the
     epics pointer dropping, a rule body pasted in whole. Read the byte breakdown in the
     failure message before touching the number; do not re-cut it to make a run pass.
   A non-resident rule only adds its bare id to an `also:` line, so that drift is the
   cheap tier working as designed and owes no diagnosis and no note.
   This step used to say "check `wc -c` against the pin". Nobody ran the number: the
   pin was once breached by a resident rule and the guard sat red for a day
   before anyone noticed, which is exactly the case the resident pin now catches by name.

6. **Report** the FQID, target file, and the digest delta. Commit the changed registry
   YAML together with the rebuilt `_digest.md` in the same commit — the knowledge base
   IS versioned (`.claude/knowledge/` is tracked), and `validate.py` treats digest drift
   as an `ERROR` that exits 1, so a rebuilt-but-uncommitted digest breaks the lint for
   the next person.

## Red flags — stop
- Routing a personal preference here (it belongs in auto-memory).
- Marking a rule `binding` with no security / cross-service-contract justification.
- Writing the entry before the focused lint is clear of `ERROR` lines.
- Skipping the digest rebuild — the always-loaded index would silently diverge from
  the rule bodies.
