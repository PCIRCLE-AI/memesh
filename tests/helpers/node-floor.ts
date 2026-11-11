// Shared fixtures for the tests of the Node floor (a Node below 22.16).
import fs from 'fs';
import path from 'path';
import { MemeshDatabase } from '../../src/storage/sqlite.js';

/** The part of the refusal every surface must print, exactly once. */
export const OLD_NODE_SENTENCE = 'lacks the full-text search MeMesh needs; upgrade to Node 22.16 or newer';

/** The full refusal MeMesh gives on Node 22.15.1. */
export const TOO_OLD_MESSAGE = `This Node (v22.15.1) ${OLD_NODE_SENTENCE} and run memesh again.`;

/** The error a database open throws on a Node below the floor. */
export function tooOldError(): Error {
  return Object.assign(new Error(TOO_OLD_MESSAGE), { code: 'NODE_TOO_OLD' });
}

/** Writes a `--require` preload that makes a child process report Node 22.15.1; returns its path. */
export function writeOldNodePreload(dir: string): string {
  const preload = path.join(dir, 'fake-old-node.cjs');
  fs.writeFileSync(preload, "Object.defineProperty(process.versions, 'node', { value: '22.15.1', configurable: true });\n");
  return preload;
}

/** Creates an empty MeMesh database at `file`, made on the real Node, in an existing folder. */
export function createEmptyDatabase(file: string): void {
  new MemeshDatabase(file).close();
}
