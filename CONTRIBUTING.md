# Contributing

This page is for work on the plugins themselves. To install and use them, see the
[README](README.md).

## Develop

A fresh clone of this repo needs `npm ci` in `plugins/scenario-matrix` before `bin/test`,
because the runtime test assembly symlinks that package's `node_modules`.

```
claude --plugin-dir plugins/session        # load a plugin from this checkout
bin/test                                   # every offline test (stdlib unittest, no model calls)
claude plugin validate .                   # marketplace manifest
claude plugin validate plugins/<name>      # one plugin
```

Path rules that keep a plugin portable:

- Inside a `SKILL.md`, refer to the skill's own files as `${CLAUDE_SKILL_DIR}/...`.
- Inside an agent or a `hooks/hooks.json`, refer to plugin files as `${CLAUDE_PLUGIN_ROOT}/...`.
- Never reach into the project's `.claude/` for code. Only the project's data lives there.
- Hook scripts find the project through `$CLAUDE_PROJECT_DIR` and fail open.
- To share code between plugins, link it with a relative symlink that stays inside this repo.
  Installing a plugin copies the link's target in its place, so each installed plugin is
  self-contained. `planner-companion` gets the renderer this way: `skills/plan/scripts/lib/diagram`
  links to `plugins/diagrams/lib`, and `reference/diagram-rows.md` links to that plugin's row reference.

`scenario-matrix`'s `no-project-names` test keeps project-specific names out of the plugin.
It reads them from a gitignored `.project-terms` file at the repo root, one term per line,
and skips that check when the file is absent.

### Refine eval

`plugins/session/skills/refine/eval/` replays interview scenarios against a worktree of a
project that has the `session` plugin enabled. Pass the project to the scorer with
`score_scenario.py <stream> --expect ... --project <worktree>`.

## README images

Apart from the pixel-art logo, every image in the README is real plugin output. The plugins
render the images from demo data: the diagram specs and the plan in `.github/assets/src/`, and
the synthetic transcripts that `tools/readme/transcripts.mjs` writes. The demo is a small
bookshop's checkout, and the metrics project is `/demo/bookshop`. `bin/readme-shots`
regenerates the images:

```
bin/readme-shots                                       # finds Chromium on its own
CHROME=/path/to/chrome-headless-shell bin/readme-shots # or uses this one
```

It writes these files into `.github/assets/`:

- `checkout-sequence`, `catalogue-erd` and `handoff-loop`, each as a `-light.svg` and a
  `-dark.svg`. The `diagrams` plugin's CLI renders each spec in `src/`, and the script then pins
  the SVG to one theme and paints a solid background, so that a `<picture>` element can pick
  the file that matches the visitor's GitHub theme.
- `plan-light.webp` and `plan-dark.webp`, a 1280x1090 screenshot of the plan page's stock tab,
  which shows the decision cards and the thread that `src/plan-thread.json` asks and answers.
  The script builds the plan with `planner-companion`'s `planning.mjs` from `src/plan.json` and
  `src/plan-thread.json`, in a temporary folder with its own `HOME`. It opens the page at
  `#stock`, which the page itself turns into that tab, and fails when the answered card does
  not fit in the capture.
- `dashboard-light.webp` and `dashboard-dark.webp`, a 1280x900 screenshot of the token
  dashboard. The script writes seeded synthetic transcripts for `/demo/bookshop` and runs
  `token-hygiene`'s `SessionEnd` hook and dashboard builder over them. Both run with `HOME` set
  to a temporary folder, so your own `~/.claude/metrics` never reaches the image. They also run
  with `TZ=UTC` and without any `METRICS_*` variable, so the image is the same wherever you run
  the script.
- `social-preview.png`, a 1280x640 screenshot of `src/social.html`. This file is gitignored.
  Upload it by hand in the repository's Settings > General > Social preview.
- `logo.svg`, the pixel-art logo at the top of the README: the Claude Code mascot in a hard hat.
  `tools/readme/logo.mjs` holds its pixel grid and writes the SVG, which is transparent so one
  file serves both themes. `tools/readme/logo.test.mjs` checks that the committed file matches
  the generator, that the hat is as wide as the mascot, and that the file stays small.
- `wordmark-light.svg` and `wordmark-dark.svg`, the title under the logo, with `-claude` in
  terracotta. GitHub strips colour from HTML text, so the title is an SVG that a `<picture>`
  element picks by theme. `wordmarkSvg()` in `tools/readme/logo.mjs` writes both.

The screenshots need a headless Chromium. The script uses the binary that `CHROME` names. When
`CHROME` is unset or names no file, it takes the newest `chromium_headless_shell-*` build in the
Playwright cache, which is `~/.cache/ms-playwright` on Linux and `~/Library/Caches/ms-playwright`
on macOS. Failing that, it looks on `PATH` for `chromium`, `chromium-browser`, `google-chrome`
and `google-chrome-stable`, in that order. It starts the browser before it writes anything, so
when it finds none, or the one it finds does not start, it exits with a message and
`.github/assets/` stays as it was. It drives the browser over the DevTools protocol with a US
English locale, so the dashboard's dates read the same on every machine. It sets the colour
scheme before each page loads, because the dashboard draws its charts on load.

The script ends by printing the size of each image and the total of all but
`social-preview.png`. It exits with an error when that total is over the budget of 1,000,000
bytes. `readme.test.mjs` applies the same budget to everything under `.github/assets/`, the
sources included, except `social-preview.png`.

`tools/readme/readme.test.mjs` guards the README and this page. It checks that every local link
and image exists, that every anchor matches a heading, that each marketplace plugin has a
section and is counted in the plugins badge, that every `<picture>` pairs a `-dark` source with
a `-light` fallback, and that the assets stay under the budget. It also reads `.project-terms`,
when the file exists, and fails on any project term in the docs or in the asset sources. Its
failure message names the file and the line, never the term.
