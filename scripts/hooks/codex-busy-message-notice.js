#!/usr/bin/env node

// Codex PostToolUse: surface newly waiting inbox messages once per thread.
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import {
  ensurePrivateDir, getDbPath, getMemeshDirFromDbPath, HOOK_BUSY_TIMEOUT_MS,
  hookErrorReason, hookMessageSessionId, isCodexHost, openMemeshDb,
  recordHookOutcome, resolveMessageRecipient, waitingMessageRefs, writePrivateJson,
} from './_shared.js';
import { pruneSessionState, SESSION_ID_RE } from './_stop-notes.js';

let input = '';
// Mirror the router startup lock's owner/PID and inode checks. Contenders
// retry on a later tool call; a crashed owner (or an incomplete old lock)
// cannot permanently silence the reminder.
function clearStaleLock(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 64 || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) return false;
    // On Windows O_NOFOLLOW may be unavailable: compare the opened file
    // to the non-following path stat before trusting even its PID.
    const named = lstatSync(path);
    if (!named.isFile() || named.dev !== stat.dev || named.ino !== stat.ino) return false;
    const buffer = Buffer.alloc(65);
    const length = readSync(fd, buffer, 0, buffer.length, null);
    if (length > 64) return false;
    const raw = buffer.subarray(0, length).toString('utf8').trim();
    let stale = false;
    if (/^[1-9][0-9]*$/.test(raw) && Number.isSafeInteger(Number(raw)) && Number(raw) <= 2147483647) {
      try { process.kill(Number(raw), 0); } catch (err) { stale = err.code === 'ESRCH'; }
    } else stale = Date.now() - stat.mtimeMs > 30_000;
    if (!stale) return false;
    const current = lstatSync(path);
    if (current.dev === stat.dev && current.ino === stat.ino) unlinkSync(path);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ELOOP') return true;
    throw err;
  } finally { if (fd !== undefined) closeSync(fd); }
}
function acquireLock(path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      const identity = fstatSync(fd);
      try { writeFileSync(fd, `${process.pid}\n`); } finally { closeSync(fd); }
      return identity;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!clearStaleLock(path)) return null;
    }
  }
  return null;
}
function releaseLock(path, identity) {
  try { const current = lstatSync(path); if (current.dev === identity.dev && current.ino === identity.ino) unlinkSync(path); } catch { /* already removed */ }
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  let payload;
  let lockPath, lock;
  const record = (outcome, reason) => recordHookOutcome(process.env, { hook: 'codex-busy-message-notice', outcome, reason, payload });
  try {
    payload = JSON.parse(input);
    if (!isCodexHost(process.env)) { record('skipped', 'not Codex'); return; }
    const sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';
    if (!SESSION_ID_RE.test(sessionId)) { record('skipped', 'no usable session_id'); return; }
    const session = hookMessageSessionId(sessionId);
    if (session.mismatch) { record('skipped', 'session_id_mismatch'); return; }
    const recipient = resolveMessageRecipient(process.env, undefined, { sessionId, cwd: payload.cwd });
    const dbPath = process.env.MEMESH_DB_PATH ?? getDbPath();
    if (!recipient || !existsSync(dbPath)) { record('skipped', 'no recipient or database'); return; }
    const dir = join(getMemeshDirFromDbPath(), 'codex-busy-message-notice');
    const statePath = join(dir, `${sessionId}.json`);
    ensurePrivateDir(dir);
    lockPath = `${statePath}.lock`;
    lock = acquireLock(lockPath);
    if (!lock) { record('skipped', 'session reminder lock held'); return; }
    let state;
    try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch { state = {}; }
    const seen = new Set(Array.isArray(state.notified) ? state.notified.filter(id => typeof id === 'string') : []);
    let db;
    let failed = false;
    let refs;
    try {
      db = openMemeshDb(dbPath, { readOnly: true });
      db.pragma(`busy_timeout = ${HOOK_BUSY_TIMEOUT_MS}`);
      // Notice-only accepts do not exclude an unread message; a body pushed
      // to this live thread does, as in the existing Codex reminder path.
      refs = waitingMessageRefs(db, recipient, session.sessionId, err => { failed = true; record('error', `inbox: ${hookErrorReason(err)}`); }, true, [...seen]);
    } finally { try { db?.close(); } catch { /* already closed */ } }
    if (failed) return;
    if (refs.length === 0) { record('skipped', 'no waiting messages'); return; }
    pruneSessionState(dir, Date.now());
    const fresh = refs;
    const previous = [...seen];
    for (const ref of fresh) seen.add(ref.message_id);
    const save = ids => { const tmp = `${statePath}.${process.pid}.tmp`; writePrivateJson(tmp, { notified: ids }); renameSync(tmp, statePath); };
    save([...seen]);
    const projects = new Map();
    for (const ref of fresh) projects.set(ref.project, (projects.get(ref.project) ?? 0) + 1);
    const lines = [...projects].map(([project, count]) => `${count} new message(s) waiting in project ${JSON.stringify(project)}.`);
    const additionalContext = `MeMesh: ${lines.join(' ')} Poll and fetch each using its project and recipient ${JSON.stringify(recipient)}; for a session-targeted delivery use session ${JSON.stringify(sessionId)} as recipient.`;
    try { writeSync(1, `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } })}\n`); }
    catch (error) { try { save(previous); } catch { /* preserve original error */ } throw error; }
    record('notified', 'new waiting message(s)');
  } catch (error) { record('error', hookErrorReason(error)); }
  finally { if (lock) releaseLock(lockPath, lock); }
});
