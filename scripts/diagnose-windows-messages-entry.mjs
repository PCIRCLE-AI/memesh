// Diagnostic preload for the Windows entry-point gate. It changes no hook result.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';

const self = import.meta.url;
const here = path.dirname(fileURLToPath(self));
const gate = path.join(here, 'check-entry-points-start.mjs');
const messages = path.join(here, 'hooks', 'messages.js');
const childFlag = 'MEMESH_WINDOWS_MESSAGES_ENTRY_DIAG';
const prefix = 'MEMESH_WINDOWS_MESSAGES_PHASE ';
const phases = new Set(['stdin-read-begin', 'stdin-read-end', 'stdin-read-error', 'powershell-begin', 'powershell-end', 'powershell-error', 'register-begin', 'register-end', 'register-error', 'hook-batch-begin', 'hook-batch-end', 'hook-batch-error', 'close-begin', 'close-end', 'close-error']);
const same = (value, expected) => typeof value === 'string' && path.resolve(value) === expected;
const emit = (phase, started) => process.stderr.write(`${prefix}${JSON.stringify({ phase, elapsedMs: Date.now() - started })}\n`);

if (process.env[childFlag] === 'child' && same(process.argv[1], messages)) {
  const started = Date.now();
  const read = fs.readFileSync;
  fs.readFileSync = function tracedRead(file, ...args) {
    if (file !== 0) return read.call(this, file, ...args);
    emit('stdin-read-begin', started);
    try { const result = read.call(this, file, ...args); emit('stdin-read-end', started); return result; }
    catch (error) { emit('stdin-read-error', started); throw error; }
  };
  const exec = childProcess.execFileSync;
  childProcess.execFileSync = function tracedExec(command, ...args) {
    if (path.win32.basename(String(command)).toLowerCase() !== 'powershell.exe') return exec.call(this, command, ...args);
    emit('powershell-begin', started);
    try { const result = exec.call(this, command, ...args); emit('powershell-end', started); return result; }
    catch (error) { emit('powershell-error', started); throw error; }
  };
  syncBuiltinESMExports();
  const { ConversationMessages } = await import(new URL('./hooks/_generated/conversation-messages.js', import.meta.url));
  for (const [method, label] of [['register', 'register'], ['hookBatch', 'hook-batch'], ['close', 'close']]) {
    const original = ConversationMessages.prototype[method];
    ConversationMessages.prototype[method] = function tracedMethod(...args) {
      emit(`${label}-begin`, started);
      try { const result = original.apply(this, args); emit(`${label}-end`, started); return result; }
      catch (error) { emit(`${label}-error`, started); throw error; }
    };
  }
} else if (same(process.argv[1], gate)) {
  const spawn = childProcess.spawn;
  childProcess.spawn = function tracedSpawn(command, args, options) {
    if (command !== process.execPath || !Array.isArray(args) || !same(args[0], messages)) return spawn.call(this, command, args, options);
    const env = { ...(options?.env ?? process.env), [childFlag]: 'child', NODE_OPTIONS: `${options?.env?.NODE_OPTIONS ?? process.env.NODE_OPTIONS ?? ''} --import=${self}`.trim() };
    const child = spawn.call(this, command, args, { ...options, env });
    let pending = '';
    const forward = (line) => {
      if (!line.startsWith(prefix)) return;
      try {
        const value = JSON.parse(line.slice(prefix.length));
        if (Object.keys(value).every(key => key === 'phase' || key === 'elapsedMs') && phases.has(value.phase) && Number.isInteger(value.elapsedMs) && value.elapsedMs >= 0) process.stderr.write(`${prefix}${JSON.stringify(value)}\n`);
      } catch { /* diagnostic data is untrusted child stderr */ }
    };
    child.stderr?.on('data', chunk => { pending += chunk; let newline; while ((newline = pending.indexOf('\n')) >= 0) { forward(pending.slice(0, newline)); pending = pending.slice(newline + 1); } });
    child.stderr?.once('end', () => forward(pending));
    return child;
  };
  syncBuiltinESMExports();
}
