#!/usr/bin/env node
// The single CLI of the planning plugin. Each task adds its subcommands to COMMANDS.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderDiagram } from './lib/diagrams.mjs';
import { loadSource, validateSource, buildIndex } from './lib/source.mjs';
import { renderMarkdown } from './lib/markdown.mjs';
import { renderPlanPage } from './lib/page.mjs';
import { checkIntent, describeIntent } from './lib/intent.mjs';
import { initPlan, planPaths, plansDir, readJson, stateDir } from './lib/store.mjs';
import * as queue from './lib/queue.mjs';
import { applyPatch, pick as pickOption, undo as undoChange, updateReal } from './lib/changes.mjs';

function diagram(args) {
  const file = args.find(a => !a.startsWith('--'));
  if (!file) return usage('diagram needs a spec file');
  let spec;
  try { spec = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return print({ ok: false, error: `cannot read spec: ${e.message}` }, 1); }
  const result = renderDiagram(spec);
  return print(result, result.ok ? 0 : 1);
}

function readSource(file) {
  try { return { source: loadSource(file) }; }
  catch (e) { return { diagnostics: [{ code: 'source-unreadable', path: file, message: `cannot read source: ${e.message}` }] }; }
}

function validate(args) {
  const prevAt = args.indexOf('--previous');
  const previousFile = prevAt >= 0 ? args[prevAt + 1] : undefined;
  const file = args.filter((a, i) => !a.startsWith('--') && !(prevAt >= 0 && i === prevAt + 1))[0];
  if (!file) return usage('validate needs a source file');
  const current = readSource(file);
  const previous = previousFile ? readSource(previousFile) : {};
  const diagnostics = current.diagnostics || previous.diagnostics
    || validateSource(current.source, { previous: previous.source });
  return print({ ok: diagnostics.length === 0, diagnostics }, diagnostics.length ? 1 : 0);
}

function index(args) {
  if (!args[0]) return usage('index needs a source file');
  const { source, diagnostics } = readSource(args[0]);
  if (diagnostics) return print({ ok: false, diagnostics }, 1);
  return print(Object.fromEntries(buildIndex(source)), 0);
}

function md(args) {
  if (!args[0]) return usage('md needs a source file');
  const { source, diagnostics } = readSource(args[0]);
  if (diagnostics) return print({ ok: false, diagnostics }, 1);
  process.stdout.write(renderMarkdown(source));
  return 0;
}

// Split args into positionals, value flags and boolean flags.
function parseArgs(args, valueFlags, boolFlags = []) {
  const positionals = []; const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (valueFlags.includes(a)) flags[a] = args[++i];
    else if (boolFlags.includes(a)) flags[a] = true;
    else if (a.startsWith('--')) return { error: `unknown option: ${a}` };
    else positionals.push(a);
  }
  const missing = valueFlags.find(f => f in flags && flags[f] === undefined);
  return missing ? { error: `${missing} needs a value` } : { positionals, flags };
}

const outcome = result => print(result, result.ok ? 0 : result.conflict ? 3 : 1);

function init(args) {
  const { positionals, flags, error } = parseArgs(args, ['--title', '--date', '--project', '--intent']);
  if (error) return usage(error);
  if (positionals.length !== 1 || !flags['--title']) return usage('init needs <slug> --title <title>');
  const date = flags['--date'] || new Date().toLocaleDateString('sv');
  const project = flags['--project'] || process.cwd();
  let intent = null;
  if (flags['--intent']) {
    try { intent = describeIntent(project, flags['--intent']); }
    catch (e) { return print({ ok: false, error: e.message }, 1); }
  }
  const dir = initPlan(plansDir(project, process.env), positionals[0], flags['--title'], date, intent);
  process.stdout.write(`${dir}\n`);
  return 0;
}

function intentCheck(args) {
  const { positionals, flags, error } = parseArgs(args, ['--project']);
  if (error) return usage(error);
  if (positionals.length !== 1) return usage('intent-check needs <plan-dir> [--project <dir>]');
  try {
    const { intent } = readJson(planPaths(positionals[0]).working);
    if (!intent) return print({ ok: true, intent: null }, 0);
    const result = checkIntent(flags['--project'] || process.cwd(), intent);
    return print({ ok: true, intent: result }, result.changed ? 1 : 0);
  } catch (e) { return print({ ok: false, error: e.message }, 1); }
}

async function apply(args) {
  const { positionals, flags, error } = parseArgs(args, ['--kind', '--summary', '--question']);
  if (error) return usage(error);
  if (positionals.length !== 2) return usage('apply needs <plan-dir> <patch.json>');
  const kind = flags['--kind'];
  if (kind !== 'author' && kind !== 'change') return usage('apply needs --kind author|change');
  let patch;
  try { patch = JSON.parse(fs.readFileSync(positionals[1], 'utf8')); }
  catch (e) { return print({ ok: false, diagnostics: [{ code: 'patch-unreadable', path: positionals[1], message: `cannot read patch: ${e.message}` }] }, 1); }
  const question = flags['--question'];
  const result = await applyPatch(positionals[0], patch, { kind, summary: flags['--summary'], question });
  if (result.ok && question) {
    try { await queue.markApplied(positionals[0], question, result.change?.id); }
    catch (e) { return print({ ok: false, error: e.message }, 1); }
  }
  return outcome(result);
}

