---
name: diagram
description: Use when the user asks to draw a sequence diagram, a workflow or flowchart, or an entity-relationship diagram. Writes compact rows and renders them offline to a standalone HTML page or SVG file.
---

# Diagram

Draw one of three kinds of diagram from compact rows, offline and with no dependencies:
- `sequence`: who sends what to whom, in order.
- `workflow`: steps and decisions, optionally grouped in lanes.
- `erd`: tables, keys and relationships.

Pick the kind that answers the user's question. For anything else, such as an architecture map, a timeline or a chart, this skill is the wrong tool.

1. Read `${CLAUDE_SKILL_DIR}/reference/rows.md` before the first spec of the session.
2. Write the spec `{"type", "title", "rows"}` to a JSON file. Put it where the user asks; otherwise use a temporary directory, so it stays out of the project.
3. Render it:
   `node "${CLAUDE_PLUGIN_ROOT}/bin/diagram.mjs" <spec.json> [--out <file.html|file.svg>]`
   The default output is the spec path with `.html`: a page that follows the system light or dark theme. A `.svg` output carries its own styles.
4. Read the printed line.
   - `{"ok":true,...}` gives the file in `out`.
   - `{"ok":false,...}` has an `error` that names the row to fix. Fix it and render again.
5. Give the user the file path. Never read the generated HTML or SVG back, because the printed line is the check.
