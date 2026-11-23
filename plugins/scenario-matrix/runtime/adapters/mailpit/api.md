## mailpit adapter

1. How is it stood up for real?

   It starts nothing. One shared Mailpit container receives the mail of every service under test, and the project's own compose file starts it. Setup detects it from a `mailpit` image line in a compose file, or from an `infra.env_registry.mail` key. It requires the `docker` adapter, because every read runs a command inside that container.

2. How do you know it is ready, without waiting a fixed time?

   The first read is the probe. A list call that fails, or that answers something other than a JSON object with a `messages` array, is Blocked with the cause in the message. That includes a mail server of another kind whose list answers a different shape, so a wrong `api` URL is never read as an empty mailbox.

3. What deterministic marker shows it processed something?

   The `total` and the message list. `mailCount` rises by one for each message the box accepts, and `mail` returns the summaries that match a recipient or a subject. A row that sends mail records `mailCount` before and compares it after.

4. How do you force it to fail and undo that?

   It has no fault of its own. Pausing or stopping the mail container is the docker adapter's `dbFault` and `stopFault`, and a row that does so names the container in `fault_containers`.

5. What does it do that the others don't?

   It reads from inside the container (`exec -i <container> wget -qO- <url>`), not from a host port, so a different listener that happens to hold the host port can never be read by mistake. Every failure to read is Blocked, because a refused connection or a body that is not JSON says nothing about the product.

### Registry keys

```yaml
infra:
  env_registry:
    mail:
      container: app-mail                      # the mail container name
      api: http://127.0.0.1:8025/api/v1        # the /api/v1 base URL as seen from inside that container
```

Both fields are required and validated when the registry loads.

### Levers

| Lever | Signature | Notes |
| --- | --- | --- |
| `mail` | `mail(reg, { to, subject })` | Message summaries that match. `to` is a substring of `Name <address>`, and a bare address matches on the address alone. `subject` is a substring or a `RegExp`. No filter returns the whole box, up to 500 messages. |
| `mailCount` | `mailCount(reg)` | The mailbox `total`. The total is shared and only grows, so compare it before and after a send. |
| `mailMessage` | `mailMessage(reg, id)` | One full message. An `id` that is not alphanumeric is Blocked before docker is reached. |

Each lever takes an `opts.run` seam as its last argument, used by tests to replace the docker call.

### Configuration

```json
{ "adapters": { "mailpit": { "selftest": { "enabled": true } } } }
```

- `selftest.enabled`: when true, `selftest.mjs` reads the mailbox total as a probe. When false or unset, that probe is skipped. Default: false.

### Other contributions

- Selftest: `mailCount: reads the mailbox total`. It only reads. It sends no mail, because a send belongs to the application under test.
