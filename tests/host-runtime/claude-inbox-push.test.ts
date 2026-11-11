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

const frames = (all: string) => all.split('\n').filter(Boolean).length;

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
    const f = await fixture((line, file) => fs.appendFileSync(file, JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId: session, content: JSON.parse(line).message.content }) + '\n'));
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
  it.each(['principal', 'session'] as const)('does not report a %s notice as delivered when it never reaches the conversation', async kind => {
    const f = await fixture(() => {});
    try {
      await expect(createClaudeInboxDeliver({ socketPath: f.socketPath, sessionId: session, reader: f.reader, timeoutMs: 100 })(delivery(kind))).rejects.toMatchObject({ code: 'notice_not_confirmed', message: expect.stringMatching(/not confirmed/) });
    } finally { await f.close(); }
  });
  const heldRecord = (sessionId: string, content = 'Held peer message — from an unidentified session; preview: «message_type:memesh_message_notice,handling:A MeMesh message is waiting for you;» — not delivered to Claude (1 held).') =>
    JSON.stringify({ type: 'system', subtype: 'informational', level: 'warning', sessionId, content }) + '\n';

  it.each(['principal', 'session'] as const)('tells a %s notice Claude Code is holding for its user apart from one that is merely not seen, without waiting out the time limit', async kind => {
    const f = await fixture((_line, file) => fs.appendFileSync(file, heldRecord(session)));
    try {
      const started = Date.now();
      await expect(createClaudeInboxDeliver({ socketPath: f.socketPath, sessionId: session, reader: f.reader, timeoutMs: 3000 })(delivery(kind))).rejects.toMatchObject({ code: 'notice_held', message: expect.stringMatching(/holding.*approved or denied/i) });
      expect(Date.now() - started).toBeLessThan(2000);
    } finally { await f.close(); }
  });
  it.each([
    ['another session', (_s: string) => heldRecord('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')],
    ['a peer message that is not a MeMesh notice', (s: string) => heldRecord(s, 'Held peer message — from an unidentified session; preview: «hello»')],
    ['a system record that is not a hold', (s: string) => heldRecord(s, 'Compacted conversation (memesh_message_notice)')],
  ])('does not take a hold record of %s for this notice', async (_name, make) => {
    const f = await fixture((_line, file) => fs.appendFileSync(file, make(session)));
    try { await expect(createClaudeInboxDeliver({ socketPath: f.socketPath, sessionId: session, reader: f.reader, timeoutMs: 150 })(delivery('principal'))).rejects.toMatchObject({ code: 'notice_not_confirmed' }); }
    finally { await f.close(); }
  });
  it('takes a notice as delivered when it was held and then released within the same look, instead of calling it held', async () => {
    const f = await fixture((line, file) => {
      const content = JSON.parse(line).message.content;
      fs.appendFileSync(file, heldRecord(session) + JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId: session, content }) + '\n');
    });
    try {
      await expect(createClaudeInboxDeliver({ socketPath: f.socketPath, sessionId: session, reader: f.reader, timeoutMs: 1000 })(delivery('principal'))).resolves.toMatchObject({ confirmation: 'enqueue' });
    } finally { await f.close(); }
  });

  it('reads on from where it left off when a notice it called held is handed over again, and takes it as delivered once Claude Code released it', async () => {
    const f = await fixture((_line, file) => fs.appendFileSync(file, heldRecord(session)));
    try {
      const deliver = createClaudeInboxDeliver({ socketPath: f.socketPath, sessionId: session, reader: f.reader, timeoutMs: 1000 });
      await expect(deliver(delivery('principal'))).rejects.toMatchObject({ code: 'notice_held' });
      const sent = f.frame();
      const notice = JSON.parse(JSON.parse(sent).message.content);
      fs.appendFileSync(f.file, JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId: session, content: JSON.stringify(notice) }) + '\n');
      await expect(deliver(delivery('principal'))).resolves.toMatchObject({ confirmation: 'enqueue' });
      expect(f.frame()).toBe(sent);
      // Released and taken as delivered: the hold is forgotten, so a third hand-over sends a new notice.
      await expect(deliver(delivery('principal')), 'a third try, no longer held').rejects.toMatchObject({ code: 'notice_held' });
      expect(frames(f.frame()), 'the third try sent its own notice').toBe(2);
    } finally { await f.close(); }
  });

  it('remembers only the most recent held notices; one forgotten stays held and is not sent again, in any later round', async () => {
    const f = await fixture((_line, file) => fs.appendFileSync(file, heldRecord(session)));
    try {
      const deliver = createClaudeInboxDeliver({ socketPath: f.socketPath, sessionId: session, reader: f.reader, timeoutMs: 1000, heldLimit: 2 });
      const withId = (id: string) => ({ ...delivery('principal'), delivery_id: id });
      await expect(deliver(withId('d1'))).rejects.toMatchObject({ code: 'notice_held' });
      await expect(deliver(withId('d2'))).rejects.toMatchObject({ code: 'notice_held' });
      // The limit is exceeded only by a third hold: the first two are both still remembered.
      await expect(deliver(withId('d1'))).rejects.toMatchObject({ code: 'notice_held' });
      await expect(deliver(withId('d2'))).rejects.toMatchObject({ code: 'notice_held' });
      expect(frames(f.frame()), 'a remembered hold is not sent again').toBe(2);
      await expect(deliver(withId('d3'))).rejects.toMatchObject({ code: 'notice_held' });
      expect(frames(f.frame())).toBe(3);
      // d1 was forgotten to stay inside the limit: still reported as held, and never sent again, round after round.
      for (let round = 0; round < 3; round += 1) {
        for (const id of ['d1', 'd2', 'd3']) await expect(deliver(withId(id))).rejects.toMatchObject({ code: 'notice_held' });
      }
      expect(frames(f.frame()), 'no round sends anything again').toBe(3);
    } finally { await f.close(); }
  });

  it('keeps following every hold up to the limit: with a limit of two, both of two held notices can still be confirmed once released', async () => {
    const f = await fixture((_line, file) => fs.appendFileSync(file, heldRecord(session)));
    try {
      const deliver = createClaudeInboxDeliver({ socketPath: f.socketPath, sessionId: session, reader: f.reader, timeoutMs: 1000, heldLimit: 2 });
      const withId = (id: string) => ({ ...delivery('principal'), delivery_id: id });
      await expect(deliver(withId('d1'))).rejects.toMatchObject({ code: 'notice_held' });
      await expect(deliver(withId('d2'))).rejects.toMatchObject({ code: 'notice_held' });
      const noticeOf = (id: string) => f.frame().split('\n').filter(Boolean).map((line) => JSON.parse(JSON.parse(line).message.content)).find((notice) => notice.delivery_id === id);
      fs.appendFileSync(f.file, JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId: session, content: JSON.stringify(noticeOf('d1')) }) + '\n');
      await expect(deliver(withId('d1'))).resolves.toMatchObject({ confirmation: 'enqueue' });
    } finally { await f.close(); }
  });

  it('remembers 500 held notices by default: the 501st forgets the first, which can then no longer be confirmed, while the second still can', async () => {
    const f = await fixture((_line, file) => fs.appendFileSync(file, heldRecord(session)));
    try {
      const deliver = createClaudeInboxDeliver({ socketPath: f.socketPath, sessionId: session, reader: f.reader, timeoutMs: 1000 });
      const withId = (id: string) => ({ ...delivery('principal'), delivery_id: id });
      for (let i = 0; i < 501; i += 1) await expect(deliver(withId(`d${i}`))).rejects.toMatchObject({ code: 'notice_held' });
      expect(frames(f.frame())).toBe(501);
      const noticeOf = (id: string) => f.frame().split('\n').filter(Boolean).map((line) => JSON.parse(JSON.parse(line).message.content)).find((notice) => notice.delivery_id === id);
      for (const id of ['d0', 'd1']) fs.appendFileSync(f.file, JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId: session, content: JSON.stringify(noticeOf(id)) }) + '\n');
      await expect(deliver(withId('d1'))).resolves.toMatchObject({ confirmation: 'enqueue' });
      await expect(deliver(withId('d0'))).rejects.toMatchObject({ code: 'notice_held' });
      expect(frames(f.frame()), 'nothing was sent again').toBe(501);
    } finally { await f.close(); }
  }, 180_000);

  it('never sends a notice a third time: one sent again that is then neither confirmed nor held stays unconfirmed', async () => {
    let sent = 0;
    const f = await fixture((_line, file) => { sent += 1; if (sent === 1) fs.appendFileSync(file, heldRecord(session)); });
    try {
      const deliver = createClaudeInboxDeliver({ socketPath: f.socketPath, sessionId: session, reader: f.reader, timeoutMs: 200 });
      await expect(deliver(delivery('principal'))).rejects.toMatchObject({ code: 'notice_held' });
      fs.appendFileSync(f.file, filler().repeat(300));
      await expect(deliver(delivery('principal'))).rejects.toMatchObject({ code: 'notice_not_confirmed' });
      expect(frames(f.frame()), 'sent once more').toBe(2);
      await expect(deliver(delivery('principal'))).rejects.toMatchObject({ code: 'notice_not_confirmed' });
      await expect(deliver(delivery('principal'))).rejects.toMatchObject({ code: 'notice_not_confirmed' });
      expect(frames(f.frame()), 'never a third time').toBe(2);
    } finally { await f.close(); }
  });

  const filler = () => JSON.stringify({ type: 'assistant', sessionId: session, message: { content: 'y'.repeat(4000) } }) + '\n';

  it('sends a held notice once more, and says so truthfully, when the conversation grew past what one read takes', async () => {
    const f = await fixture((_line, file) => fs.appendFileSync(file, heldRecord(session)));
    try {
      const deliver = createClaudeInboxDeliver({ socketPath: f.socketPath, sessionId: session, reader: f.reader, timeoutMs: 1000 });
      await expect(deliver(delivery('principal'))).rejects.toMatchObject({ code: 'notice_held' });
      expect(frames(f.frame())).toBe(1);
      fs.appendFileSync(f.file, filler().repeat(300));
      // Not "transcript_unavailable": the record is fine, only too long to follow, so the notice is sent again.
      await expect(deliver(delivery('principal'))).rejects.toMatchObject({ code: 'notice_held' });
      expect(frames(f.frame()), 'sent once more').toBe(2);
      // A second loss of the place is not sent a third time.
      fs.appendFileSync(f.file, filler().repeat(300));
      await expect(deliver(delivery('principal'))).rejects.toMatchObject({ code: 'notice_held' });
      expect(frames(f.frame()), 'never more than one resend').toBe(2);
    } finally { await f.close(); }
  });

  it('sends a held notice once more when the conversation record was replaced, and confirms it when it shows up', async () => {
    let answer = false;
    const f = await fixture((line, file) => {
      const content = JSON.parse(line).message.content;
      fs.appendFileSync(file, answer ? JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId: session, content }) + '\n' : heldRecord(session));
    });
    try {
      const deliver = createClaudeInboxDeliver({ socketPath: f.socketPath, sessionId: session, reader: f.reader, timeoutMs: 1000 });
      await expect(deliver(delivery('principal'))).rejects.toMatchObject({ code: 'notice_held' });
      const copy = fs.readFileSync(f.file); fs.rmSync(f.file); fs.writeFileSync(f.file, copy);
      answer = true;
      await expect(deliver(delivery('principal'))).resolves.toMatchObject({ confirmation: 'enqueue' });
      expect(frames(f.frame())).toBe(2);
    } finally { await f.close(); }
  });

  it('does not take a record of another type with the same words for a hold', async () => {
    const f = await fixture((_line, file) => fs.appendFileSync(file, JSON.stringify({ type: 'user', sessionId: session, content: 'Held peer message — from an unidentified session; preview: «message_type:memesh_message_notice»' }) + '\n'));
    try { await expect(createClaudeInboxDeliver({ socketPath: f.socketPath, sessionId: session, reader: f.reader, timeoutMs: 150 })(delivery('principal'))).rejects.toMatchObject({ code: 'notice_not_confirmed' }); }
    finally { await f.close(); }
  });

  it('does not send a notice again that Claude Code is already holding, and still says it is held', async () => {
    const f = await fixture((_line, file) => fs.appendFileSync(file, heldRecord(session)));
    try {
      const deliver = createClaudeInboxDeliver({ socketPath: f.socketPath, sessionId: session, reader: f.reader, timeoutMs: 1000 });
      await expect(deliver(delivery('principal'))).rejects.toMatchObject({ code: 'notice_held' });
      const sent = f.frame();
      await expect(deliver(delivery('principal'))).rejects.toMatchObject({ code: 'notice_held' });
      expect(f.frame()).toBe(sent);
    } finally { await f.close(); }
  });

  it('says the transcript cannot be read, not that Claude held the notice, when there is no project folder to look in', async () => {
    const f = await fixture(() => {});
    try {
      await expect(createClaudeInboxDeliver({ socketPath: f.socketPath, sessionId: session, reader: () => new ClaudeTranscriptReader(f.dir, ''), timeoutMs: 100 })(delivery('principal'))).rejects.toMatchObject({ code: 'transcript_unavailable' });
      expect(f.frame()).toBe('');
    } finally { await f.close(); }
  });

  it('says the transcript was not found, not that Claude held the notice, when no transcript appears at all', async () => {
    const f = await fixture(() => {});
    fs.rmSync(f.file);
    try {
      await expect(createClaudeInboxDeliver({ socketPath: f.socketPath, sessionId: session, reader: () => new ClaudeTranscriptReader(f.dir, 'project'), timeoutMs: 100 })(delivery('principal'))).rejects.toMatchObject({ code: 'transcript_not_found' });
    } finally { await f.close(); }
  });

  it('says the transcript cannot be read, not that it was never written, when the place it would be is not a folder', async () => {
    const f = await fixture(() => {});
    fs.rmSync(f.dir + '/project', { recursive: true, force: true }); fs.writeFileSync(f.dir + '/project', 'not a folder');
    try {
      await expect(createClaudeInboxDeliver({ socketPath: f.socketPath, sessionId: session, reader: () => new ClaudeTranscriptReader(f.dir, 'project'), timeoutMs: 100 })(delivery('principal'))).rejects.toMatchObject({ code: 'transcript_unavailable' });
    } finally { await f.close(); }
  });

  it('says the transcript cannot be read when what appears at its path is a folder, or is owned by someone else', async () => {
    for (const make of ['folder', 'other-owner'] as const) {
      const f = await fixture((_line, file) => { if (make === 'folder') fs.mkdirSync(file); else fs.writeFileSync(file, ''); });
      fs.rmSync(f.file);
      // The transcript file looks like it belongs to another user (only that path; the socket check must still pass).
      const realLstat = fs.lstatSync.bind(fs);
      const lstat = make === 'other-owner' ? vi.spyOn(fs, 'lstatSync').mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
        const real = (realLstat as (...args: unknown[]) => fs.Stats)(target, ...rest);
        return String(target).endsWith(`${session}.jsonl`) ? Object.assign(Object.create(Object.getPrototypeOf(real)), real, { uid: real.uid + 1 }) : real;
      }) as typeof fs.lstatSync) : undefined;
      try {
        await expect(createClaudeInboxDeliver({ socketPath: f.socketPath, sessionId: session, reader: () => new ClaudeTranscriptReader(f.dir, 'project'), timeoutMs: 300 })(delivery('principal')), make).rejects.toMatchObject({ code: 'transcript_unavailable' });
      } finally { lstat?.mockRestore(); await f.close(); }
    }
  });

  it.each(['principal', 'session'] as const)('confirms a %s notice for a session whose transcript does not exist yet', async kind => {
    const f = await fixture(() => {});
    fs.rmSync(f.file);
    const reader = new ClaudeTranscriptReader(f.dir, 'project');
    const pending = createClaudeInboxDeliver({ socketPath: f.socketPath, sessionId: session, reader: () => reader, timeoutMs: 1000 })(delivery(kind));
    try {
      await vi.waitFor(() => expect(f.frame()).toContain('\n'));
      fs.writeFileSync(f.file, JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId: session, content: JSON.parse(f.frame()).message.content }) + '\n');
      await expect(pending).resolves.toMatchObject({ content: 'notice', confirmation: 'enqueue' });
    } finally { await f.close(); }
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
