import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = join(PLUGIN, 'agents', 'runner.md');
const RUN_SKILL = join(PLUGIN, 'skills', 'run', 'SKILL.md');
const PROCEDURE = join(PLUGIN, 'skills', 'run', 'reference', 'batch-run.md');

const frontmatter = text => {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  return m ? Object.fromEntries(m[1].split('\n').map(l => l.match(/^([\w-]+):\s*(.*)$/)).filter(Boolean).map(x => [x[1], x[2]])) : {};
};

test('the runner agent exists and pins its model to sonnet', () => {
  assert.ok(existsSync(RUNNER), 'agents/runner.md is missing');
  const fm = frontmatter(readFileSync(RUNNER, 'utf8'));
  assert.equal(fm.name, 'runner');
  assert.ok(fm.description, 'runner: description is missing');
  // Pinned in the definition, so the model does not depend on the dispatcher
  // or on a personal CLAUDE_CODE_SUBAGENT_MODEL.
  assert.equal(fm.model, 'sonnet');
});

test('the runner agent keeps every tool, because the procedure follows the run log with Monitor', () => {
  const fm = frontmatter(readFileSync(RUNNER, 'utf8'));
  assert.equal(fm.tools, undefined, 'a tools allowlist would drop Monitor');
});

test('the run skill dispatches the runner agent, not a fork', () => {
  const text = readFileSync(RUN_SKILL, 'utf8');
  assert.match(text, /subagent_type: "scenario-matrix:runner"/);
  assert.doesNotMatch(text, /subagent_type: "fork"/);
});

test('the run skill hands the runner the batch procedure by path', () => {
  assert.ok(existsSync(PROCEDURE), 'skills/run/reference/batch-run.md is missing');
  assert.match(readFileSync(RUN_SKILL, 'utf8'), /\$\{CLAUDE_SKILL_DIR\}\/reference\/batch-run\.md/);
});

test('the batch procedure holds the runner sections, and the skill no longer does', () => {
  const procedure = readFileSync(PROCEDURE, 'utf8');
  const skill = readFileSync(RUN_SKILL, 'utf8');
  for (const h of ['## Live monitoring', '## Diagnosing a run', '## Report', '## Evidence', '## Self-check after a run']) {
    assert.ok(procedure.includes(`\n${h}`), `batch-run.md lacks ${h}`);
    assert.ok(!skill.includes(`\n${h}`), `SKILL.md still holds ${h}`);
  }
});
