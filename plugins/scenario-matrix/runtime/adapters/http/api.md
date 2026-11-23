## http adapter

1. How is it stood up for real?

   It starts nothing. The client talks to a service that the project's own compose file or `lifecycle.up` command already runs, over plain `node:http` and `node:https`. Each host kind a row names is an alias in `infra.env_registry.hosts`, or whatever the project's `resolveHost` hook turns that alias into. A resolved value that carries a scheme (`http://localhost:8000`) is the base URL as it stands, and a bare host such as `app.example.test` gets `https://`.

2. How do you know it is ready, without waiting a fixed time?

   A request either gets an answer or it does not. The socket opening is the readiness signal, and a failure to open one is Blocked, never Ko, because nothing was learned about the product when the connection was refused. The error says the container is down, the port is not published, or the stack was never brought up.

3. What deterministic marker shows it processed something?

   The response itself. `request` resolves `{ status, headers, body, bytes, json() }`, so a row asserts on the status, on a `Set-Cookie` the jar then replays, or on the `Location` a redirect carries. Redirects are never followed because they are the evidence, and a non-2xx never throws because half of the rows exist to assert a 404 or a 422.

4. How do you force it to fail and undo that?

   The client has no fault of its own. A row that needs the service down uses a fault from another adapter, such as `stopFault`, and then asserts that `request` throws Blocked at the transport.

5. What does it do that the others don't?

   It is the browser-free client. It keeps its own cookie jar, scoped per host so two applications' cookies of the same name cannot be confused, and it returns the response headers, which `scnFetch` discards. It also holds a bearer slot, and a seam, `addRequestHeaders`, through which other adapters and the project add what their authentication scheme needs on the wire.

### Levers

| Lever | Signature | Notes |
| --- | --- | --- |
| `apiClient` | `apiClient(reg, opts)` | Builds a client. `opts.transport` replaces the node agents (tests). The tenant is read from `opts` under the config's `tenantKey` and handed to the hooks. |
| `rawRequest` | `rawRequest({ url, method, headers, body, connect, agents })` | The one function that reaches outside the process. `connect` sends the socket to another `host:port` while the Host header and TLS SNI keep the logical name, like `curl --connect-to`. |
| `redirectTarget` | `redirectTarget(res, { base })` | The `Location` of a response as an absolute `URL`. Blocked when there is none. |

The client `apiClient` returns has these members:

| Member | Notes |
| --- | --- |
| `request(kind, path, opts)` | `opts` is `{ method, headers, json, body, multipart }`. Exactly one body option may be set, or the call is Inconclusive. Any other key is ignored. Caller `headers` win over every default. |
| `viaStub(name, url, opts)` | Sends `url` to the stub named in `infra.env_registry.stubs`, after checking that the URL points at the host the stub stands in for. It needs the stub adapter: without it the call is Blocked and names `/scenario-matrix:setup --add stub`. |
| `jar` | The `CookieJar`: `accept(host, setCookie)`, `header(host)` and `value(host, name)`, which percent-decodes. |
| `token`, `setToken(token)` | The bearer. When set, every request sends `Authorization: Bearer <token>`. Obtaining a token is the project's business. |
| `hostOf(kind)` | The host a kind resolves to, which is the key the jar files cookies under. |
| `addRequestHeaders(fn)` | See below. |
| `tenant` | The tenant the client was built for, or null. |

`encodeMultipart(fields, boundary)` is internal to `request`. A string field value is a plain part and an object with `buffer` is a file part, which must carry a `name`.

### Extending the client

`addRequestHeaders(fn)` registers `fn({ verb, host, path, opts, client })`, which returns a headers object and may throw to refuse the request before it is sent. `request` merges headers in this order, and a later one replaces an earlier one:

1. `Accept: application/json`
2. the headers each registered function returns, in registration order
3. `Authorization` from the bearer
4. `Cookie` from the jar
5. `Content-Type` and `Content-Length`, when there is a body
6. the caller's own `headers`

An installed adapter extends the client by exporting `httpClient(client, { reg, tenant })` from its contribution module. The project does the same with the `http.extendClient(client, { reg, tenant, opts })` hook, where `opts` are the options `apiClient` was called with, `transport` included, so a member the project adds can send through the same transport. Every contribution runs first, in adapter order, and the hook runs last, so the project has the final say.

### Hooks

| Hook | Signature | Default | Called |
| --- | --- | --- | --- |
| `resolveHost` | `(alias, { tenant, reg, use }) -> string` | `reg.host(alias)` | On every request, with `use` set to `'http'`. |
| `http.extendClient` | `(client, { reg, tenant, opts }) -> void` | The client is left as built | Once, when `apiClient` builds a client. |
