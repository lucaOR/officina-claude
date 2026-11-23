# Plan source format

One JSON file, `working.json` while a plan is being drafted and `plan.json` once it is final. The page and the Markdown plan are both rendered from it. Validate every change with `node ${CLAUDE_SKILL_DIR}/scripts/planning.mjs validate <source.json> [--previous <source.json>]`; it prints `{"ok": bool, "diagnostics": [{code, path, message}]}` and exits 1 when there are diagnostics.

## Shape

```json
{
  "schema": 1, "slug": "pbx-deletion", "title": "...", "goal": "One sentence.", "architecture": "Two or three sentences.",
  "techStack": "...", "spec": "path or null",
  "summary": ["three lines, codes allowed"], "checkFirst": ["D7"], "constraints": ["one line each"],
  "reviewFocus": [{"text": "input or condition, and the expected behaviour", "test": "T3"}],
  "counters": {"D": 17, "T": 8, "S": 12},
  "flow": {"title": "...", "rows": [["actor ui", "Dashboard", "frontend"]], "phaseDomains": {"Start": "mutex"}},
  "domains": [{"id": "mutex", "title": "Which requests does a deletion lock out?", "checks": ["..."],
               "diagram": {"type": "workflow", "title": "...", "rows": [["..."]]}}],
  "decisions": [{"id": "D1", "domain": "mutex", "title": "...", "state": "open|settled",
                 "options": [{"key": "a", "label": "...", "why": "..."}], "recommended": "a", "pick": "a", "whyPick": "...",
                 "slots": {"scale": "...", "dataFrom": "...", "userSees": "...", "names": "...", "dragsAlong": "...", "terms": "..."},
                 "more": {"why": "...", "touches": ["path/File.php:120"], "related": ["D2", "T1"]},
                 "nodes": ["lock"], "recheck": false, "removed": {"replacedBy": ["D18"], "note": "..."}}],
  "tasks": [{"id": "T1", "title": "...", "decisions": ["D1"], "after": [], "files": {"create": [], "modify": [], "test": []},
             "interfaces": {"consumes": "...", "produces": "..."},
             "steps": [{"title": "Write the failing test", "body": "...", "code": {"lang": "python", "text": "..."}, "run": "cmd", "expect": "PASS"}],
             "commit": "feat: ...", "recheck": false}],
  "scenarios": [{"id": "S1", "domain": "mutex", "title": "...", "expected": "...", "tasks": ["T2"], "recheck": false}],
  "entities": {"title": "...", "rows": [["entity user", "User"]]}
}
```

`removed` is absent on live elements. `pick` and `whyPick` are required when `state` is `settled`; `recommended` is required when it is `open`. A decision with `"domain": null` is cross-domain and shows on the Overview. `flow.phaseDomains` maps each `phase` row name of the flow (a sequence diagram) to a domain id.

Diagrams are compact rows, described in `diagram-rows.md`. Each diagram field takes one shape:

| Source field | Type | Shape |
|---|---|---|
| `flow` | `sequence` | `{"title", "rows", "phaseDomains"}` |
| `domains[].diagram` | `workflow`, `sequence` or `erd` | `{"type", "title", "rows"}` |
| `entities` | `erd` | `{"title", "rows"}` |

In `flow`, each phase label is a key of `phaseDomains`, such as `{"Ask": "ask"}`, so that its band links to the domain that decides it. A decision's `nodes` are node, actor or entity ids from these rows, or `m<n>` for a sequence's n-th message. The validator checks only that rows are arrays of strings. To check that a diagram renders, write it as `{"type", "title", "rows"}` to a spec file, with `sequence` for the flow and `erd` for the entities, and run `planning.mjs diagram <spec.json>`.

## Codes

`D<n>` decisions, `T<n>` tasks, `S<n>` scenarios. They are append-only and never reused. `counters` holds the highest number issued per letter; a new element takes the next number and the counter moves up with it. To retire an element, set `removed` (and `replacedBy` when something supersedes it) instead of deleting it.

## Diagnostics

| code | rule |
|---|---|
| `source-unreadable` | the source file (or the `--previous` one) cannot be read or parsed as JSON |
| `id-format` | an id must be its collection's letter plus a number |
| `id-duplicate` | an id (or a domain id) appears twice |
| `domain-id-format` | a domain id must be a slug: lower-case letters, digits and hyphens, starting with a letter |
| `id-counter` | an id is above its counter |
| `id-dropped` | with `--previous`: an id in the previous source is missing |
| `counter-decreased` | with `--previous`: a counter is lower than before |
| `domain-unknown` | a non-null decision domain, a scenario domain or a `phaseDomains` value is not in `domains` |
| `slot-missing` | a live decision lacks `slots.scale` or `slots.dataFrom` |
| `pick-missing` | a live settled decision lacks `pick` or `whyPick` |
| `pick-unknown` | `pick` is not an option key |
| `recommended-missing` | a live open decision lacks `recommended` |
| `recommended-unknown` | `recommended` is not an option key |
| `diagram-type` | a domain diagram type is not `sequence`, `workflow` or `erd` |
| `diagram-rows` | `rows` (a diagram, the flow or entities) is not an array of string arrays |
| `ref-unknown` | a code does not exist (removed elements still count as existing) |
| `change-unknown` | with `undo`: the change id is not in the change log |
| `patch-unreadable` | with `apply`: the patch file cannot be read or parsed as JSON |
| `id-missing` | with `apply`: an upserted element has no `id`, or its `id` is not a string |
| `pick-by-author` | with `apply --kind author`: an upsert changes `state`, `pick` or `whyPick` of an existing decision; settle it with `pick` or edit it with `apply --kind change` |
| `header-missing` | with `update`: `goal`, `architecture` or `techStack` is missing or blank, so the real plan is not written |

Removed elements are exempt from the slot, pick and recommended checks only. References are checked in `task.decisions`, `task.after`, `scenario.tasks`, `checkFirst`, `reviewFocus[].test`, `more.related`, `removed.replacedBy`, and in every `D`/`T`/`S` code written inside a prose string. Step `code.text`, step `run`, `more.touches` and diagram rows are not scanned.

## Slots

Two are mandatory on live decisions; the other four appear only when they apply.

- `scale`: what happens at scale or when it fails. Mandatory.
- `dataFrom`: where the data comes from. Mandatory.
- `userSees`: the user-visible copy or behaviour.
- `names`: the names introduced.
- `dragsAlong`: the option's blast radius, what else changes with it.
- `terms`: terms the decision relies on, defined.
