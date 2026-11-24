## mysql adapter

1. How is it stood up for real?

   The database runs as a container, started by the project's own compose file or by its `lifecycle.up` command. The adapter adds nothing to start. It reaches the server with the `mysql` or `mariadb` client inside that container, through `docker exec -i`, so the `docker` CLI must be on `PATH`. The `db` entry names the container and the client, for example `"app_db mysql -uroot"`, or `"app_db mysql -uroot -psecret"` for a server that requires a password. Every docker call the adapter makes goes through that client. The arguments after the client binary also go to `mysqladmin` and `mysqldump`, so they must be connection options all three accept (user, password, host, port, socket). A `mariadb` client pairs with `mariadb-admin` and `mariadb-dump`, which recent mariadb images ship in place of the mysql-named tools.

2. How do you know it is ready, without waiting a fixed time?

   `mysqladmin ping` inside a container answers `mysqld is alive` once the server accepts connections. The adapter registers that probe with the docker adapter, so `stopFault` polls it after `docker start` instead of trusting that the container is merely running. A container named by a `db` entry is pinged directly, with its client's arguments, because a server that denies the ping never answers `alive`. A fault container whose `ready_via` names a `db` container is pinged from that one, with `-h <container>`. Any other container is left to docker.

3. What deterministic marker shows it processed something?

   A row. Read the state the code under test should have left with `sql`, `one` or `scalar`. For a reset, the adapter plants a marker table before the baseline restore and checks that it is gone afterwards, which proves the restore actually ran.

4. How do you force it to fail and undo that?

   `schemaFreeze(reg, schema)` takes a WRITE lock on every base table of one schema from a single long-lived client, so every query against that schema waits while every other schema and service carries on. It returns `{ restore }`, which unlocks and waits for the confirmation. It needs `SCN_ALLOW_CONTAINER_FAULT=1`, and only a database whose name starts with `dbPrefix` can be frozen. The listing, the lock and the recovery all connect with the `db` entry's client. The lock lives as long as the client's connection, so a recovery armed on process exit, SIGTERM and SIGINT issues `KILL <connection id>` through a second connection. A lock that is not confirmed within 15 seconds is Blocked and the client is killed.

5. What does it do that the others don't?

   It speaks the `mysql` and `mariadb` clients. It provides the `sql.mysql` dialect driver, which claims a client named `mysql` or `mariadb`, so the sql adapter infers the dialect of `"<container> mysql -uroot"` by itself. It also classifies the client's own failures: `Unknown database '<dbPrefix>...'` means the scenario stack was never provisioned, so it is Blocked, while every error about the data (an unknown column, a constraint violation) stays untyped and reaches KO. A database the product failed to create does not match the prefix, so it cannot launder itself out of KO.

### Levers

| Lever | Signature | Notes |
| --- | --- | --- |
| `schemaFreeze` | `schemaFreeze(reg, schema, opts)` | Locks every base table of `schema`. `restore()` unlocks. |

`sql`, `one` and `scalar` come from the sql adapter.

### The setup-SQL rehearsal

```
node .claude/scenarios/_lib/rehearse-sql.mjs <matrix.yaml> [--family F] [--mutates]
```

It runs every scenario's `db` setup statements against the real schema, so a missing column or a violated constraint is found before any run. Statements for one target run together, in matrix order. A group with no implicit-commit statement runs between `START TRANSACTION` and `ROLLBACK` on the real database. A group with one (`ALTER`, `CREATE`, `DROP`, `TRUNCATE`, and the like, which commit implicitly and cannot be rolled back) runs in a throwaway clone named `<dbPrefix>rh_<name>`, which is dropped afterwards. When that drop fails, the rehearsal only prints a warning and the clone stays, so the project's `teardown` must also drop every leftover `<dbPrefix>rh_*` database. A target whose name does not start with `dbPrefix` fails its group before anything reaches docker, because the rehearsal executes real SQL. Each group connects with its target's `db` entry client, and the clone is filled with `mysqldump` and the same credentials. A client call that runs longer than 30 seconds, or a clone fill that runs longer than 10 minutes, is killed and fails its group. `--family F` keeps the rows `F-*`, and `--mutates` also runs each `mutate` step with its target's setup replayed first. Exit `0` is all green, `1` is at least one failing scenario, `2` is a matrix with no `db` map.

### Configuration

```json
{ "adapters": { "mysql": { "sentinelDb": "scn_app", "selftest": { "db": "scn_app" } } } }
```

- `sentinelDb`: a `db` name. When set, reset creates the table `scn_reset_probe` there before the baseline restore and fails as Blocked if it survives. When null, both steps are skipped. Default: null.
- `selftest.db`: a `db` name. When set, `selftest.mjs` runs `sql: positive` against it. When null, that probe is skipped.

### Other contributions

- Lint: `mysql-cli` rejects `mysql -u...` in compiled scripts. Use `sql`.
- Fatal log patterns: `SQLSTATE`. It also matches an error a scenario provokes on purpose, such as a constraint violation the row asserts on, so read a hit against the row's intent before calling it fatal.
- Selftest: `sql: positive` and `sql: guard refuses a dev database`. The guard probe never reaches docker.
- Verify: `docker exec {container} {client} -N -e "SELECT COUNT(*) ..."` checks that a table exists in a database. `{container}` and `{client}` come from `reg.dbTarget('<db>')`.
