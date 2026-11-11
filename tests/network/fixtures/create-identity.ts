// Run by identity.test.ts as a separate process: one concurrent creator of a key.
import { ensureIdentity } from '../../../src/network/identity.js';

process.stdout.write(`${ensureIdentity(process.argv[2]).machineId}\n`);
