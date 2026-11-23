# Scenario harness

Behaviour-driven end-to-end scenarios for this project. A **matrix** is a yaml file of behaviour rows. A **compiled scenario** is an executable script that asserts exactly what one row claims. Rows that pass are regression guards, and rows that fail are findings.

`node _lib/run.mjs <epic> --plan` prints how many rows a matrix holds and how many are compiled.

    .claude/scenarios/
      <epic>.yaml          a matrix: one row per behaviour, plus infra.env_registry
      _scripts/<epic>/     one compiled .mjs per row
      _lib/                the lever library the scripts import, plus run.mjs and its tests
      _infra/              bring-up, teardown and baseline scripts, and whatever else the stack needs
      _artifacts/          run output
      AUTHORING.md         how to write, lint, run and triage a scenario
      README.md            this file

The scenarios run against a dedicated environment that is reset to a known baseline before every row. Nothing in a scenario may reach an environment you did not set up for it.

## Who owns what

`_lib/.plugin-manifest.json` lists every file the scenario-matrix plugin owns, with its hash. Those files are replaced when the plugin is upgraded, so do not edit them. Everything else is yours:

- `_lib/hooks.mjs`, where the project answers the core's extension points;
- `_lib/scenarios.config.json`, with the paths, the database prefix and each adapter's settings;
- `_lib/project-exports.mjs` and `_lib/project-api.md`, for the levers the project writes itself;
- `_infra/`, the matrices, and the compiled scripts.

`_lib/index.mjs`, `_lib/adapters.mjs` and `_lib/harness-api.md` are generated: change their inputs, not the files. `_lib/harness-api.md` is the reference for every function a script may import and every hook `hooks.mjs` may define.

## From a fresh clone

1. Install the lever library's dependencies, and any one-time tool the adapters need:

        cd .claude/scenarios/_lib
        npm install

   The plugin's setup prints the system packages an adapter needs. Installing them is your call, and setup never does it.

2. Write the bring-up. `_infra/up.sh` is a placeholder that refuses to run until you edit it: it must start the environment and wait until it is ready on a real signal, never a fixed sleep. Then fill in `_infra/down.sh`, and `_infra/baseline.sh`, whose placeholder also refuses, so every row is BLOCKED until it restores the data.

3. Check the install. From `.claude/scenarios`, `npm test` in `_lib` must pass, and for each matrix:

        node _lib/check.mjs <epic>.yaml
        node _lib/lint.mjs <epic>
        node _lib/run.mjs <epic> --plan

## Running

    cd .claude/scenarios

    node _lib/run.mjs <epic> --plan      # what would run; no environment needed
    node _lib/lint.mjs <epic>            # static checks; must print "lint: clean"

    node _lib/run.mjs <epic>             # the whole matrix
    node _lib/run.mjs <epic> C           # one family
    node _lib/run.mjs <epic> C-01        # one row

`run.mjs` owns the environment's whole lifecycle. It calls the `lifecycle.up` command from `scenarios.config.json` before the first row, and `lifecycle.down` at the end. When the bring-up exits with the config's `lifecycle.refusedExit` code (78), it stopped before changing anything: `run.mjs` tears nothing down and reports the run as blocked.

Run one `run.mjs` at a time. A lock stops a second one, but it cannot stop a stray command typed by hand from corrupting a run in progress.

`SCN_KEEP_WARM=1` skips the teardown so the next run can skip the bring-up. It never skips the baseline restore. Use it while iterating on one row.

Evidence from a run lands in the directory the config's `runsDir` names, which should stay outside version control.

## Writing or changing scenarios

`AUTHORING.md` is the operative guide. Read its section 0 before editing any row: the rule about when you may correct a row, and when you must leave a failing assert alone, decides whether this harness is worth having.

## What is not in git

Generated or per-machine, each regenerable:

    _lib/node_modules            npm install
    _infra/.scn-warm             written and cleared by run.mjs
    the runsDir directory        run evidence
