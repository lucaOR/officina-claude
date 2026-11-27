import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// Describe an intent file: its path (relative to the project when inside it, else absolute) and content hash.
export function describeIntent(projectDir, file) {
  const abs = path.resolve(file);
  let bytes;
  try { bytes = fs.readFileSync(abs); }
  catch (e) { throw new Error(`cannot read intent: ${e.message}`); }
  const rel = path.relative(path.resolve(projectDir), abs);
  const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  return { path: inside ? rel : abs, sha256: sha256(bytes) };
}

// Compare a recorded intent ({path, sha256}) with the file as it is now.
export function checkIntent(projectDir, recorded) {
  const abs = path.resolve(projectDir, recorded.path);
  let current = null;
  try { current = sha256(fs.readFileSync(abs)); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  return {
    path: recorded.path, sha256: recorded.sha256, current,
    changed: current !== recorded.sha256, missing: current === null,
  };
}
