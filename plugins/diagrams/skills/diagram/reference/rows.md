# Diagram rows

A diagram is `{"type", "title", "rows"}`. `type` is `sequence`, `workflow` or `erd`. Each row is a JSON array of strings, and the renderer places everything, so a row never holds coordinates.

Ids start with a letter and continue with letters, digits, `-` or `_`. A node or actor type is one of `frontend`, `backend`, `database`, `cloud`, `security`, `messagebus` or `external`; it sets the colour and defaults to `backend`. An edge or message variant is one of `default`, `emphasis`, `security` or `dashed`, and a sequence message may also be `return`. An empty cell means "use the default".

When a row is wrong, rendering fails with a message that starts `Row <n>:` and names the problem.

## sequence

Who sends what to whom, top to bottom.

- `["actor <id>", label, type?]` declares an actor. Actors appear left to right in the order they are declared.
- `[from, to, label, variant?]` is a message. `from` and `to` are actor ids or actor labels. A name that matches neither adds an `external` actor at the right. `from` and `to` may be the same actor. Messages are nodes too: the n-th message row is node `m<n>`, counting from 1 and skipping actor and phase rows, so an actor cannot take an id of that form.
- `["phase", label]` starts a band that covers the following messages, up to the next phase. A phase needs at least one message.

```json
{"type": "sequence", "title": "Question to stored answer", "rows": [
  ["actor ui", "Page", "frontend"],
  ["actor api", "Server"],
  ["actor db", "Store", "database"],
  ["phase", "Ask"],
  ["ui", "api", "POST /questions"],
  ["api", "ui", "202 queued", "return"],
  ["phase", "Store"],
  ["api", "db", "save answer", "emphasis"],
  ["db", "db", "reindex", "dashed"]
]}
```

## workflow

Steps and the transitions between them, left to right.

- `[id, label, type?, lane?]` declares a step. Keep a label to about four words. A label that ends in `?` is drawn as a decision, so label its outgoing edges with the answers.
- `["from > to", label?, variant?]` is a transition. Keep its label to one or two words. Loops back to an earlier step are fine. A step cannot point to itself.
- `["lane <id>", label]` declares a lane, a band that groups steps. Lanes are stacked top to bottom in declared order. Once any lane exists, a step without a lane joins the first one. A lane reads best with six steps or fewer.

```json
{"type": "workflow", "title": "Release", "rows": [
  ["lane prep", "Prepare"],
  ["lane ship", "Ship"],
  ["build", "Build", "backend", "prep"],
  ["green", "Tests green?", "security", "prep"],
  ["fix", "Fix it", "frontend", "prep"],
  ["deploy", "Deploy", "cloud", "ship"],
  ["build > green"],
  ["green > deploy", "yes", "emphasis"],
  ["green > fix", "no", "dashed"],
  ["fix > build", "retry"]
]}
```

A workflow without lanes that grows too wide is laid out top to bottom instead.

## erd

Tables, their fields and how they relate.

- `["entity <id>", label]` declares an entity.
- `["<entity>.<field>", type, keys?, references?]` adds a field to a declared entity, in row order. `keys` is a comma-separated list of `pk`, `fk` and `uk`. `references` is `<entity>.<field>`, and it must name a declared field.
- `["from > to", cardinality, label?]` is a relationship. `cardinality` is `one:one`, `one:many`, `many:one` or `many:many`; its first half belongs to `from`. An entity may relate to itself.

When a field references the other entity, the relationship line joins the two field rows. Otherwise it joins the entities' sides.

```json
{"type": "erd", "title": "Questions and answers", "rows": [
  ["entity question", "Question"],
  ["entity answer", "Answer"],
  ["question.id", "bigint", "pk"],
  ["question.text", "text"],
  ["answer.id", "bigint", "pk"],
  ["answer.question_id", "bigint", "fk", "question.id"],
  ["answer > question", "many:one", "answers"]
]}
```
