# diagrams

Sequence, workflow, entity-relationship, state, tree, timeline and architecture diagrams from a few compact JSON rows. A plain Node renderer places everything, so there is no Mermaid, no browser and no network involved. The output is a standalone HTML page or an SVG file, and both follow the system's light or dark theme.

## Install

In Claude Code:

```
/plugin marketplace add lucaOR/officina-claude
/plugin install diagrams@officina-claude
```

Then `/diagrams:diagram` takes a description of the diagram you want. Claude also uses the skill on its own when you ask for a diagram.

You can also run the renderer directly with a current Node (the tests run on Node 24). Clone the repository and call the CLI:

```
node plugins/diagrams/bin/diagram.mjs spec.json
```

### From npm

The package `@officina-claude/diagrams` is prepared for npm, but it may not be published yet. Once it is, you can run the renderer without cloning the repository. It needs Node 20 or newer.

```
npx @officina-claude/diagrams spec.json --out release.html
npm install -g @officina-claude/diagrams    # then: diagram spec.json
```

The `diagram` command takes the same options as `bin/diagram.mjs`: `--out <file.html|file.svg>`, `--style <default|editorial>` and `--palette <file.json>`.

## Quickstart

Save this as `release.json`. A row never holds coordinates, because the engine places every node.

```json
{"type": "workflow", "title": "Release", "rows": [
  ["build", "Build"],
  ["green", "Tests green?", "security"],
  ["deploy", "Deploy", "cloud"],
  ["build > green"],
  ["green > deploy", "yes", "emphasis"],
  ["green > build", "no", "dashed"]
]}
```

Render it:

```
node plugins/diagrams/bin/diagram.mjs release.json                  # release.html
node plugins/diagrams/bin/diagram.mjs release.json --out release.svg # a standalone SVG
```

The CLI prints one line of JSON, `{"ok":true,"out":"release.html","nodes":[...]}`. A bad row fails with a message that starts with `Row <n>:`, which names the row to fix. The row format of every kind is in [`skills/diagram/reference/rows.md`](skills/diagram/reference/rows.md).

## Gallery

Each picture below is rendered from the spec next to it, and the SVG files adapt to a light or dark system theme. This block is generated: run `node scripts/gallery.mjs` after changing the reference, and `node scripts/gallery.mjs --check` fails when a file is out of date.

<!-- gallery -->

#### sequence

![Question to stored answer](examples/sequence.svg)

Spec: [`examples/sequence.json`](examples/sequence.json)

#### workflow

![Release](examples/workflow.svg)

Spec: [`examples/workflow.json`](examples/workflow.json)

#### erd

![Questions and answers](examples/erd.svg)

Spec: [`examples/erd.json`](examples/erd.json)

#### state

![Order](examples/state.svg)

Spec: [`examples/state.json`](examples/state.json)

#### tree

![Plugin layout](examples/tree.svg)

Spec: [`examples/tree.json`](examples/tree.json)

#### timeline

![Project history](examples/timeline.svg)

Spec: [`examples/timeline.json`](examples/timeline.json)

#### architecture

![Web app](examples/architecture.svg)

Spec: [`examples/architecture.json`](examples/architecture.json)

<!-- /gallery -->

## Style and palette

`--style editorial` draws the editorial look, and `--style default` is the standard one. The spec can carry the same choice as `"style": "editorial"`, and the flag wins.

`--palette colours.json` recolours a diagram. The file maps a node type (`frontend`, `backend`, `database`, `cloud`, `security`, `messagebus`, `external`, `focus`) or a theme part (`ink`, `muted`, `panel`, `line`, `lane`, `rule`, `emphasis`, `security`, `dashed`) to a colour. A colour is `#hex`, a strict `rgb()` or `hsl()`, or `var(--name)`, and a `[light, dark]` pair sets each scheme. Any other value is rejected, so nothing a palette holds can reach the stylesheet.

By default the text, muted text and node fill follow the host page's CSS variables `--ink`, `--muted` and `--panel` and fall back to built-in light and dark colours when the page defines none. A `--palette` entry for `ink`, `muted` or `panel` replaces that.

```
node plugins/diagrams/bin/diagram.mjs release.json --style editorial --palette colours.json
```

## Promises

- Zero dependencies. The plugin imports only its own files and Node's built-in modules, and it needs no browser at render time.
- Deterministic. The same spec, style and palette give byte-identical output, which is why the gallery can be checked against a fresh render.

## Limits

- There is no PNG export, so convert the SVG yourself if you need a raster image.
- There are no charts. The seven kinds are all the plugin draws.
- There are no importers for Mermaid, draw.io or PlantUML.
- Class, quadrant and Gantt diagrams are not supported yet.
- A diagram is laid out automatically, so you cannot place a node by hand.

## Licence

MIT. The full text is in the `LICENSE` file at the root of the [officina-claude repository](https://github.com/lucaOR/officina-claude).
