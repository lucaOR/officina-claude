---
name: diagram
description: Use when the user asks to draw a sequence diagram, a workflow or flowchart, an entity-relationship diagram (erd), a state diagram, a tree, a timeline or an architecture diagram. Writes compact rows and renders them offline to a standalone HTML page or SVG file.
---

# Diagram

Draw one diagram from compact rows, offline and with no dependencies. Pick the kind by the question it answers:
- `sequence`: who sends what to whom, in order?
- `workflow`: which steps and decisions lead where, optionally in lanes?
- `erd`: which tables, keys and relationships exist?
- `state`: which states can a thing be in, and what moves it between them?
- `tree`: what contains what, as a hierarchy with one parent per node?
- `timeline`: what happened when, optionally on parallel tracks?
- `architecture`: which components make up a system, grouped and nested, and how do they connect?

For anything else, such as a chart, this skill is the wrong tool.

1. Read `${CLAUDE_SKILL_DIR}/reference/rows.md` before the first spec of the session.
2. Write the spec `{"type", "title", "rows"}` to a JSON file. Put it where the user asks; otherwise use a temporary directory, so it stays out of the project.
3. Render it:
   `node "${CLAUDE_PLUGIN_ROOT}/bin/diagram.mjs" <spec.json> [--out <file.html|file.svg>] [--style default|editorial] [--palette <file.json>]`
   The default output is the spec path with `.html`: a page that follows the system light or dark theme. A `.svg` output carries its own styles. Add `--style editorial` for the editorial look and `--palette` to recolour; both are described at the end of the reference.
4. Read the printed line.
   - `{"ok":true,...}` gives the file in `out`.
   - `{"ok":false,...}` has an `error` that names the row to fix. Fix it and render again.
5. Give the user the file path. Never read the generated HTML or SVG back, because the printed line is the check.
