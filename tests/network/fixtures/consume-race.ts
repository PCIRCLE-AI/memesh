// Run by invites.test.ts as several processes at once, against one database: each
// initializes before the shared start and tries every invite in the same time
// slots. Prints how many it won; scheduling need not distribute the winners.
import fs from 'node:fs';
import { consumeInvite } from '../../../src/network/invites.js';
import { openNetworkStore } from '../../../src/network/store.js';

const [dbPath, hashesFile, slotMs] = process.argv.slice(2);
const db = openNetworkStore(dbPath);
const hashes = JSON.parse(fs.readFileSync(hashesFile, 'utf8')) as string[];
const start = new Promise<number>((resolve) => {
  process.once('message', (message: { startAt: number }) => resolve(message.startAt));
});
process.send!({ type: 'ready', invites: hashes.length });
const startAt = await start;
let wins = 0;
let attempts = 0;
try {
  for (const [index, hash] of hashes.entries()) {
    const slot = startAt + index * Number(slotMs);
    while (Date.now() < slot) { /* wait for this invite's shared slot */ }
    attempts++;
    try {
      consumeInvite(db, hash, Date.now());
      wins++;
    } catch (err) {
      if ((err as { code?: string }).code !== 'invite_used') throw err;
    }
  }
} finally {
  db.close();
}
process.stdout.write(`${wins}\n`);
process.send!({ type: 'done', attempts }, (err) => {
  if (err) throw err;
  process.disconnect!();
});
