import fs from 'node:fs';
import path from 'node:path';

const MODELS = ['claude-opus-5', 'claude-sonnet-5'];
const TOOLS = ['Read', 'Grep', 'Edit', 'Write', 'Bash', 'Agent'];
const PROMPTS = [
  'add the stock reservation to the orders endpoint',
  'why does the basket total drift by a cent',
  'write a test for the declined card path',
  'rename OrderLine to LineItem across the shop',
  'the checkout page flickers on slow networks',
  'split the payment client out of the orders module',
];

// A small seeded generator, so the same seed always writes the same bytes.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeHelpers(rand) {
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const hex = (n) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('');
  const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-${'89ab'[int(0, 3)]}${hex(3)}-${hex(12)}`;
  return { int, pick, uuid };
}

const stamp = (ms) => new Date(ms).toISOString();

const assistant = (mid, ts, model, usage, content) => ({
  type: 'assistant',
  timestamp: stamp(ts),
  message: { id: mid, model, content, usage },
});
const userText = (ts, text) => ({ type: 'user', timestamp: stamp(ts), message: { role: 'user', content: [{ type: 'text', text }] } });
const toolResult = (ts, toolUseId, text) => ({
  type: 'user',
  timestamp: stamp(ts),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] },
});

// An Agent tool call spawns a short transcript of its own, kept beside the session.
function subagent(h, model, startMs) {
  const { int, uuid } = h;
  const records = [];
  let ts = startMs;
  let ctx = 0;
  const responses = int(3, 14);
  for (let i = 0; i < responses; i += 1) {
    ts += int(10, 60) * 1000;
    const read = i === 0 ? 0 : ctx;
    const create = i === 0 ? int(9000, 16000) : int(300, 2500);
    ctx = read + create;
    const usage = { input_tokens: int(3, 30), cache_read_input_tokens: read, cache_creation_input_tokens: create, output_tokens: int(60, 900) };
    records.push(assistant(`msg_${uuid().replaceAll('-', '')}`, ts, model, usage, [{ type: 'text', text: 'Searching.' }]));
  }
  return records;
}

function session(rand, h, startMs) {
  const { int, pick, uuid } = h;
  const model = pick(MODELS);
  const responses = int(20, 120);
  const compactAt = rand() < 0.25 ? int(Math.floor(responses * 0.4), Math.floor(responses * 0.8)) : -1;
  const records = [userText(startMs, pick(PROMPTS))];
  const subagents = [];
  let ts = startMs;
  let ctx = 0;
  let rebuild = false;
  for (let i = 0; i < responses; i += 1) {
    ts += int(30, 180) * 1000;
    let read;
    let create;
    if (i === 0) {
      read = 0;
      create = int(24000, 26000);
    } else if (rebuild) {
      read = int(8000, 12000);
      create = int(38000, 42000);
      rebuild = false;
    } else {
      read = ctx;
      create = int(400, 3500);
    }
    ctx = read + create;
    const content = [{ type: 'text', text: 'Working on it.' }];
    let toolId = null;
    if (rand() < 0.6) {
      toolId = `toolu_${uuid().replaceAll('-', '')}`;
      const name = pick(TOOLS);
      content.push({ type: 'tool_use', id: toolId, name, input: {} });
      if (name === 'Agent') subagents.push(subagent(h, model, ts));
    }
    const usage = {
      input_tokens: int(3, 40),
      cache_read_input_tokens: read,
      cache_creation_input_tokens: create,
      output_tokens: int(80, 1400),
    };
    records.push(assistant(`msg_${uuid().replaceAll('-', '')}`, ts, model, usage, content));
    if (toolId) {
      ts += int(1, 8) * 1000;
      records.push(toolResult(ts, toolId, 'x'.repeat(int(200, 6000))));
    }
    if (i === compactAt) {
      ts += 2000;
      records.push({
        type: 'user',
        timestamp: stamp(ts),
        isCompactSummary: true,
        message: { role: 'user', content: 'Summary of the conversation so far.' },
      });
      rebuild = true;
    } else if (i % 9 === 8) {
      ts += 4000;
      records.push(userText(ts, pick(PROMPTS)));
    }
  }
  return { records, subagents };
}

export function writeDemoTranscripts(dir, { seed = 7, start = '2026-10-01', days = 28 } = {}) {
  const rand = mulberry32(seed);
  const h = makeHelpers(rand);
  const ids = [];
  fs.mkdirSync(dir, { recursive: true });
  for (let d = 0; d < days; d += 1) {
    const day = new Date(Date.parse(`${start}T00:00:00Z`) + d * 86400000);
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
    const count = h.int(2, 6);
    for (let s = 0; s < count; s += 1) {
      const startMs = day.getTime() + (9 * 60 + h.int(0, 600)) * 60000;
      const id = h.uuid();
      const { records, subagents } = session(rand, h, startMs);
      const lines = (rs) => rs.map((r) => JSON.stringify(r)).join('\n') + '\n';
      fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines(records));
      if (subagents.length) {
        const sub = path.join(dir, id, 'subagents');
        fs.mkdirSync(sub, { recursive: true });
        for (const rs of subagents) fs.writeFileSync(path.join(sub, `agent-${h.uuid().replaceAll('-', '').slice(0, 17)}.jsonl`), lines(rs));
      }
      ids.push(id);
    }
  }
  return ids;
}
