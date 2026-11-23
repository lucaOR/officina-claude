## postgres adapter

1. How is it stood up for real?

   The database runs as a container, started by the project's own compose file or by its `lifecycle.up` command. The adapter adds nothing to start. It reaches the server with the `psql` client inside that container, through `docker exec -i`, so the `docker` CLI must be on `PATH`. The `db` entry names the container and the client, for example `"app_db psql -U postgres"`.

2. How do you know it is ready, without waiting a fixed time?

   `pg_isready` inside a container answers `accepting connections` once the server takes connections. The adapter registers that probe with the docker adapter, so `stopFault` polls it after `docker start` instead of trusting that the container is merely running. A container named by a `db` entry is asked directly, with the `-U` role from its client args. A fault container whose `ready_via` names a `db` container is asked from that one, with `-h <container>`. Any other container is left to docker.

3. What deterministic marker shows it processed something?

   A row. Read the state the code under test should have left with `sql`, `one` or `scalar`. For a reset, the adapter plants a marker table before the baseline restore and checks that `to_regclass('scn_reset_probe')` is null afterwards, which proves the restore actually ran.

4. How do you force it to fail and undo that?

   It does not, in version 1. There is no `schemaFreeze` and no fault lever for this database. A scenario that needs the database unreachable stops its container with the docker adapter's `stopFault` and restores it with the same lever, which waits on the readiness probe above.

5. What does it do that the others don't?

   It speaks the `psql` client. It provides the `sql.postgres` dialect driver, which claims a client named `psql`, so the sql adapter infers the dialect of `"<container> psql -U postgres"` by itself. It also classifies the client's own failures: `database "<dbPrefix>..." does not exist` means the scenario stack was never provisioned, so it is Blocked, while every error about the data (an unknown column, a constraint violation) stays untyped and reaches KO. A database the product failed to create does not match the prefix, so it cannot launder itself out of KO.

### Levers

None of its own. `sql`, `one` and `scalar` come from the sql adapter.

`psql` runs unaligned, with a header line, tab-separated fields, `NULL` printed as the word and no `(N rows)` footer, so the rows parse with the tab-separated reader every sql dialect shares. `ON_ERROR_STOP=1` makes the first failing statement exit non-zero. `psql` escapes nothing, so a value is read back exactly as printed: a backslash stays a backslash, in a path or in a JSON string alike. A tab or newline inside a value is unsupported: it cannot be told from a field or row delimiter, so keep such values out of a compared column.

### No setup-SQL rehearsal

The adapter contributes no `rehearse` command, so the pre-rehearsal of a matrix's setup SQL is unavailable on a postgres-only install. A matrix is still checked by its first run.

### Configuration

```json
{ "adapters": { "postgres": { "sentinelDb": "scn_app" } } }
```

- `sentinelDb`: a `db` name. When set, reset creates the table `scn_reset_probe` there before the baseline restore and fails as Blocked if it survives. When null, both steps are skipped. Default: null.

### Other contributions

- Fatal log patterns: `ERROR:  ` (the server's prefix, with two spaces). It also matches an error a scenario provokes on purpose, such as a constraint violation the row asserts on, so read a hit against the row's intent before calling it fatal.
