// The mailpit adapter's contribution module: the `mail` registry key, the `mail`, `mailCount` and
// `mailMessage` drivers, and one read-only selftest probe. The keys of `drivers` equal the
// `drivers` array of adapter.json.
//
// One shared Mailpit receives every service's mail. Its API is read from INSIDE its container
// (dockerRun + wget), not from the host, so a different listener on a host port can never be read
// by mistake.
import { Blocked, Ko, Inconclusive } from './errors.mjs';
import { dockerRun } from './docker.mjs';

export const name = 'mailpit';

const isMapping = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isTyped = err => err instanceof Blocked || err instanceof Ko || err instanceof Inconclusive;

// --- registry: mail ---

export const registry = {
  keys: {
    mail: {
      validate(value) {
        if (!isMapping(value)) return 'must be a mapping with `container` and `api`';
        if (typeof value.container !== 'string' || value.container === '') return 'container must be the mail container name';
        if (typeof value.api !== 'string' || value.api === '') return 'api must be the /api/v1 base URL as seen from inside that container';
        return null;
      },
    },
  },
};

// The default retention of one mailbox, so one list call returns the whole box.
export const MAIL_LIST_LIMIT = 500;

export function matchMessages(payload, { to = null, subject = null } = {}) {
  const messages = payload?.messages ?? [];
  return messages.filter(m => {
    // A bare address has no Name; it must render as nothing, not as the word "undefined" that a
    // `to` filter could then match.
    const toOk = !to || (m?.To ?? []).some(r => `${r.Name ?? ''} <${r.Address}>`.includes(to));
    const subj = String(m?.Subject ?? '');
    const subjOk = !subject || (subject instanceof RegExp ? subject.test(subj) : subj.includes(subject));
    return toOk && subjOk;
  });
}

function mailRegistry(reg) {
  const { container, api } = reg.raw.mail ?? {};
  if (!container || !api) {
    throw new Blocked(
      'infra.env_registry.mail is not set -- it needs both `container` (the mail container name) '
      + 'and `api` (the /api/v1 base URL as seen from inside that container), under '
      + 'infra.env_registry.mail in the epic file',
    );
  }
  return { container, api };
}

// Blanket Blocked, unlike a query client's narrow discrimination, for a reason: reading the mailbox
// is observation infrastructure. A refused connection or a body that is not JSON is not the product
// saying anything; what the product sent is observed in the payload by the callers.
async function mailGet(container, url, run) {
  const raw = await run(['exec', '-i', container, 'wget', '-qO-', url])
    .catch(err => { throw isTyped(err) ? err : new Blocked(`mail read failed: ${err.message}`, { cause: err }); });
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Blocked(`mail payload was not JSON: ${String(raw).slice(0, 200)}`, { cause: err });
  }
}

export async function mailPayload(reg, { run = dockerRun } = {}) {
  const { container, api } = mailRegistry(reg);
  const payload = await mailGet(container, `${api}/messages?limit=${MAIL_LIST_LIMIT}`, run);
  if (!Array.isArray(payload?.messages)) {
    throw new Blocked(
      'mail payload has no `messages` array: infra.env_registry.mail.api must be the /api/v1 base '
      + `(got a payload starting ${JSON.stringify(payload).slice(0, 120)})`,
    );
  }
  return payload;
}

async function mail(reg, filter = {}, opts = {}) {
  return matchMessages(await mailPayload(reg, opts), filter);
}

async function mailCount(reg, opts = {}) {
  return (await mailPayload(reg, opts)).total;
}

async function mailMessage(reg, id, { run = dockerRun } = {}) {
  const { container, api } = mailRegistry(reg);
  if (!/^[A-Za-z0-9]+$/.test(String(id))) {
    throw new Blocked(`mail id ${JSON.stringify(id)} is not a message id`);
  }
  return mailGet(container, `${api}/message/${id}`, run);
}

export const drivers = { mail, mailCount, mailMessage };

// --- selftest ---

export const selftest = [
  {
    // Reads only. The mailbox total is shared and only ever grows, so no "unchanged" or "grew by
    // one" claim is made without a send, and a send belongs to the application under test.
    name: 'mailCount: reads the mailbox total',
    needs: ['adapters.mailpit.selftest.enabled'],
    run: async reg => Number.isInteger(await mailCount(reg)),
  },
];
