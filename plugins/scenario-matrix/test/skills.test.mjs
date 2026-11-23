import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = join(PLUGIN, 'skills');

const skills = () => readdirSync(SKILLS, { withFileTypes: true })
  .filter(e => e.isDirectory() && existsSync(join(SKILLS, e.name, 'SKILL.md')))
  .map(e => ({ name: e.name, dir: join(SKILLS, e.name), text: readFileSync(join(SKILLS, e.name, 'SKILL.md'), 'utf8') }));

const frontmatter = text => {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  return m ? Object.fromEntries(m[1].split('\n').map(l => l.match(/^([\w-]+):\s*(.*)$/)).filter(Boolean).map(x => [x[1], x[2]])) : {};
};

test('every skill has name and description frontmatter', () => {
  const all = skills();
  assert.ok(all.length > 0, 'no skill found');
  for (const s of all) {
    const fm = frontmatter(s.text);
    assert.equal(fm.name, s.name, `${s.name}: name must match the folder`);
    assert.match(fm.description ?? '', /^Use when /, `${s.name}: description must start "Use when "`);
  }
});

test('every ${CLAUDE_SKILL_DIR} path a skill names exists', () => {
  for (const s of skills()) {
    const paths = [...s.text.matchAll(/\$\{CLAUDE_SKILL_DIR\}([^\s`'")]*)/g)].map(m => m[1]);
    for (const p of paths) assert.ok(existsSync(resolve(s.dir, `.${p}`)), `${s.name}: missing ${p}`);
  }
});

test('no skill invokes python3', () => {
  for (const s of skills()) assert.doesNotMatch(s.text, /python3/, s.name);
});
