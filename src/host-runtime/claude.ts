#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { runHostEntry } from './entry.js';
import { startConversationChannel } from './conversation-channel.js';

async function main(): Promise<void> {
  await startConversationChannel({
    onError() {
      process.stderr.write('memesh-host-claude: conversation Channel failed; messages remain pending.\n');
      process.exitCode = 1;
    },
  });
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;
  try {
    return realpathSync(entrypoint) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exitCode = await runHostEntry('memesh-host-claude', main);
}
