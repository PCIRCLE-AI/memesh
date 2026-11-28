import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { vi } from 'vitest';
import { parseTraceLine, traceScript } from '../../scripts/diagnose-windows-messages-entry.mjs';

export function withWindowsPermissionTrace<T>(makeDirectory: () => string, action: () => T): T {
  let traceFile: string | undefined;
  let exec: ReturnType<typeof vi.spyOn> | undefined;
  const inherited = process.env.MEMESH_WINDOWS_MESSAGES_PHASE_FILE;
  try {
    traceFile = path.join(makeDirectory(), '.windows-acl-trace');
    fs.writeFileSync(traceFile, '', { mode: 0o600, flag: 'wx' });
    process.env.MEMESH_WINDOWS_MESSAGES_PHASE_FILE = traceFile;
    const original = childProcess.execFileSync;
    exec = vi.spyOn(childProcess, 'execFileSync').mockImplementation(((command, args, options) => {
      const argv = Array.isArray(args) ? args : [];
      const index = argv.indexOf('-EncodedCommand');
      let traced: string | null = null;
      try { traced = index >= 0 ? traceScript(String(argv[index + 1])) : null; } catch {}
      return original(command, traced ? [...argv.slice(0, index + 1), traced, ...argv.slice(index + 2)] : argv, options);
    }) as typeof childProcess.execFileSync);
  } catch { /* observation setup must leave an already-created trace cleanable */ }
  try {
    return action();
  } catch (error) {
    try {
      if (traceFile) {
        const events = fs.readFileSync(traceFile, 'utf8').split(/\r?\n/).map(parseTraceLine).filter(Boolean).slice(-40);
        process.stderr.write(`MEMESH_WINDOWS_ACL_TRACE ${JSON.stringify(events)}\n`);
      }
    } catch { /* observation cannot replace the original failure */ }
    throw error;
  } finally {
    try { exec?.mockRestore(); } catch {}
    try { if (traceFile) fs.rmSync(traceFile, { force: true }); } catch {}
    if (inherited === undefined) delete process.env.MEMESH_WINDOWS_MESSAGES_PHASE_FILE;
    else process.env.MEMESH_WINDOWS_MESSAGES_PHASE_FILE = inherited;
  }
}
