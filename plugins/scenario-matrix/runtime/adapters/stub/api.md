## stub adapter

1. How is it stood up for real?

   The stubs are servers the project runs itself, usually as containers beside the product. The adapter starts nothing and needs no other adapter. A stub is any server that answers a control plane under `/__scn/`, and the adapter reaches it over HTTP or HTTPS. Setup detects it from an `infra.env_registry.stubs` key.

2. How do you know it is ready, without waiting a fixed time?

   The first call to `/__scn/requests` is the probe. A stub that is not listening, or whose certificate cannot be negotiated, is Blocked with "did not connect", and a stub whose control plane answers a non-2xx status is Blocked with that status. Neither is ever read as a product failure.

3. What deterministic marker shows it processed something?

   The journal. `GET /__scn/requests` returns one entry for each request the stub received, and a row compares the journal before and after the step. `clear()` empties it, because the journal has no per-scenario reset of its own.

4. How do you force it to fail and undo that?

   `stubFault(reg, name).fail({ path, status, times })` posts a fault to `/__scn/fail`, so the stub answers `status` on `path` for the next `times` requests, or for every request when `times` is omitted. `clear()` sends `DELETE /__scn/fail` and is Blocked on a non-2xx answer, because a fault that stays live would break the next scenario in code that is not its own.

5. What does it do that the others don't?

   It separates two addresses of the same stub. The harness fetches `stubs.<name>`, the address Node on the host can reach. A fixture value that a product container will fetch uses `reg.stubInternal(name)`, the address from inside the stack. Control-plane calls tolerate a self-signed certificate on that one request, and never relax verification for the whole process.

### Registry keys

```yaml
infra:
  env_registry:
    stubs:                  # stub name -> the URL the harness reaches it at
      payments: http://127.0.0.1:9101
    stubs_internal:         # stub name -> the URL it is reachable at from inside the stack
      payments: http://payments:8080
```

Both keys are mappings of a name to a non-empty URL, validated when the registry loads.

### Levers

| Lever | Signature | Notes |
| --- | --- | --- |
| `stub` | `stub(reg, name)` | Returns `{ requests(), clear() }`. `requests()` reads the journal. `clear()` empties it. An unknown name is Blocked and says to add it under `stubs`. |
| `stubFault` | `stubFault(reg, name)` | Returns `{ fail({ path, status = 500, times = Infinity }), clear() }`. |
| `reg.stubInternal` | `reg.stubInternal(name)` | The in-stack address. An unknown name is Blocked and says to add it under `stubs_internal`. |

### Configuration

```json
{ "adapters": { "stub": { "selftest": { "name": "payments" } } } }
```

- `selftest.name`: a stub name from `stubs`. When set, `selftest.mjs` runs both probes against it. When null, both are skipped.

### Other contributions

- Selftest: `stub journal: records a request` reads the journal only. `stub fault: injects then clears` arms a fault on a path outside `/__scn/`, checks it, and clears it in a `finally`, so a failed probe never leaves a fault armed.
