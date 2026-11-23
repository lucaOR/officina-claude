import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDemoPlan } from './plan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('demo plan renders its diagrams and the answered thread', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'readme-plan-'));
  try {
    const file = await buildDemoPlan(tmp);
    const html = fs.readFileSync(file, 'utf8');
    const figures = html.match(/<figure[^>]*data-diagram=[^>]*>[\s\S]*?<\/figure>/g) ?? [];
    assert.ok(figures.length >= 2, `found ${figures.length} diagram figures`);
    for (const f of figures) assert.ok(f.includes('<svg'), 'a diagram figure has no svg');
    const { target, answer } = JSON.parse(fs.readFileSync(path.join(root, '.github', 'assets', 'src', 'plan-thread.json'), 'utf8'));
    assert.ok(html.includes(answer), 'the answer text is on the page');
    // The README picture shows the stock tab, with the answered thread inside the target's card.
    const panel = html.match(/<section data-tab-panel="stock"[\s\S]*?<\/section>/)?.[0] ?? '';
    const card = panel.match(new RegExp(`<article class="card" id="${target}"[\\s\\S]*?</article>`))?.[0] ?? '';
    assert.match(card, /<div class="thread" [^>]*data-state="open"/, `no open thread in the ${target} card on the stock tab`);
    assert.ok(card.includes(answer), `the answer is not in the ${target} card`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
