// The page's questions: an append-only log, the threads they belong to, and which ones are handled.
// Every write takes the lock; ids are derived under it so two quick asks never share one.
import fs from 'node:fs';
import { planPaths, readJson, withLock, writeJsonAtomic } from './store.mjs';

const now = () => new Date().toISOString();

// Parsed non-empty lines of a jsonl file; `lines` counts malformed ones too, `rows` skips them.
function readJsonl(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim());
  const rows = [];
  for (const line of lines) {
    try { rows.push(JSON.parse(line)); } catch { /* a torn or hand-edited line is skipped */ }
  }
  return { lines: lines.length, rows };
}

const appendLine = (file, record) => fs.appendFileSync(file, JSON.stringify(record) + '\n');

function newQuestion(dir, fields) {
  const p = planPaths(dir);
  const question = { id: `q${readJsonl(p.questions).lines + 1}`, at: now(), ...fields };
  appendLine(p.questions, question);
  return question;
}

function addMessage(thread, by, text, question, suggestChange = false) {
  thread.messages.push({ by, at: now(), text, question, suggestChange });
}

function findThread(book, id) {
  const thread = book.threads.find(t => t.id === id);
  if (!thread) throw new Error(`unknown thread: ${id}`);
  return thread;
}

export function ask(dir, { kind, target, text }) {
  if (kind !== 'comment' && kind !== 'change') throw new Error(`ask kind must be comment or change, got ${kind}`);
  return withLock(dir, async () => {
    const p = planPaths(dir);
    const book = readJson(p.threads);
    let thread = kind === 'comment'
      ? book.threads.find(t => t.target === target && t.kind === 'comment' && t.state === 'open')
      : null;
    if (!thread) {
      thread = { id: `t${book.next}`, target, kind, state: 'open', messages: [] };
      book.next += 1;
      book.threads.push(thread);
    }
    const question = newQuestion(dir, { kind, target, text, thread: thread.id });
    addMessage(thread, 'user', text, question.id);
    writeJsonAtomic(p.threads, book);
    return { question, thread };
  });
}

// Something the page did that the session must know about, acked like any question: a pick, an undo
// or an update of the real plan (R61; the CLI queues none of these, the session made them itself).
export function queueNotice(dir, fields) {
  return withLock(dir, async () => newQuestion(dir, fields));
}

export const queuePick = (dir, { target, option, change }) => queueNotice(dir, { kind: 'pick', target, option, change });

export function toChange(dir, threadId) {
  return withLock(dir, async () => {
    const p = planPaths(dir);
    const book = readJson(p.threads);
    const thread = findThread(book, threadId);
    const last = [...thread.messages].reverse().find(m => m.by === 'user');
    if (!last) throw new Error(`thread ${threadId} has no user message`);
    thread.kind = 'change';
    const question = newQuestion(dir, { kind: 'change', target: thread.target, text: last.text, thread: thread.id });
    writeJsonAtomic(p.threads, book);
    return question;
  });
}

export function resolve(dir, threadId) {
  return withLock(dir, async () => {
    const p = planPaths(dir);
    const book = readJson(p.threads);
    findThread(book, threadId).state = 'resolved';
    writeJsonAtomic(p.threads, book);
  });
}

export function unanswered(dir) {
  const p = planPaths(dir);
  const done = new Set(readJsonl(p.handled).rows.map(h => h.question));
  return readJsonl(p.questions).rows.filter(q => !done.has(q.id));
}

// Close a question: record how, and when the reply has text, add it to the question's thread.
function handle(dir, qid, how, reply, suggestChange) {
  return withLock(dir, async () => {
    const p = planPaths(dir);
    const question = readJsonl(p.questions).rows.find(q => q.id === qid);
    if (!question) throw new Error(`unknown question: ${qid}`);
    if (readJsonl(p.handled).rows.some(h => h.question === qid)) throw new Error(`question already handled: ${qid}`);
    if (reply !== undefined && question.thread) {
      const book = readJson(p.threads);
      addMessage(findThread(book, question.thread), 'claude', reply, qid, suggestChange);
      writeJsonAtomic(p.threads, book);
    }
    appendLine(p.handled, { question: qid, at: now(), how });
  });
}

export const answer = (dir, qid, text, { suggestChange = false } = {}) => handle(dir, qid, 'answer', text, suggestChange);
export const ack = (dir, qid) => handle(dir, qid, 'ack');
export const markApplied = (dir, qid, changeId) =>
  handle(dir, qid, 'apply', changeId ? `Applied as ${changeId}.` : 'Nothing to change.');
