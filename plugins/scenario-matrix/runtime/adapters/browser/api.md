## browser adapter

1. How is it stood up for real?

   It starts no service. `openBrowser(ctx)` launches Chromium through Playwright, headless unless `SCN_HEADFUL=1`, and registers the close on `ctx.cleanups`, so the browser closes on every exit path of `scenario()`. Playwright is installed in the lib's own `node_modules` by the adapter's `npm` entry, and `npx playwright install chromium` fetches the browser itself. The import is dynamic, so a row that never opens a browser never loads Playwright.

2. How do you know it is ready, without waiting a fixed time?

   Every wait is on a condition with a timeout from `TIMEOUTS`. `navigate` waits for `domcontentloaded`, and `expect-screen` waits for a named marker to be reached. A browser that cannot launch (no display for a headful run, a missing system library) fails `openBrowser`, which turns the row BLOCKED rather than KO, because nothing was learned about the product.

3. What deterministic marker shows it processed something?

   A marker from `infra.env_registry.login.markers`. A `dom:<selector>` marker waits for a visible element and a `url:<regex>` marker waits for the page URL to match. `assertMarker(reg, page, name, opts)` throws Blocked naming the marker and the URL it saw when the page never got there. On a KO, `screenshot` writes `page.png` and `browser.json` (console output, page errors, failed requests, and the start of every 4xx or 5xx body) into the evidence directory, and `snap(ctx, label)` numbers step shots for a rehearsal a person wants to read afterwards.

4. How do you force it to fail and undo that?

   `routeFault(page, matcher, { status, body })` answers every request the predicate accepts with a fixed status (500 by default) and lets all others through untouched. The predicate must pin the method as well as the path, so the read that renders a screen survives a fault on the write. The handle has `count`, the number of requests that were answered, and `clear()`, which removes the interception. Register `clear` on `ctx.cleanups` so a thrown assert cannot leak the fault into the next row.

5. What does it do that the others don't?

   It replays a login recipe, a list of plain lines under `infra.env_registry.login`, against a real page. The built-in ops are `navigate {host}`, `type {param} into <field>`, `click "<label>"`, `expect-screen <marker>`, `include <recipe>` and `raw`. A project adds ops of its own through the `login.ops` hook, and rewrites a recipe's lines through `login.transformRecipe`, so nothing about one product's login flow lives in the adapter.

### Levers

| Lever | Signature | Notes |
| --- | --- | --- |
| `openBrowser` | `openBrowser(ctx, { launchOptions, contextOptions })` | Returns `{ browser, context, page }` and fills `ctx.page`, `ctx.browser` and `ctx.browserLog`. |
| `login` | `login(reg, page, recipe, params)` | Replays a recipe and returns `{ url, tokenResponse: null, client: null, ...state.out }`. `params.stop_at` stops after the named `expect-screen`. |
| `assertMarker` | `assertMarker(reg, page, name, opts)` | Waits for a marker and throws Blocked when it is not reached. |
| `screenshot` | `screenshot(ctx, dir)` | The `captureEvidence` hook. Returns the path of `page.png`, or null when there is no page. |
| `snap` | `snap(ctx, label)` | Numbered step shots under the evidence `steps` directory. Returns null rather than throwing. |
| `routeFault` | `routeFault(page, matcher, { status, body })` | Fails the requests a predicate accepts. |
| `TIMEOUTS`, `LAUNCH_OPTIONS`, `CONTEXT_OPTIONS` | frozen objects | The defaults `openBrowser` starts from. |

### Registry keys

```yaml
infra:
  env_registry:
    hosts:
      app: app.example.test
    login:
      sign-in:
        - navigate {app}
        - type {id} into email
        - type {password} into password
        - click "Sign in"
        - expect-screen home
      markers:
        home: 'url:^https://{host:app}/home'
        form: 'dom:input[name="email"]'
```

The `login` key is a mapping of recipe name to a list of lines, plus a `markers` mapping. The accessors are `recipe(name)` and `marker(name, { tenant })`. Both throw Blocked for a name that does not exist. A `{host:<kind>}` in a marker is resolved through the `resolveHost` hook with `use: 'marker'`, and its dots are escaped because a marker value is a regular expression.

### Hooks

| Hook | Shape | Notes |
| --- | --- | --- |
| `login.ops` | `{ [op]: { run(step, env), browserFree?, consumes? } }` | A project op. `env` is `{ page, reg, recipe, params, tenant, state }`, and what an op puts in `state.out` is merged into the result of `login()`. An op without `browserFree` is refused when there is no page. A name that equals a built-in op is refused. |
| `login.transformRecipe` | `(lines, { name, tenant, reg }) -> string[]` | Rewrites a recipe's raw lines, including the lines of a recipe pulled in by `include`. |
| `resolveHost` | `(alias, { tenant, reg, use, params }) -> string` | `navigate` calls it with `use: 'navigate'` and an extra `params`, and a hook can refuse a navigation it cannot perform by throwing. The default is `reg.host(alias)`, with `https://` added when the value has no scheme. |

An op's `consumes` lists the params that only that op applies. When one of them is passed and the recipe never reached the op, `login()` throws Inconclusive, because the flow ran untouched and a fail-closed assert downstream would test nothing.

The login tenant is read from the option named by the config's `tenantKey` and is null when absent. The adapter has no default tenant, so a project's hooks decide what null means.

### Other contributions

- Driver: `routeFault`.
- Detection: a `playwright.config.*` file, a `playwright` or `@playwright/test` dependency in a `package.json`, or a `login` key in the registry.
- Install: `playwright` through npm, `npx playwright install chromium`, and the Debian package `libasound2t64`.
