---
name: knowledge-capture
description: Use at a closing boundary — finishing a session, closing a branch, or before the commit that ends the work — to sweep what was learned into a new rule, an update to an existing one, or memory; also invoked by a review sweep when a review closes. Not per turn and not after each task — park a mid-task learning in the ledger, a note, or `/knowledge:kb <text>` (for a scribe to route later) and sweep it here, so a rule is only written once the evidence for it is in. ALWAYS ask rather than silently dropping or mis-filing anything you are unsure about.
---

# Knowledge Capture

The write-side mirror of the always-loaded digest: a deliberate sweep that turns
"I just learned something" into the right persisted entry. Capture recognition is
a cognitive event with no hook to fire on it, so this is a scheduled checkpoint —
run it at the end of a substantial task/session (pairs with `knowledge:knowledge-check`), not
mid-flow.

## Iron law

NO BORDERLINE CAPTURE DECISION IS RESOLVED SILENTLY. Every candidate is EITHER
routed with confidence (and surfaced for approval) OR raised as a question. A
**silent drop** and a **silent write/bucket** are equal violations. Over-asking a
borderline item is cheap; a silently-dropped durable rule or a wrong-bucket write
is expensive and invisible until it bites.

## Steps

1. **Sweep** the diff + conversation for candidate knowledge: rules, gotchas,
   conventions, decisions, sizing data, preferences, environment/state. List them.
   Include the **Failure lens** pass (see the section below) — it is part of the sweep.

2. **Classify each candidate into exactly one lane:**
   - **ROUTE** — confidently a durable, team-relevant project rule/epic fact → KB,
     via Step 5 (push through `/knowledge:kb <text>`, or `knowledge:knowledge-route` directly if this
     session is the scribe).
   - **MEMORY** — confidently personal / personal-environment / ephemeral / in-flight
     → auto-memory (name the bucket: `feedback_`/`user_`/`project_`/`feature_`).
   - **DROP** — confidently not worth persisting.
   - **ASK** — ANY doubt (see triggers). This is the default under uncertainty.

3. **The "already covered" guard.** You may put a candidate in DROP as
   "already captured / already implied" ONLY if you have OPENED the existing entry
   and confirmed it covers this candidate. An unverified "already covered" is an
   ASK, not a DROP. (Bonus: if the existing entry is close but not exact, the lane
   is usually ASK — new rule vs update-existing.)

4. **Surface — never execute silently.**
   - Present the ROUTE / MEMORY / DROP candidates as a plan for the user to approve
     (one line + justification each). Include the DROPs explicitly — a drop is a
     decision the user gets to see and veto.
   - For EVERY ASK candidate, ask the user via `AskUserQuestion` — one question per
     candidate, options = the plausible homes (e.g. "KB rule", "update existing
     rule X", "personal memory", "drop"). Do not pre-resolve them in prose.

5. **Execute only after answers.** For confirmed ROUTE candidates: if this session
   is the scribe (`KNOWLEDGE_ROLE=scribe`, mid-`/knowledge:kb run`), route them through
   `knowledge:knowledge-route` directly, same as always — that flow is unchanged. Otherwise,
   the default for every other session: push each one via
   `/knowledge:kb <text>` (cite the artifact refs backing it) and let the scribe classify
   and write it at the next `/knowledge:kb run`; do not call `knowledge:knowledge-route` yourself.
   Write confirmed memory entries directly, as before. Drop the rest. Report what
   landed where (written, or queued for the scribe).

## Failure lens (part of the Sweep)

Beyond general learnings, explicitly enumerate this session's FAILURES — the strongest
"a guardrail is missing" signal. For each concrete instance, run the generalize test and,
if it passes, produce a guardrail candidate that flows through Steps 2-5 like any other.

**Signals to enumerate (list each concrete instance):**
1. The user's **corrections / rejections** — where they overrode, reverted, or said "no, do X".
2. **Code-review findings** (`code-review` / `requesting-code-review`) that no existing rule encoded.
3. **Edit-hook / check blocks that revealed a GAP** — i.e. a missing rule. An *existing* rule
   firing correctly is NOT a new-rule signal; that is ledger / health-sweep territory (formerly `knowledge-audit`; now the scribe's sweep in `/knowledge:kb run`).
4. **Bugs / incidents fixed** that no rule would have caught.

**Generalize test:** would a rule have prevented this, and could it recur? Yes -> guardrail
candidate. One-off -> DROP (surfaced, per the iron law).

**Draft the guardrail — and a check when you can.** Draft the rule (scope/`applies_to`/
`trigger`/`rule`/`rationale` per the scope heuristic below). When the failure is
*mechanically detectable*, ALSO draft an executable `check:` (`grep`/`awk` with numeric
stdout + `flag_when`, in the style of the checks the project's registries already carry; its
`.claude/knowledge/_index.md` may name one to copy) so the guardrail AUTO-ENFORCES
via the edit-time hook and pre-commit — a failure that becomes a rule+check cannot recur.
When it is not text-checkable, say so explicitly (e.g. "needs ast-grep") and leave it
judgment-only; never invent a fragile check.

Failure-lens candidates obey the same iron law and are handled by Step 5
exactly like sweep candidates.

## In doubt = ASK. You are in doubt whenever you are unsure:

- whether it is **durable** (still matters in weeks) vs ephemeral;
- whether it is **team-relevant** vs only-useful-to-you (personal);
- whether it is a **new rule** vs an **update to an existing one** — or *which*
  existing one;
- of the **scope** — does a rule found while working in ONE service apply only there,
  or to its same-stack siblings, or all? The project's `.claude/knowledge/_index.md`
  holds its scope heuristic: which services share a stack, and which are exceptions.
  A rule about a stack that several services share almost always applies to all of
  them (the root scope, `root_scope`, with `applies_to.services` naming each). Do NOT
  default to the single service you were in, and do NOT narrow to only the services
  you can immediately confirm — that is the recurring under-scoping bug. If unsure
  which same-stack siblings it reaches, ASK;
- of the **bucket boundary** (KB rule vs auto-memory);
- whether it **duplicates** an existing entry you have not actually opened.

## Rationalizations — STOP, these mean ASK

| Excuse | Reality |
|--------|---------|
| "Already implied by existing docs" | Did you OPEN the entry and confirm? If not → ASK. "Implied" ≠ "covered". |
| "Obviously just a personal preference" | 100% sure no teammate benefits? If <100% → ASK. |
| "Clearly ephemeral, not a rule" | Could it generalize into a convention? If maybe → ASK. |
| "I'll just file it under the obvious bucket" | Unilateral bucketing of a borderline item is a silent decision → ASK. |
| "It's a small tweak to an existing rule" | New vs update, and which rule, is a judgment the user owns → ASK. |
| "A final 'shall I proceed?' covers it" | That hides the per-item judgment. Surface EACH borderline call, don't bundle. |
| "Found it in service X, so it's an X rule" | Discovery service != scope. If it is a stack-level rule (see the scope heuristic in `_index.md`), it applies to every service on that stack → the root scope, or ASK. |
| "I'll scope it to just the services I can confirm use it" | Narrowing to the confirmable subset IS the under-scoping bug. Services on one stack share it; ASK rather than silently exclude the ones you didn't check. |

## Red flags — you are about to violate the iron law

- Dropping a candidate as "already covered" without having read the existing entry.
- A capture plan with zero ASK items but candidates that are genuinely borderline.
- Bundling everything into one "proceed?" instead of asking the per-candidate questions.
- Writing or dropping a borderline item and only mentioning it after the fact.