// Run a queue operation; a thrown message (unknown id, double handling) is a diagnostic, not a crash.
async function queued(fn, ok = { ok: true }) {
  try { const value = await fn(); return print(value === undefined ? ok : value, 0); }
  catch (e) { return print({ ok: false, error: e.message }, 1); }
}

function ask(args) {
  if (args.length !== 4) return usage('ask needs <plan-dir> <kind> <target> <text>');
  const [dir, kind, target, text] = args;
  if (kind !== 'comment' && kind !== 'change') return usage('ask kind must be comment or change');
  return queued(() => queue.ask(dir, { kind, target, text }));
}

function next(args) {
  if (args.length !== 1) return usage('next needs <plan-dir>');
  return print(queue.unanswered(args[0])[0] ?? null, 0);
}

function answer(args) {
  const { positionals, flags, error } = parseArgs(args, ['--text'], ['--suggest-change']);
  if (error) return usage(error);
  if (positionals.length !== 2 || flags['--text'] === undefined) return usage('answer needs <plan-dir> <qid> --text <t> [--suggest-change]');
  return queued(() => queue.answer(positionals[0], positionals[1], flags['--text'], { suggestChange: Boolean(flags['--suggest-change']) }));
}

function ack(args) {
  if (args.length !== 2) return usage('ack needs <plan-dir> <qid>');
  return queued(() => queue.ack(args[0], args[1]));
}

function resolveThread(args) {
  if (args.length !== 2) return usage('resolve needs <plan-dir> <thread>');
  return queued(() => queue.resolve(args[0], args[1]));
}

function toChange(args) {
  if (args.length !== 2) return usage('to-change needs <plan-dir> <thread>');
  return queued(() => queue.toChange(args[0], args[1]));
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Block until a question is pending (print it, exit 0) or the server is gone (exit 4). A pending
// question is checked first, so one is never lost to a stopped server.
async function watch(args) {
  const { positionals, flags, error } = parseArgs(args, ['--interval-ms']);
  if (error) return usage(error);
  if (positionals.length !== 1) return usage('watch needs <plan-dir> [--interval-ms <n>]');
  const interval = Number(flags['--interval-ms'] ?? 1000);
  if (!(interval > 0)) return usage('--interval-ms must be a positive number');
  const dir = positionals[0];
  const info = path.join(stateDir(dir), 'server-info.json');
  for (;;) {
    const pending = queue.unanswered(dir)[0];
    if (pending) return print(pending, 0);
    if (!fs.existsSync(info)) return print({ stopped: true }, 4);
    await sleep(interval);
  }
}

async function pick(args) {
  if (args.length !== 3) return usage('pick needs <plan-dir> <code> <option>');
  return outcome(await pickOption(args[0], args[1], args[2]));
}

async function undo(args) {
  const { positionals, flags, error } = parseArgs(args, [], ['--with-later']);
  if (error) return usage(error);
  if (positionals.length !== 2) return usage('undo needs <plan-dir> <change-id> [--with-later]');
  return outcome(await undoChange(positionals[0], positionals[1], { withLater: Boolean(flags['--with-later']) }));
}

async function update(args) {
  if (args.length !== 1) return usage('update needs <plan-dir>');
  return outcome(await updateReal(args[0]));
}

async function render(args) {
  const { positionals, flags, error } = parseArgs(args, ['--out']);
  if (error) return usage(error);
  if (positionals.length !== 1 || !flags['--out']) return usage('render needs <plan-dir> --out <file>');
  try {
    fs.writeFileSync(flags['--out'], await renderPlanPage(positionals[0]));
  } catch (e) { return print({ ok: false, error: e.message }, 1); }
  return print({ ok: true, out: flags['--out'] }, 0);
}

const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url));

function readInfo(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir(dir), 'server-info.json'), 'utf8')); }
  catch { return null; }
}

// A pid's command line: /proc where it exists, else ps (macOS). Null when the process is gone.
function commandLine(pid) {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch { /* no /proc entry */ }
  try { return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; }
  catch { return null; }
}

// The recorded server, only if its pid is alive and really is this plan's server.mjs.
function liveServer(dir) {
  const info = readInfo(dir);
  if (!info || !Number.isInteger(info.pid)) return null;
  const cmd = commandLine(info.pid);
  return cmd && cmd.includes('server.mjs') && cmd.includes(fs.realpathSync(dir)) ? info : null;
}

