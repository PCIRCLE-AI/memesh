// Run by bridge-state.test.ts under the name bridge.js, with `serve <data dir>`, so
// this process really looks like a bridge. Its lock names its own pid, as a lock
// left by an earlier life of the same pid would.
import fs from 'node:fs';
import { acquireLock, lockPath } from '../../../src/network/bridge-state.js';

const dataDir = process.argv[3];
fs.writeFileSync(lockPath(dataDir), `${process.pid}\n`);
process.stdout.write(`${await acquireLock(dataDir)}\n`);
