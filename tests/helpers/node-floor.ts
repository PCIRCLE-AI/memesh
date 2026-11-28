// Shared fixtures for the tests of the Node floor (a Node below 22.16).
import fs from 'fs';
import path from 'path';
import { closeDatabase, openDatabase } from '../../src/db.js';
import { nodeProblem, UnsupportedNodeError } from '../../src/storage/sqlite.js';

/** The part of the refusal every surface must print, exactly once. */
export const OLD_NODE_SENTENCE = 'lacks the full-text search MeMesh needs; upgrade to Node 22.16 or newer';

/** The Node the preload below pretends to be. */
export const OLD_NODE_VERSION = '22.15.1';

/** What MeMesh says on that Node: one sentence, and the repair. */
export const TOO_OLD_PROBLEM = nodeProblem(OLD_NODE_VERSION, () => true)!;

/** The full refusal MeMesh gives on Node 22.15.1. */
export const TOO_OLD_MESSAGE = TOO_OLD_PROBLEM.message;

/** The error a database open throws on a Node below the floor. */
export function tooOldError(): UnsupportedNodeError {
  return new UnsupportedNodeError(TOO_OLD_PROBLEM);
}

/** Writes a `--require` preload that makes a child process report `version`; returns its path. */
export function writeOldNodePreload(dir: string, version: string = OLD_NODE_VERSION): string {
  const preload = path.join(dir, `fake-node-${version}.cjs`);
  fs.writeFileSync(preload, `Object.defineProperty(process.versions, 'node', { value: '${version}', configurable: true });\n`);
  return preload;
}

/** Creates a real MeMesh database (schema and all) at `file`, on the real Node, in an existing folder. */
export function createDatabase(file: string): void {
  openDatabase(file);
  closeDatabase();
}
