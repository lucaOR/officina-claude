# Rule entry schema

File header: `scope:` (`root_scope` or a service name) and `topic:` (= filename stem), then `rules:` list.
The `scope:` must be the scope of the root the file lives under: `root_scope` anywhere under the
project root's `.claude/knowledge/` (its `epics/` included), and the scope directory's own name under
any other scope root (a service, an `extra_scopes` match). `validate.py` reports any other value as
`scope_mismatch`, because the on-edit hook would never inject that file's rules.
Fully-qualified id (FQID): `<scope>/<topic>#<id>`.

Per rule:
- `id` (required) — short, stable, kebab-case, unique within the file.
- `title` (required) — one line.
- `applies_to` — `services: [..]` (root-scope rules: explicit), `globs: [..]`, `layers: [..]`, `languages: [..]`.
- `severity` — `blocking` (enforced by an external gate, or hard-fail) | `recommended` (default).
- `override_policy` — `overridable` (default) | `binding` (no other rule may override it;
   `validate.py` reports an override of it as `override_of_binding`). Meant for a security
   invariant or a cross-service contract. Nothing restricts it to one scope: a service scope
   may hold a `binding` rule too.
- `digest_only` — `true` keeps the rule in the always-loaded digest for awareness but
   excludes it from per-file matching (no REVIEW reminders, no checks). Use for
   file-agnostic process/commit/command-time rules and epic context. Default `false`.
- `resident` — `true` keeps the rule's full line in a tiered digest instead of collapsing
   it to a bare id on the `also:` line (its body stays one lookup away; the digest's trailer
   says how to look a rule up).
   Default `false`. Set it when the rule is (`blocking` or `binding`) AND has no `check`,
   or when it is `digest_only` and prescribes an action (the on-edit hook can never
   deliver a `digest_only` rule). Leave it off for architecture explainers. A resident
   line carries only the first 90 characters of `rule` — the gist truncates there — so the
   directive belongs in that opening span, not at the end of a long body.
- `sweep_only` — `true` excludes the rule from `check.py`'s default per-file matching (the
   `check-on-edit.py` PostToolUse hook, the `knowledge-check` skill); only a caller that passes
   `--include-sweep-only` (a review sweep, if the project has one) still matches it. Use for a judgment-only rule (no `check`) whose `applies_to.globs` are broad
   enough to remind on nearly every commit — `report.py`'s `noisy` list is the signal;
   the scribe's health sweep (`/knowledge:kb run`, see its "Health triage") tries an executable `check:` first, and reaches for `sweep_only` only
   when the rule requires genuine semantic judgment (e.g. classifying whether a comment names
   an inbound vs. outbound caller) that a shell check cannot approximate without misfiring in
   the other direction. Default `false`. Orthogonal to `digest_only`/`resident`: a
   `sweep_only` rule still shows on the digest's `also:` line as usual. It is ALSO orthogonal
   to `no_jit` — this field governs the reminder channel only, and a `sweep_only` rule still
   has its body injected before an edit.
- `no_jit` — `true` stops `inject-rules-on-edit.py` (PreToolUse on `Edit|Write|MultiEdit`)
   from re-injecting the rule's collapsed body the first time a session is about to write a
   matching file. That injection is the ONLY edit-time delivery a non-resident rule has, so
   this is the field that decides whether a rule reaches you while you are writing the code.
   Set it when the body cannot help at authoring time and only applies to finished text — a
   comment-phrasing or naming nit. Leave it OFF for anything that guides how code is
   structured or where a file goes, even when the rule is also `sweep_only`: silencing a
   noisy reminder is not a reason to withhold authoring guidance, and conflating the two is
   how tagging a rule quietly turned into losing it. Default `false`.
   `digest_only` rules already never inject, so `no_jit` on one is redundant.
- `trigger` — short phrase: the moment the rule becomes relevant (shown in the digest).
- `rule` — the normative guidance.
- `check` (optional) — `{ scope: file|class|project, shell: "...", flag_when: "> 3" }`.
   `scope: file` (default) substitutes `{file}` and runs once per matching changed
   file. `scope: project` substitutes `{files}` (the space-joined list of matching
   changed files) and runs ONCE for the diff — for cross-file parity / aggregate
   counts. `scope: class` currently behaves as `file` (PHP keeps one class per file).
   `flag_when` compares the command's numeric stdout: one of `>`, `<`, `>=`, `<=`,
   `==`, `!=` followed by an integer; true = violation. The command runs in the
   project root, or in the service's directory for a service check. `{root}`
   always expands to the project root, so a path such as an ast-grep rule file
   kept under the project root resolves the same way from every service.
