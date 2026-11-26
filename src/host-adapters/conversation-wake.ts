import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { MESSAGE_MAX_BYTES, renderConversationMessage, type ConversationMessage, type ConversationRegistration } from '../core/conversation-messages.js';

const TIMEOUT_MS = 2_000;
const MAX_OUTPUT_BYTES = 16 * 1024;
export type ConversationWakeRoute = 'claude-socket' | 'codex-queue';
export type ConversationWakeResult =
  | { pushed: true; route: ConversationWakeRoute }
  | { pushed: false; reason: 'unavailable' | 'failed' };

function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) {
    // Signal zero can report an existing process that this host cannot signal.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function privateSocket(socketPath: string): fs.Stats {
  if (!path.isAbsolute(socketPath) || process.platform === 'win32') throw new Error('Socket unavailable');
  const stat = fs.lstatSync(socketPath);
  if (!stat.isSocket() || (stat.mode & 0o077) !== 0 || typeof process.getuid !== 'function'
    || stat.uid !== process.getuid()) throw new Error('Socket unavailable');
  return stat;
}

/** Only registered host metadata reaches this boundary; no model-supplied routes or commands. */
export async function wakeConversationMessage(message: ConversationMessage, target: ConversationRegistration | undefined, localMachine = os.hostname().toLowerCase()): Promise<ConversationWakeResult> {
  if (!target || target.id !== message.recipient || target.host !== message.recipient_host
    || target.machine !== message.recipient_machine || target.machine !== localMachine
    || !alive(target.pid) || message.body === null) return { pushed: false, reason: 'unavailable' };
  const content = renderConversationMessage(message);
  if (Buffer.byteLength(content, 'utf8') > MESSAGE_MAX_BYTES) return { pushed: false, reason: 'unavailable' };
  try {
    if (target.host === 'claude-code' && typeof target.wake.socket === 'string') {
      const socketPath = target.wake.socket;
      const before = privateSocket(socketPath);
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection(socketPath);
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true; clearTimeout(timer); socket.destroy();
          if (error) reject(error); else resolve();
        };
        const timer = setTimeout(() => finish(new Error('Socket timeout')), TIMEOUT_MS);
        socket.once('error', () => finish(new Error('Socket failed')));
        socket.once('close', () => finish(new Error('Socket closed before write')));
        socket.once('connect', () => {
          try {
            const after = privateSocket(socketPath);
            if (before.dev !== after.dev || before.ino !== after.ino || !alive(target.pid)) throw new Error('Host changed');
            socket.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`, () => finish());
          } catch { finish(new Error('Socket identity changed')); }
        });
      });
      return { pushed: true, route: 'claude-socket' };
    }
    if (target.host === 'codex' && target.wake.thread === target.id) {
      await new Promise<void>((resolve, reject) => {
        execFile('codex', ['queue', '--thread', target.id, '--message', content], {
          shell: false, windowsHide: true, timeout: TIMEOUT_MS, killSignal: 'SIGKILL',
          maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8',
        }, error => { if (error) reject(new Error('Queue failed')); else resolve(); });
      });
      return { pushed: true, route: 'codex-queue' };
    }
    return { pushed: false, reason: 'unavailable' };
  } catch { return { pushed: false, reason: 'failed' }; }
}
