import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderConversationMessage, type ConversationMessage, type ConversationRegistration } from '../../src/core/conversation-messages.js';
import { wakeConversationMessage } from '../../src/host-adapters/conversation-wake.js';
import { execFile } from 'node:child_process';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
const message: ConversationMessage = {
  id: 'message-id', sender: 'A', sender_host: 'claude-code', sender_machine: os.hostname().toLowerCase(),
  recipient: 'B', recipient_host: 'codex', recipient_machine: os.hostname().toLowerCase(),
  kind: 'task', body: 'HEAD\n全文 ```untrusted```\nTAIL', body_bytes: 34, reply_to: null, sent_at: '2026-11-15T00:00:00.000Z',
};
const target: ConversationRegistration = { id: 'B', host: 'codex', machine: os.hostname().toLowerCase(), pid: process.pid, wake: { thread: 'B' } };
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); vi.useRealTimers(); });

describe('registered conversation wake', () => {
  it('uses only the registered thread and bounded shell-free Codex argv', async () => {
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      (args.at(-1) as (error: Error | null) => void)(null);
      return {} as ReturnType<typeof execFile>;
    });
    expect(await wakeConversationMessage(message, target)).toEqual({ pushed: true, route: 'codex-queue' });
    expect(execFile).toHaveBeenCalledWith('codex', ['queue', '--thread', 'B', '--message', renderConversationMessage(message)],
      expect.objectContaining({ shell: false, timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 16384 }), expect.any(Function));
  });
  it.each(['exit', 'timeout', 'output cap'])('leaves %s failures unpushed', async reason => {
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      (args.at(-1) as (error: Error) => void)(new Error(reason));
      return {} as ReturnType<typeof execFile>;
    });
    expect(await wakeConversationMessage(message, target)).toEqual({ pushed: false, reason: 'failed' });
  });
  it('does no I/O for foreign identity/machine/thread, dead PID, absent route or over-limit wrapper', async () => {
    const connect = vi.spyOn(net, 'createConnection');
    for (const candidate of [undefined, { ...target, id: 'C' }, { ...target, machine: 'elsewhere' },
      { ...target, wake: { thread: 'C' } }, { ...target, pid: 0 }, { ...target, wake: {} }, { ...target, host: 'hermes' as const }]) {
      expect((await wakeConversationMessage(message, candidate)).pushed).toBe(false);
    }
    expect((await wakeConversationMessage({ ...message, body: '密'.repeat(8000) }, target)).pushed).toBe(false);
    expect((await wakeConversationMessage({ ...message, body: null }, target)).pushed).toBe(false);
    expect(execFile).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled();
  });
  it.skipIf(process.platform === 'win32')('rejects unsafe socket modes and links; bounds a socket that never connects', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-'));
    const socketPath = path.join(root, 's');
    const link = path.join(root, 'l');
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    try {
      const socketMessage = { ...message, recipient_host: 'claude-code' };
      const socketTarget = { ...target, host: 'claude-code' as const, wake: { socket: socketPath } };
      const connect = vi.spyOn(net, 'createConnection');
      fs.chmodSync(socketPath, 0o644);
      expect((await wakeConversationMessage(socketMessage, socketTarget)).pushed).toBe(false);
      fs.chmodSync(socketPath, 0o600); fs.symlinkSync(socketPath, link);
      expect((await wakeConversationMessage(socketMessage, { ...socketTarget, wake: { socket: link } })).pushed).toBe(false);
      expect((await wakeConversationMessage(socketMessage, { ...socketTarget, id: 'C' })).pushed).toBe(false);
      expect(connect).not.toHaveBeenCalled();
      const pending = Object.assign(new EventEmitter(), { destroy: vi.fn() });
      connect.mockReturnValue(pending as unknown as net.Socket);
      vi.useFakeTimers();
      const result = wakeConversationMessage(socketMessage, socketTarget);
      await vi.advanceTimersByTimeAsync(2000);
      expect(await result).toEqual({ pushed: false, reason: 'failed' });
      expect(pending.destroy).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
  });
});
