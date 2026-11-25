# Changelog

All notable changes to this plugin are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.0] - 2026-11-25

### Added

- Four new diagram kinds: `state`, `tree`, `timeline` and `architecture`, next to `sequence`, `workflow` and `erd`.
- Nested groups in layered layouts, so an architecture diagram can place nodes inside groups inside groups; a cross-group edge ends on the inner node.
- The editorial style, chosen with `--style editorial` or `"style": "editorial"` in the spec.
- A palette file for `--palette`, which recolours node types and theme parts, in a light and a dark value.
- The `focus` node type, which highlights the one node the reader should look at.
- A geometry test helper that fails a diagram with overlapping or out-of-bounds boxes.
- A gallery: `scripts/gallery.mjs` renders `examples/<kind>.json` and `examples/<kind>.svg` from the reference, fills the README gallery block, and `--check` fails when a file is out of date.
- A shared standalone-SVG helper, `lib/standalone.mjs`, used by the CLI and the gallery.
- A README with install, quickstart, gallery, style and palette options, promises and limits.

### Changed

- The row reference and the skill now cover all seven kinds.
- `render()` still returns `svg`, `css` and `nodes`; it also returns `boxes`, `width` and `height`.
- Layouts without groups are byte-identical to 0.1.1.

### Fixed

- A palette value such as `red;}body{x` is rejected and never written into the stylesheet.
- Group-border edge runs are routed around sibling nodes, and a group that spans lanes is rejected.
