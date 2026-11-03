// Run by invites.test.ts as several processes at once, against one database: each
// tries each invite in the same millisecond slot, so every invite is really fought
// over. Prints how many it won.
import fs from 'node:fs';
import { consumeInvite } from '../../../src/network/invites.js';
import { openNetworkStore } from '../../../src/network/store.js';

const [dbPath, hashesFile, startAt, slotMs] = process.argv.slice(2);
const db = openNetworkStore(dbPath);
const hashes = JSON.parse(fs.readFileSync(hashesFile, 'utf8')) as string[];
let wins = 0;
for (const [index, hash] of hashes.entries()) {
  const slot = Number(startAt) + index * Number(slotMs);
  while (Date.now() < slot) { /* every process attempts this invite together */ }
  try {
    consumeInvite(db, hash, Date.now());
    wins++;
  } catch (err) {
    if ((err as { code?: string }).code !== 'invite_used') throw err;
  }
}
db.close();
process.stdout.write(`${wins}\n`);
