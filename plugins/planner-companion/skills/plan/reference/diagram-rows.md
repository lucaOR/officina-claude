# Diagram rows

Adapted from archify's `references/explainer-authoring.md`, section "Compact native diagrams" (archify 3.2.0, Apache-2.0; see `${CLAUDE_SKILL_DIR}/vendor/archify/LICENSE` and `${CLAUDE_SKILL_DIR}/vendor/archify/NOTICE`). Modified for this plugin: rows are JSON arrays of string cells instead of pipe rows, the types are limited to `sequence`, `workflow` and `erd`, and source cells, `@architecture`, `@tree` and `@timeline` are left out.

A diagram is a list of rows, and the renderer does the layout, so you write no coordinates.

| Source field | Type | Shape |
|---|---|---|
| `flow` | `sequence` | `{"title", "rows", "phaseDomains"}` |
| `domains[].diagram` | `workflow`, `sequence` or `erd` | `{"type", "title", "rows"}` |
| `entities` | `erd` | `{"title", "rows"}` |

To check a diagram, write it as `{"type", "title", "rows"}` to a spec file, with `sequence` for the flow and `erd` for the entities, and run the `diagram` command from SKILL.md section 3. Every example below renders that way.

Ids start with a letter and use letters, digits, `-` and `_`. Node and actor types are `frontend`, `backend`, `database`, `cloud`, `security`, `messagebus` and `external`, and the default is `backend`. Edge and message variants are `default`, `emphasis`, `security` and `dashed`, and a sequence message also accepts `return`. A decision's `nodes` are node, actor or entity ids from these rows.

## sequence

Declare the actors, then the messages in order. An actor row is `["actor <id>", label, type]`. A message row is `[from, to, label, variant?]`, where `from` and `to` are actor ids or labels. A `["phase", label]` row opens a band over the messages after it, up to the next phase, and needs at least one message. In `flow`, each phase label is a key of `phaseDomains`, such as `{"Ask": "ask", "Store": "store"}`, so that its band links to the domain that decides it.

```json
{"type": "sequence", "title": "Question to stored answer", "rows": [
  ["actor ui", "Page", "frontend"],
  ["actor api", "Server", "backend"],
  ["actor db", "Store", "database"],
  ["phase", "Ask"],
  ["ui", "api", "POST /questions"],
  ["api", "ui", "202 queued", "return"],
  ["phase", "Store"],
  ["api", "db", "save answer", "emphasis"]
]}
```

## workflow

Declare the nodes, then the edges. A node row is `[id, label, type?, lane?]`, and an edge row is `["from > to", label?, variant?]`. Placement follows the edges from left to right, starting with the nodes that have no incoming edge. A node label names the step in up to about four words, and an edge label uses one or two. A node label ending in `?` is drawn as a decision, so label its outgoing edges with the answers.

```json
{"type": "workflow", "title": "Accept a question", "rows": [
  ["receive", "Receive", "backend"],
  ["empty", "Empty text?", "backend"],
  ["reject", "Return 400", "backend"],
  ["store", "Store it", "database"],
  ["receive > empty"],
  ["empty > reject", "yes", "dashed"],
  ["empty > store", "no", "emphasis"]
]}
```

To group the steps into phases, declare `["lane <id>", label]` rows and give each node its lane as the fourth cell. A lane holds at most six nodes.

```json
{"type": "workflow", "title": "Release", "rows": [
  ["lane prepare", "Prepare"],
  ["lane ship", "Ship"],
  ["build", "Build", "backend", "prepare"],
  ["test", "Run tests", "backend", "prepare"],
  ["deploy", "Deploy", "cloud", "ship"],
  ["verify", "Smoke test", "backend", "ship"],
  ["build > test"],
  ["test > deploy", "green", "emphasis"],
  ["deploy > verify"]
]}
```

## erd

Declare the entities, then the fields, then the relationships. An entity row is `["entity <id>", label]`. A field row is `["<entity>.<field>", type, keys?, references?]`, where keys are `pk`, `fk` and `uk`, comma-separated, and a field may only name a declared entity. A relationship row is `["from > to", cardinality, label?]`, with cardinality `one:one`, `one:many`, `many:one` or `many:many`.

```json
{"type": "erd", "title": "Questions and answers", "rows": [
  ["entity question", "Question"],
  ["entity answer", "Answer"],
  ["question.id", "bigint", "pk"],
  ["answer.id", "bigint", "pk"],
  ["answer.question_id", "bigint", "fk", "question.id"],
  ["answer > question", "many:one", "answers"]
]}
```
