import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mail, mailCount, mailMessage } from '../observe.mjs';
import { matchMessages, mailPayload, MAIL_LIST_LIMIT } from '../adapter-mailpit.mjs';
import * as dockerAdapter from '../adapter-docker.mjs';
import * as mailpitAdapter from '../adapter-mailpit.mjs';
import { collectProbes } from '../selftest.mjs';
import { __setForTest } from '../ext.mjs';
import { Blocked } from '../errors.mjs';
import { installFakeDocker } from './support/fake-docker.mjs';

let restoreExt;
beforeEach(() => { restoreExt = __setForTest({ adapters: { docker: dockerAdapter, mailpit: mailpitAdapter }, providers: {}, hooks: {}, config: {} }); });
afterEach(() => restoreExt());

const PAYLOAD = { total: 2, messages: [
  { ID: 'aB3', To: [{ Name: '', Address: 'a@x.test' }], Subject: 'Invite' },
  { ID: 'cD4', To: [{ Name: 'B', Address: 'b@x.test' }], Subject: 'Other' },
] };
const REG = { raw: { mail: { container: 'app_mailbox', api: 'http://127.0.0.1:8025/api/v1' } } };

test('matchMessages reads a recipient without a Name as its address alone', () => {
  const payload = { messages: [{ ID: 'n1', Subject: 'S', To: [{ Address: 'bare@x.test' }] }] };
  assert.equal(matchMessages(payload, { to: 'bare@x.test' }).length, 1);
  assert.equal(matchMessages(payload, { to: 'undefined' }).length, 0, 'a missing Name must not render as "undefined"');
});

test('matchMessages filters message summaries by recipient and subject', () => {
  assert.equal(matchMessages(PAYLOAD, { to: 'a@x.test' }).length, 1);
  assert.equal(matchMessages(PAYLOAD, { subject: /Invite/ }).length, 1);
  assert.equal(matchMessages(PAYLOAD, { to: 'a@x.test', subject: /Other/ }).length, 0);
  assert.equal(matchMessages(PAYLOAD, {}).length, 2);
});

test('the list limit is the default retention of one mailbox', () => {
  assert.equal(MAIL_LIST_LIMIT, 500);
});

test('mailPayload lists the whole box from inside the mail container', async () => {
  const seen = [];
  await mailPayload(REG, { run: async a => { seen.push(a); return JSON.stringify(PAYLOAD); } });
  assert.deepEqual(seen[0], ['exec', '-i', 'app_mailbox', 'wget', '-qO-', 'http://127.0.0.1:8025/api/v1/messages?limit=500']);
});

test('a payload without a messages array is Blocked, not read as an empty mailbox', async () => {
  await assert.rejects(() => mailPayload(REG, { run: async () => '{"total":0,"items":[]}' }), e => e instanceof Blocked && /messages/.test(e.message));
});

test('a body that is not JSON is Blocked', async () => {
  await assert.rejects(() => mailPayload(REG, { run: async () => '<html>' }), e => e instanceof Blocked && /not JSON/.test(e.message));
});

test('a failed read is Blocked, and a typed error passes through unchanged', async () => {
  await assert.rejects(() => mailPayload(REG, { run: async () => { throw new Error('boom'); } }), e => e instanceof Blocked && /mail read failed: boom/.test(e.message));
  const typed = new Blocked('daemon down');
  await assert.rejects(() => mailPayload(REG, { run: async () => { throw typed; } }), e => e === typed);
});

test('a missing mail registry entry is Blocked and names both fields', async () => {
  await assert.rejects(() => mailPayload({ raw: {} }), e => e instanceof Blocked && /container.*api/s.test(e.message));
  await assert.rejects(() => mailPayload({ raw: { mail: { container: 'c' } } }), Blocked);
});

test('mailMessage fetches one message, and refuses a non-message id without docker', async () => {
  const seen = [];
  await mailMessage(REG, 'aB3', { run: async a => { seen.push(a); return '{"ID":"aB3"}'; } });
  assert.equal(seen[0].at(-1), 'http://127.0.0.1:8025/api/v1/message/aB3');
  await assert.rejects(() => mailMessage(REG, '../x', { run: async () => { throw new Error('docker reached'); } }), Blocked);
});

test('mailCount reads the total', async () => {
  assert.equal(await mailCount(REG, { run: async () => JSON.stringify(PAYLOAD) }), 2);
});

test('mail() filters through the injected run', async () => {
  const m = await mail(REG, { to: 'b@x.test' }, { run: async () => JSON.stringify(PAYLOAD) });
  assert.equal(m.length, 1);
  assert.equal(m[0].ID, 'cD4');
});

test('the drivers are exactly the three mail levers', () => {
  assert.deepEqual(Object.keys(mailpitAdapter.drivers).sort(), ['mail', 'mailCount', 'mailMessage']);
});

test('the registry key validates a container and an api', () => {
  const { validate } = mailpitAdapter.registry.keys.mail;
  assert.equal(validate({ container: 'c', api: 'http://x/api/v1' }), null);
  assert.match(validate('nope'), /mapping/);
  assert.match(validate({ container: 'c' }), /api/);
  assert.match(validate({ api: 'u' }), /container/);
});

test('the mailCount probe reads only and needs the enabled flag', async (t) => {
  const probes = cfg => collectProbes(REG, cfg).filter(p => p.owner === 'mailpit');
  assert.deepEqual(probes({}).map(p => p.name), ['mailCount: reads the mailbox total']);
  assert.equal(probes({})[0].missing, 'adapters.mailpit.selftest.enabled');
  const cfg = { adapters: { mailpit: { selftest: { enabled: true } } } };
  assert.equal(probes(cfg)[0].missing, undefined);
  installFakeDocker(t, `echo '{"total":3,"messages":[]}'`);
  assert.equal(await probes(cfg)[0].run(REG, cfg), true);
});