const removeInfo = dir => fs.rmSync(path.join(stateDir(dir), 'server-info.json'), { force: true });
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

async function start(args) {
  if (args.length !== 1) return usage('start needs <plan-dir>');
  let dir;
  try { dir = fs.realpathSync(args[0]); } catch (e) { return print({ ok: false, error: `cannot read plan folder: ${e.message}` }, 1); }
  const running = liveServer(dir);
  if (running) return print({ url: running.url, port: running.port, reused: true }, 0);
  removeInfo(dir); // a stale record would be mistaken for "ready"
  const state = stateDir(dir);
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  const log = fs.openSync(path.join(state, 'server.log'), 'a', 0o600);
  const child = spawn(process.execPath, [SERVER, dir], { detached: true, stdio: ['ignore', log, log], env: process.env });
  fs.closeSync(log);
  let exited = false;
  child.on('exit', () => { exited = true; });
  child.unref();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !exited) {
    const info = readInfo(dir);
    if (info && info.pid === child.pid) return print({ url: info.url, port: info.port, reused: false }, 0);
    await sleep(50);
  }
  if (!exited) child.kill('SIGTERM');
  return print({ ok: false, error: `server did not start, see ${path.join(state, 'server.log')}` }, 1);
}

async function stop(args) {
  if (args.length !== 1) return usage('stop needs <plan-dir>');
  let dir;
  try { dir = fs.realpathSync(args[0]); } catch (e) { return print({ ok: false, error: `cannot read plan folder: ${e.message}` }, 1); }
  const info = liveServer(dir);
  if (!info) { removeInfo(dir); return print({ status: 'not_running' }, 0); }
  process.kill(info.pid, 'SIGTERM');
  const deadline = Date.now() + 5000;
  while (pidAlive(info.pid) && Date.now() < deadline) await sleep(50);
  if (pidAlive(info.pid)) process.kill(info.pid, 'SIGKILL');
  removeInfo(dir);
  return print({ status: 'stopped' }, 0);
}

// name, summary, handler
const COMMANDS = [
  ['diagram', 'render a compact-row diagram spec to JSON: diagram <spec.json>', diagram],
  ['validate', 'validate a plan source: validate <source.json> [--previous <source.json>]', validate],
  ['index', 'print the code index of a plan source as JSON: index <source.json>', index],
  ['init', 'create a plan folder and print its path: init <slug> --title <t> [--date YYYY-MM-DD] [--project <dir>] [--intent <file>]', init],
  ['intent-check', 'report whether the plan\'s intent file changed: intent-check <plan-dir> [--project <dir>]', intentCheck],
  ['apply', 'write a patch to the working copy: apply <plan-dir> <patch.json> --kind author|change --summary <s> [--question <qid>]', apply],
  ['pick', 'settle a decision as a change: pick <plan-dir> <code> <option>', pick],
  ['undo', 'undo a change: undo <plan-dir> <change-id> [--with-later]', undo],
  ['update', 'copy the working copy to plan.json and plan.md: update <plan-dir>', update],
  ['ask', 'queue a page question: ask <plan-dir> comment|change <target> <text>', ask],
  ['next', 'print the oldest unanswered question or null: next <plan-dir>', next],
  ['answer', 'reply to a question: answer <plan-dir> <qid> --text <t> [--suggest-change]', answer],
  ['ack', 'mark a question handled without a reply: ack <plan-dir> <qid>', ack],
  ['resolve', 'resolve a thread: resolve <plan-dir> <thread>', resolveThread],
  ['to-change', 'turn a thread into a change request: to-change <plan-dir> <thread>', toChange],
  ['watch', 'block until a question is pending or the server stops: watch <plan-dir> [--interval-ms <n>]', watch],
  ['start', 'start the live page server and print its URL: start <plan-dir>', start],
  ['stop', 'stop the live page server: stop <plan-dir>', stop],
  ['render', 'write the review page as one HTML file: render <plan-dir> --out <file>', render],
  ['md', 'print the plan as Markdown: md <source.json>', md],
];

function print(obj, code) { process.stdout.write(JSON.stringify(obj) + '\n'); return code; }
function usage(message) { if (message) process.stderr.write(`${message}\n`); help(process.stderr); return 2; }
function help(out = process.stdout) {
  out.write('Usage: planning.mjs <command> [args]\n\nCommands:\n');
  for (const [name, summary] of COMMANDS) out.write(`${name.padEnd(14)}${summary}\n`);
}

const [name, ...rest] = process.argv.slice(2);
if (!name || name === '--help' || name === '-h') { help(); process.exit(name ? 0 : 2); }
const command = COMMANDS.find(([n]) => n === name);
if (!command) process.exit(usage(`unknown command: ${name}`));
// A runtime error (missing folder, lock timeout, a plan that already exists) is one JSON line, not a stack trace.
try { process.exitCode = await command[2](rest); }
catch (e) { process.exitCode = print({ ok: false, error: e.message }, 1); }
