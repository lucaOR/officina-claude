## sanctum adapter

1. How is it stood up for real?

   It starts nothing. It signs requests for a Laravel application that already runs, and that application mounts Sanctum's stateful-frontend middleware in front of its API routes. Setup detects it from `laravel/sanctum` in `composer.json`. It requires the `http` adapter, whose client it extends.

2. How do you know it is ready, without waiting a fixed time?

   `client.csrf(kind)` is the readiness probe for the session. It requests `/sanctum/csrf-cookie` and is Blocked unless the route answers 200 or 204 and the jar then holds an `XSRF-TOKEN` for that host. A mutating request sent before that is refused before the socket is touched, so the app never gets the chance to answer 500 "CSRF token mismatch".

3. What deterministic marker shows it processed something?

   The cookies and the status. `csrf()` lands the session cookie and `XSRF-TOKEN` in the jar, and the next call replays them. A request that carries the stateful headers and a valid session answers as the user, where one without them answers 401 with a valid session sitting unused.

4. How do you force it to fail and undo that?

   A caller `headers` entry wins over the adapter's, so a row can send a wrong `Origin` or a bad `X-XSRF-TOKEN` and assert the rejection. There is nothing to undo, because the override applies to that one request.

5. What does it do that the others don't?

   It closes a failure that fails open. The stateful gate reads `referer ?: origin` and returns false when both are absent, which is what a browser automation request context sends. The route then answers 401 with the right cookies present, and the row reports Ko against a guard it never reached. Every request through this adapter carries both headers, and a `raw-request` lint rule rejects a bare `context.request.<verb>(` in a compiled script.

### Levers

| Lever | Signature | Notes |
| --- | --- | --- |
| `apiRequest` | `apiRequest(context, b, kind, path, opts)` | A request through a browser context's own cookie jar, with the stateful headers and, on `post`, `put`, `patch` and `delete`, the `X-XSRF-TOKEN` of that host. `b` is any object with `host(kind)`, and the registry qualifies. `failOnStatusCode` defaults to false. A `get` or `head` that carries a body is Inconclusive, because it is almost always a dropped `method`. |
| `statefulHeaders` | `statefulHeaders(host)` | `{ Referer: 'https://<host>/', Origin: 'https://<host>' }`. An empty host is Inconclusive. |
| `xsrfToken` | `xsrfToken(context, host)` | The token for that one host, percent-decoded. Blocked when the host never issued one, because the jar may hold another host's, which would be refused. |

### Contribution to the http client

When this adapter is installed, every client `apiClient` builds gains:

- the stateful headers on every request, for the host the request resolves to;
- `X-XSRF-TOKEN` on `POST`, `PUT`, `PATCH` and `DELETE`, read from the jar for that host and percent-decoded. A caller that sets the header, in any case, is left alone. A mutating request with no token in the jar is Blocked, and its message says to call `client.csrf()`;
- `client.csrf(kind)`, which requests `/sanctum/csrf-cookie` and checks the result as described above.

### Other contributions

- Lint: `raw-request` rejects `context.request.<verb>(` and `page.request.<verb>(` in compiled scripts. Use `apiRequest`. A mention in a comment is not flagged.
