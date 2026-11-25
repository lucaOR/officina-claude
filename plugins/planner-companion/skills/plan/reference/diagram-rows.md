# Diagram rows

A diagram is `{"type", "title", "rows"}`. `type` is `sequence`, `workflow`, `erd`, `state`, `tree`, `timeline` or `architecture`. An optional `style` field, `default` or `editorial`, picks the look. Each row is a JSON array of strings, and the renderer places everything, so a row never holds coordinates.

Ids start with a letter and continue with letters, digits, `-` or `_`. A node or actor type is one of `frontend`, `backend`, `database`, `cloud`, `security`, `messagebus`, `external` or `focus`; `focus` highlights the one node the reader should look at. The type sets the colour and defaults to `backend`. An edge or message variant is one of `default`, `emphasis`, `security` or `dashed`, and a sequence message may also be `return`. An empty cell means "use the default".

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

## state

States and the transitions between them, left to right.

- `[id, label, type?, group?]` declares a state. The optional `group` is an id of your choice; every state that shares it is drawn inside one flat frame. Groups do not nest here.
- `["initial <id>"]` and `["final <id>"]` declare a start or end marker. A marker takes no other cell, nothing may enter an initial marker and nothing may leave a final one.
- `["from > to", label?, variant?]` is a transition between states or markers. Loops are fine.

```json
{"type": "state", "title": "Order", "rows": [
  ["initial start"],
  ["final done"],
  ["new", "New"],
  ["paid", "Paid", "backend", "happy"],
  ["shipped", "Shipped", "backend", "happy"],
  ["cancelled", "Cancelled", "security"],
  ["start > new"],
  ["new > paid", "pay", "emphasis"],
  ["paid > shipped", "ship"],
  ["shipped > done"],
  ["new > cancelled", "cancel", "dashed"],
  ["cancelled > done"]
]}
```

## tree

A hierarchy, root at the top.

- `[id, label, type?]` declares a node. Type `focus` highlights it.
- `["parent > child"]` is an edge and takes no other cell. A node has one parent at most, and a cycle is rejected.

```json
{"type": "tree", "title": "Plugin layout", "rows": [
  ["root", "diagrams"],
  ["lib", "lib"],
  ["bin", "bin"],
  ["rows", "rows.mjs", "focus"],
  ["cli", "diagram.mjs", "frontend"],
  ["root > lib"],
  ["root > bin"],
  ["lib > rows"],
  ["bin > cli"]
]}
```

## timeline

Dated events along an axis, optionally split into tracks.

- `["track <id>", label]` declares a track, a row of events. Tracks are stacked in declared order.
- `[when, label, track?, type?]` is an event. `when` is `YYYY`, `YYYY-MM` or `YYYY-MM-DD`. An event without a track cell goes to the first declared track. The renderer sorts events by date, so row order does not matter.

```json
{"type": "timeline", "title": "Project history", "rows": [
  ["track plan", "Planning"],
  ["track build", "Building"],
  ["2025-01", "Kickoff", "plan"],
  ["2025-03-15", "Design signed off", "plan", "focus"],
  ["2025-04", "First prototype", "build", "frontend"],
  ["2025-06-30", "Release", "build", "cloud"]
]}
```

## architecture

Components, the groups that contain them and the connections between them.

- `["group <id>", label, parentGroup?]` declares a group. Groups nest, and a group may name a parent that is declared further down. A group is drawn as a dashed frame with its label inside the frame, at the top.
- `[id, label, type?, group?]` declares a component. Without a `group` cell it sits outside every group.
- `["from > to", label?, variant?]` is a connection between components. An edge that crosses groups ends on the inner component, not on a frame.

```json
{"type": "architecture", "title": "Web app", "rows": [
  ["group cloud", "Cloud"],
  ["group data", "Data tier", "cloud"],
  ["web", "Web app", "frontend"],
  ["api", "API", "backend", "cloud"],
  ["db", "Database", "database", "data"],
  ["queue", "Job queue", "messagebus", "data"],
  ["web > api", "HTTPS", "emphasis"],
  ["api > db", "SQL"],
  ["api > queue", "enqueue", "dashed"]
]}
```

## style and palette

`node diagram.mjs spec.json --style editorial` draws the editorial look; `--style default` is the standard one. The same choice can sit in the spec as `"style": "editorial"`, and the flag wins over the spec field.

`--palette colours.json` recolours a diagram. The file maps a name to a colour. A name is a node type (`frontend`, `backend`, `database`, `cloud`, `security`, `messagebus`, `external`, `focus`) or a theme part (`ink`, `muted`, `panel`, `line`, `lane`, `rule`, `emphasis`, `security`, `dashed`). A colour is `#hex`, a strict `rgb()` or `hsl()` with numbers only, or `var(--name)`. A single string applies to both colour schemes; a `[light, dark]` pair sets each. Anything else fails with `palette <key>: invalid colour`.

```text
{"database": ["#6d28d9", "#c4b5fd"], "focus": "#b91c1c", "ink": "var(--text)"}
```
