// The plan folder on disk: paths, the lock and atomic writes. Every writer goes through withLock.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOCK_RETRY_MS = 50;
const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 30000;

export function plansDir(projectDir, env = process.env) {
  return path.resolve(projectDir, env.PLANNING_PLANS_DIR || 'docs/plans');
}

export function planPaths(dir) {
  return {
    working: path.join(dir, 'working.json'),
    real: path.join(dir, 'plan.json'),
    changes: path.join(dir, 'changes.json'),
    threads: path.join(dir, 'threads.json'),
    questions: path.join(dir, 'questions.jsonl'),
    handled: path.join(dir, 'handled.jsonl'),
    md: path.join(dir, 'plan.md'),
  };
}

// Where the server keeps port, key, pid and log for this plan folder. Only computes the path.
export function stateDir(dir) {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  const digest = crypto.createHash('sha256').update(fs.realpathSync(dir)).digest('hex').slice(0, 12);
  return path.join(base, 'planning', digest);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function breakStaleLock(lock) {
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmdirSync(lock);
  } catch { /* released or taken by someone else meanwhile */ }
}

export async function withLock(dir, fn) {
  const lock = path.join(dir, '.lock');
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { fs.mkdirSync(lock); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      breakStaleLock(lock);
      if (Date.now() > deadline) throw new Error(`plan folder is locked: ${lock}`);
      await sleep(LOCK_RETRY_MS);
    }
  }
  try { return await fn(); }
  finally { try { fs.rmdirSync(lock); } catch { /* already gone */ } }
}

export function writeTextAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function writeJsonAtomic(file, value) {
  writeTextAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function initPlan(plans, slug, title, date, intent = null) {
  const dir = path.join(plans, `${date}-${slug}`);
  if (fs.existsSync(dir)) throw new Error(`plan folder already exists: ${dir}`);
  fs.mkdirSync(dir, { recursive: true });
  const p = planPaths(dir);
  writeJsonAtomic(p.working, {
    schema: 1, slug, title, counters: { D: 0, T: 0, S: 0 },
    domains: [], decisions: [], tasks: [], scenarios: [],
    ...(intent ? { intent } : {}),
  });
  writeJsonAtomic(p.changes, { next: 1, log: [] });
  writeJsonAtomic(p.threads, { next: 1, threads: [] });
  fs.writeFileSync(p.questions, '');
  fs.writeFileSync(p.handled, '');
  return dir;
}
