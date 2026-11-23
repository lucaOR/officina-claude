## sql adapter

This adapter is internal: detection never proposes it, and it arrives through the `requires` of a dialect adapter. It holds everything about SQL that does not depend on a client, and a dialect adapter supplies the client.

1. How is it stood up for real?

   The databases run inside containers that the project's own compose file or `lifecycle.up` command starts. The adapter starts nothing. It reaches a database with `docker exec -i <container> <client...> <database>` and pipes the SQL over stdin, so the `docker` CLI must be on `PATH` and the container running. A container that is stopped, removed or unreachable fails as Blocked, never as a product failure.

2. How do you know it is ready, without waiting a fixed time?

   The adapter does not wait. Its levers run one statement and either answer or fail. Whether a database container is answering after a fault is the dialect adapter's question: it registers the probe that `stopFault` polls, through the docker adapter's `addReadyProbe`.

3. What deterministic marker shows it processed something?

   A row. `sql(reg, db, text)` returns the rows a statement produced, so write the state the code under test should have left (an inserted row, a changed column) and read it back with `one` or `scalar`. Select the specific row by a unique key instead of counting.

4. How do you force it to fail and undo that?

   This adapter has no fault of its own. The dialect adapter supplies `schemaFreeze`, which locks one schema, and the docker adapter supplies the container faults. What this adapter does force is a refusal: a target outside the scenario databases is rejected before anything runs.

5. What does it do that the others don't?

   It owns the guard that keeps a scenario inside its own databases, and it picks the client by dialect. `assertScnTarget` refuses any database whose name does not start with the configured `dbPrefix` (default `scn_`), before the registry is even consulted. A `db` entry names its dialect either by stating `dialect` or by its client: the adapter asks every installed `sql.<dialect>` driver whether its `clients` pattern matches the client's first word, and a client nobody claims is Blocked with the two remedies.

### Registry keys

```yaml
infra:
  env_registry:
    db:                       # database name -> where its client runs
      scn_app: "app_db <client> -uroot"            # "<container> <client...>", dialect inferred from the client
      scn_admin: { container: admin_db, client: "<client> -uroot", dialect: <dialect> }   # dialect stated
```

A mapping entry takes `client` as a string or a list of arguments. The key `db` is validated when the registry loads, and `reg.dbTarget(name)` returns `{ db, container, client, dialect }`. The containers of the `db` entries count as part of the fault perimeter that `stopFault` checks.

### Matrix ops

A row's `db` op names a scenario database in `target` and holds its statement, inline, in `sql`. It appears in `setup`, and under `mutate` in `steps`:

```yaml
setup:
  - db: { target: scn_app, sql: "INSERT INTO account (email) VALUES ('a@example.test')" }
steps:
  - mutate: { db: { target: scn_app, sql: "UPDATE account SET disabled = 1 WHERE email = 'a@example.test'" } }
```

`target` must start with `dbPrefix`, and the matrix self-check refuses any other. A dialect adapter's setup rehearsal, when it has one, runs these statements against the real schema.

### Levers

| Lever | Signature | Notes |
| --- | --- | --- |
| `sql` | `sql(reg, db, text, opts)` | Runs the text and returns the rows as objects. NULL is `null`. |
| `one` | `one(reg, db, text, opts)` | The first row, `null` for none, Ko for more than one. |
| `scalar` | `scalar(reg, db, text, opts)` | The first column of `one`. |

The target guard runs inside `sql`, before the registry is consulted. `one` calls `sql` and `scalar` calls `one`, so the guard reaches all three, and its refusal is Blocked. The guard checks the target argument and not the statement, so a statement that names another database still reaches it. The `ambient-db` lint rule covers that case.

### The dialect driver

A dialect adapter provides `drivers['sql.<dialect>']` as `{ clients: RegExp, args(target, text): string[], parse(raw): rows }`. `args` returns the docker arguments and the SQL goes to stdin. `parseRows(raw)` from `db.mjs` reads a header line followed by tab-separated rows with the client's backslash escapes (`\t`, `\n`, `\\`); `parseRows(raw, { escaped: false })` reads them verbatim, for a client that escapes nothing.

### Configuration

```json
{ "adapters": { "sql": { "ambientDbPrefixes": ["local", "shared"] } } }
```

- `ambientDbPrefixes`: the words that begin an ambient database name. Default: `["local"]`. An empty list turns the `ambient-db` rule off.

The database prefix itself is the top-level `dbPrefix`.

### Other contributions

- Lint: `ambient-db` rejects a name such as `local_app` anywhere in a compiled script, comments included, because the target guard cannot see a name inside the SQL. It is case-sensitive, so a constant such as `LOCAL_ONLY` is not a database. `prefix-literal` flags a `scn_` string literal that is not the target argument of `sql`, `one`, `scalar` or `schemaFreeze`.