- `rationale` — why.
- `source` — provenance (origin rule file / incident date).
- edges (optional, lists of FQIDs): `overrides`, `conflicts_with`, `see_also`.

Epic entries reuse id/title/applies_to/source/see_also and swap the body for
`status`, `decisions`, `acceptance_criteria`, `deferred`, `gotchas`.

## Project config

`.claude/knowledge/config.yaml` holds the project layout specifics. The file is optional: an
absent or empty file gives every default below. A file that does not parse, an unknown key or a
value of the wrong type falls back to the default for that key and costs one stderr line per
process. Keys are loaded by `lib.load_config(root)`.

- `root_scope` (string, default `project`) — scope name of the root registry: every
  registry under the project root's `.claude/knowledge/` declares it.
- `extra_scopes` (list of globs, default `[]`) — globs relative to the project root; each match
  that holds `.claude/knowledge` is a scope. Top-level directories holding `.claude/knowledge`
  are always scopes.
- `registry_fallbacks` (list of strings, default `[]`) — templates containing `{service}`,
  tried after `<root>/<service>` when resolving a service's registry.
- `unprobed_scopes` (list of scope names, default `[]`) — scopes whose `unreachable_glob` check
  is skipped.
- `probe_roots` (list of `{registry, tree}`, default `[]`) — `registry` is a glob over scope
  names and `tree` a template with `{name}`; a matching scope's globs are probed against
  `root/tree`, and the probe is skipped when that directory is absent.
- `gate_marker` (string, default `knowledge pre-commit gate`) — the text `check-on-edit` looks
  for in an installed pre-commit hook to know the gate is present.
- `digest_trailer` (string, default the plugin's built-in trailer) — text appended after a
  newline to a tiered digest.
- `digest_guard` (`{resident, max_bytes}`, default absent) — the numbers the digest guard in
  `knowledge:knowledge-route` step 5 (`python3 scripts/test_build_digest.py --root <repo-root>`,
  run only when this key is set) checks the root digest against: `resident` is the exact
  count of `resident: true` rules in the root scope, and `max_bytes` a backstop the rendered root
  digest must stay under. Either key may be left out; a guard without its number is skipped, and
  with the key absent there is no guard. Bump `resident` in the commit that changes residency.
- `scribe.commit` (`commit` | `stage`, default `commit`) — `commit` is a pathspec-limited
  commit; `stage` runs `git add` on the same pathspec and stops.
- `scribe.pathspecs` (list of strings, default `[.claude/knowledge]`) — the commit pathspec;
  entries matching nothing in the checkout are dropped at run time.
- `scribe.path_translations` (list of `{from, to}`, default `[]`) — rewrites such as
  `{from: "{service}/.claude", to: "shared/{service}/.claude"}`, applied only when
  `<service>/.claude` is a symlink.
- `scribe.audit_every_days` (integer, default `7`) — how often `/knowledge:kb run` owes the
  full health sweep.
- `scribe.lease_minutes` (integer, default `60`) — how long a run lease stays fresh without a
  refresh.
- `scribe.capture` (`off` | `auto` | `handoff` | `transcript`, default `off`) — whether and how
  learnings are captured automatically; `off` captures nothing.

Worked example, a repository whose services keep their `.claude/` in a tracked `shared/`
directory and link it into the service, with a web app and a set of extensions beside them
(`digest_trailer` shortened here):

```yaml
root_scope: platform
extra_scopes: [shared/web-app, "shared/extensions/*"]
registry_fallbacks: ["shared/{service}", "shared/extensions/{service}"]
unprobed_scopes: [web-app]
probe_roots:
  - {registry: "shared/extensions/*", tree: "extensions/{name}"}
gate_marker: platform shared githooks
digest_trailer: |
  Epics: ... (the pointer line, then the footer)
digest_guard: {resident: 30, max_bytes: 18432}
scribe:
  commit: commit
  pathspecs: [".claude/knowledge", "shared/*/.claude/knowledge"]
  path_translations:
    - {from: "{service}/.claude", to: "shared/{service}/.claude"}
```
