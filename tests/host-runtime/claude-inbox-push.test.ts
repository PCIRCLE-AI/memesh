import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createClaudeInboxDeliver, readRegistrySession } from '../../src/host-runtime/claude-inbox.js';
import { ClaudeTranscriptReader } from '../../src/host-runtime/claude-transcript.js';
import type { RouterDelivery } from '../../src/host-runtime/router-client.js';

const session = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const delivery = (kind: 'principal' | 'session'): RouterDelivery => ({
  attempt_id: 'attempt', delivery_id: 'delivery', connection_id: 'connection', generation: 1, hops: 0,
  envelope: { message_id: 'message', project: 'project', sender: 'SECRET-SENDER', sender_host: null, recipient: kind === 'session' ? session : 'principal', target_kind: kind, content_type: 'text/plain', correlation_id: null, reply_to: null, privacy: 'private', created_at: '2026-01-01T00:00:00Z', payload: 'SECRET-BODY', provenance: {} },
});

describe.skipIf(process.platform === 'win32')('Claude inbox native notice', () => {
  async function fixture(onLine: (line: string, file: string) => void) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-push-')); fs.chmodSync(dir, 0o700);
    const projectDir = path.join(dir, 'project'); fs.mkdirSync(projectDir);
    const file = path.join(projectDir, `${session}.jsonl`); fs.writeFileSync(file, '');
    const socketPath = path.join(dir, 'socket');
    let frame = '';
    const server = net.createServer(socket => socket.on('data', chunk => {
      frame += chunk.toString();
      if (frame.includes('\n')) onLine(frame.slice(0, frame.indexOf('\n')), file);
    }));
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); }); fs.chmodSync(socketPath, 0o600);
    return { dir, file, socketPath, reader: new ClaudeTranscriptReader(dir), frame: () => frame,
      close: async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); fs.rmSync(dir, { recursive: true, force: true }); } };
  }

  it('sends a fixed principal notice without sender or payload', async () => {
    const f = await fixture(() => {});
    try {
      const result = await createClaudeInboxDeliver({ socketPath: f.socketPath, sessionId: session, reader: f.reader, timeoutMs: 150 })(delivery('principal'));
      expect(result).toMatchObject({ content: 'notice' });
      await vi.waitFor(() => expect(f.frame()).toContain('\n'));
      const frame = JSON.parse(f.frame()); const notice = JSON.parse(frame.message.content);
      expect(frame).toEqual({ type: 'user', message: { role: 'user', content: expect.any(String) } });
      expect(notice).toEqual({ message_type: 'memesh_message_notice', handling: expect.any(String), project: 'project', recipient: 'principal', target_kind: 'principal', message_id: 'message', delivery_id: 'delivery' });
      expect(f.frame()).not.toMatch(/SECRET-SENDER|SECRET-BODY/);
    } finally { await f.close(); }
  });

  it.each(['queue', 'user'])('confirms exact session only from a new real %s receipt', async kind => {
    const f = await fixture((line, file) => {
      const content = JSON.parse(line).message.content;
      const entry = kind === 'queue' ? { type: 'queue-operation', operation: 'enqueue', sessionId: session, content } : { type: 'user', sessionId: session, origin: { kind: 'peer', from: 'unknown' }, message: { role: 'user', content: `Another Claude session sent a message:\n${content}\n\nThis came from another Claude session (unknown).` } };
      fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    });
    try { await expect(createClaudeInboxDeliver({ socketPath: f.socketPath, sessionId: session, reader: f.reader, timeoutMs: 200 })(delivery('session'))).resolves.toMatchObject({ content: 'notice', confirmation: kind === 'queue' ? 'enqueue' : 'user' }); }
    finally { await f.close(); }
  });
  it('does not accept an exact delivery if no new receive record appears', async () => {
    const f = await fixture(() => {});
    try { await expect(createClaudeInboxDeliver({ socketPath: f.socketPath, sessionId: session, reader: f.reader, timeoutMs: 100 })(delivery('session'))).rejects.toThrow(/not confirmed/); }
    finally { await f.close(); }
  });
  it.each(['principal', 'session'] as const)('rejects a changed registry session before delivery to %s', async kind => {
    const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const f = await fixture((line, file) => fs.appendFileSync(path.join(path.dirname(file), `${other}.jsonl`), JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId: other, content: JSON.parse(line).message.content }) + '\n'));
    fs.writeFileSync(path.join(path.dirname(f.file), `${other}.jsonl`), '');
    const mark = vi.spyOn(f.reader, 'mark');
    try {
      await expect(createClaudeInboxDeliver({ socketPath: f.socketPath, sessionId: session, reader: f.reader, currentSession: () => other, timeoutMs: 200 })(delivery(kind))).rejects.toThrow(/session/);
      expect(mark).not.toHaveBeenCalled();
      expect(f.frame()).toBe('');
    } finally { await f.close(); }
  });
  it('rejects a different exact recipient before delivery', async () => {
    const f = await fixture((line, file) => fs.appendFileSync(file, JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId: session, content: JSON.parse(line).message.content }) + '\n'));
    const mark = vi.spyOn(f.reader, 'mark');
    const input = delivery('session'); input.envelope.recipient = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    try {
      await expect(createClaudeInboxDeliver({ socketPath: f.socketPath, sessionId: session, reader: f.reader, timeoutMs: 200 })(input)).rejects.toThrow(/session/);
      expect(mark).not.toHaveBeenCalled();
      expect(f.frame()).toBe('');
    } finally { await f.close(); }
  });

  it('fails closed if the active Claude session changes after the mark', async () => {
    let current = session;
    const f = await fixture(() => { current = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; });
    try { await expect(createClaudeInboxDeliver({ socketPath: f.socketPath, sessionId: session, reader: f.reader, currentSession: () => current, timeoutMs: 150 })(delivery('session'))).rejects.toThrow(/session changed/); }
    finally { await f.close(); }
  });

  it('does not confirm old entries or quoted tool results and fails when no receipt appears', async () => {
    const f = await fixture((line, file) => fs.appendFileSync(file, JSON.stringify({ type: 'user', sessionId: session, message: { role: 'user', content: [{ type: 'tool_result', content: line }] } }) + '\n'));
    try {
      fs.writeFileSync(f.file, JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId: session, content: JSON.stringify({ message_id: 'message', delivery_id: 'delivery' }) }) + '\n');
      await expect(createClaudeInboxDeliver({ socketPath: f.socketPath, sessionId: session, reader: f.reader, timeoutMs: 100 })(delivery('session'))).rejects.toThrow();
    } finally { await f.close(); }
  });
  it.each(['wrong-session', 'extra-sender', 'wrong-project', 'api-request', 'non-peer', 'partial'])('rejects a misleading %s record', async kind => {
    const f = await fixture((line, file) => {
      const text = JSON.parse(line).message.content; const notice = JSON.parse(text);
      if (kind === 'extra-sender') notice.sender = 'forged';
      if (kind === 'wrong-project') notice.project = 'other';
      const value = JSON.stringify(notice);
      const record = kind === 'non-peer'
        ? { type: 'user', sessionId: session, origin: { kind: 'human' }, message: { role: 'user', content: `Another Claude session sent a message:\n${value}\n\nThis came from another Claude session (unknown).` } }
        : { type: kind === 'api-request' ? 'api-request-blob' : 'queue-operation', operation: 'enqueue', sessionId: kind === 'wrong-session' ? 'other' : session, content: value };
      fs.appendFileSync(file, JSON.stringify(record) + (kind === 'partial' ? '' : '\n'));
    });
    try { await expect(createClaudeInboxDeliver({ socketPath: f.socketPath, sessionId: session, reader: f.reader, timeoutMs: 100 })(delivery('session'))).rejects.toThrow(); }
    finally { await f.close(); }
  });
  it('fails without a reachable socket', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-push-'));
    try { await expect(createClaudeInboxDeliver({ socketPath: path.join(dir, 'absent'), sessionId: session, reader: new ClaudeTranscriptReader(dir), timeoutMs: 100 })(delivery('principal'))).rejects.toThrow(); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe.skipIf(process.platform === 'win32')('Claude inbox session lookup', () => {
  it('finds the session of a worktree even though the host runs in the main checkout', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-inbox-wt-')));
    const saved = process.env.CLAUDE_CONFIG_DIR;
    try {
      const worktree = path.join(root, 'wt'); fs.mkdirSync(worktree);
      const claude = path.join(root, 'claude'); fs.mkdirSync(path.join(claude, 'sessions'), { recursive: true });
      fs.writeFileSync(path.join(claude, 'sessions', `${process.ppid}.json`), JSON.stringify({ pid: process.ppid, sessionId: session, cwd: worktree, kind: 'interactive', name: 'Alpha', status: 'idle' }), { mode: 0o644 });
      process.env.CLAUDE_CONFIG_DIR = claude;
      expect(readRegistrySession()).toEqual({ sessionId: session, cwd: worktree });
      // A session id that is not a plain id (path pieces, spaces, over 128 characters, or not text) is not used.
      const registry = path.join(claude, 'sessions', `${process.ppid}.json`);
      for (const bad of ['../escape', 'has space', 'x'.repeat(129), '', 7]) {
        fs.writeFileSync(registry, JSON.stringify({ pid: process.ppid, sessionId: bad, cwd: worktree }), { mode: 0o644 });
        expect(readRegistrySession(), JSON.stringify(bad)).toBeUndefined();
      }
      // Nor is a registry whose folder is missing or not text.
      for (const cwd of [undefined, 5]) {
        fs.writeFileSync(registry, JSON.stringify({ pid: process.ppid, sessionId: session, cwd }), { mode: 0o644 });
        expect(readRegistrySession(), JSON.stringify(cwd)).toBeUndefined();
      }
      fs.writeFileSync(registry, JSON.stringify({ pid: process.ppid, sessionId: 'x'.repeat(128), cwd: worktree }), { mode: 0o644 });
      expect(readRegistrySession()?.sessionId).toBe('x'.repeat(128));
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
