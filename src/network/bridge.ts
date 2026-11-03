// dist/network/bridge.js: the only process that loads the native transport.
//
//   bridge.js check               load the native file once and report (used after install)
//   bridge.js join                one join as a client; input on stdin, a JSON result on stdout
//   bridge.js serve <data dir>    the long-running bridge; the data dir on its command line
//                                 is how `down` knows this process belongs to that folder

import path from 'node:path';
import { getDbPath, getMemeshDirFromDbPath } from '../core/paths.js';
import { JOIN_CHILD_INPUT_MAX_BYTES, runJoinClient, type JoinChildInput } from './bridge-join.js';
import { serve } from './bridge-serve.js';
import { recordStartupFailure } from './bridge-startup-failure.js';
import { explainLoadFailure, loadNative } from './native-loader.js';
import { errorMessage, runtimeDir } from './types.js';

function reply(result: unknown): Promise<void> {
  return new Promise((resolve) => { process.stdout.write(`${JSON.stringify(result)}\n`, () => resolve()); });
}

function check(dataDir: string): { ok: boolean; reason?: string } {
  try {
    // Constructing a builder calls into the native file without opening a socket.
    loadNative(runtimeDir(dataDir)).Endpoint.builder();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: explainLoadFailure(err) };
  }
}

async function readBoundedStdin(limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) throw new Error('input too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const mode = process.argv[2];
const dataDir = path.resolve(getMemeshDirFromDbPath());

if (mode === 'check') {
  const result = check(dataDir);
  await reply(result);
  process.exit(result.ok ? 0 : 1);
} else if (mode === 'join') {
  try {
    const input = JSON.parse(await readBoundedStdin(JOIN_CHILD_INPUT_MAX_BYTES)) as JoinChildInput;
    await reply(await runJoinClient(dataDir, input));
    process.exit(0);
  } catch (err) {
    // Runs with the token in memory: report the failure's message, never the input.
    await reply({ ok: false, code: 'internal', detail: errorMessage(err), relay_reached: null });
    process.exit(1);
  }
} else if (mode === 'serve' && process.argv[3] === dataDir) {
  try {
    process.exit(await serve(dataDir, getDbPath()));
  } catch (err) {
    recordStartupFailure(dataDir, errorMessage(err));
    process.exit(1);
  }
} else {
  process.stderr.write('Usage: bridge.js check | join | serve <data dir>\n');
  process.exit(2);
}
