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
