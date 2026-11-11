import { describe, expect, it, vi } from 'vitest';
import { getDatabase } from '../../src/db.js';
import { DEFAULT_ROUTER_IDLE_MS, readRouterIdleExit, recordRouterIdleExit, routerHasWork, routerIdleSettings, watchRouterIdle } from '../../src/host-runtime/router-idle.js';
import { useTestDatabase } from '../helpers/db-fixture.js';
import { registerAgentSession } from '../helpers/agent-session-fixture.js';
import { sendAgentMessage } from '../../src/core/agent-messaging.js';

useTestDatabase('memesh-router-idle-');
const project = 'router-idle';
const IDLE = 10 * 60_000;

function watch(now: { at: number }, idleMs = IDLE) {
  const onIdle = vi.fn();
  const w = watchRouterIdle({ db: getDatabase(), idleMs, checkMs: 60_000, onIdle, now: () => now.at });
  return { onIdle, w };
}

function attempt(id: string, result: string, ageMinutes: number) {
  const db = getDatabase();
  const session = registerAgentSession(project, `p-${id}`, { adapterKind: 'claude-inbox', disconnected: true });
  const sent = sendAgentMessage(db, { project, sender: 'a', recipient: `p-${id}`, idempotency_key: id, content_type: 'text/plain', payload: 'x' });
  const connection = db.prepare('SELECT connection_id FROM agent_session_connections WHERE session_instance_id = ?').get(session) as { connection_id: string };
  db.prepare(`INSERT INTO agent_dispatch_attempts (attempt_id, delivery_id, project, principal_id, session_instance_id, connection_id, generation, router_instance_id, attempt_number, result, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, 'router', 1, ?, datetime('now', ?))`)
    .run(`attempt-${id}`, sent.delivery_id, project, `p-${id}`, session, connection.connection_id, result, `-${ageMinutes} minutes`);
}

describe('router idle exit', () => {
  it('ends once, after the idle time has passed with nothing connected and nothing running', () => {
    const now = { at: 1_000_000 };
    const { onIdle, w } = watch(now);
    w.check();
    now.at += IDLE - 1; w.check();
    expect(onIdle).not.toHaveBeenCalled();
    now.at += 1; w.check();
    expect(onIdle).toHaveBeenCalledTimes(1);
    now.at += IDLE; w.check();
    expect(onIdle).toHaveBeenCalledTimes(1);
    w.stop();
  });

  it('stays while a host holds a live connection, and counts the idle time from when it left', () => {
    const now = { at: Date.now() };
    registerAgentSession(project, 'bob', { sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', adapterKind: 'claude-inbox', leaseExpiresAtMs: now.at + 10 * IDLE });
    const { onIdle, w } = watch(now);
    for (let i = 0; i < 5; i++) { now.at += IDLE; w.check(); }
    expect(onIdle).not.toHaveBeenCalled();
    getDatabase().prepare('UPDATE agent_session_connections SET disconnected_at = CURRENT_TIMESTAMP').run();
    w.check();
    now.at += IDLE - 1; w.check();
    expect(onIdle).not.toHaveBeenCalled();
    now.at += 1; w.check();
    expect(onIdle).toHaveBeenCalledTimes(1);
    w.stop();
  });

  it('starts counting again from the moment a host leaves, not from the earlier idle time', () => {
    const now = { at: Date.now() };
    const { onIdle, w } = watch(now);
    w.check();
    now.at += IDLE - 1000; w.check();
    // A host connects now and leaves again a moment later.
    registerAgentSession(project, 'bob', { sessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', adapterKind: 'claude-inbox', leaseExpiresAtMs: now.at + IDLE });
    w.check();
    getDatabase().prepare('UPDATE agent_session_connections SET disconnected_at = CURRENT_TIMESTAMP').run();
    now.at += 2000; w.check();
    expect(onIdle).not.toHaveBeenCalled();
    now.at += IDLE; w.check();
    expect(onIdle).toHaveBeenCalledTimes(1);
    w.stop();
  });

  it('treats an expired lease as no connection, and a lease that ends exactly now as expired', () => {
    const now = { at: Date.now() };
    registerAgentSession(project, 'bob', { adapterKind: 'claude-inbox', leaseExpiresAtMs: now.at - 1 });
    expect(routerHasWork(getDatabase(), now.at)).toBe(false);
    registerAgentSession(project, 'carol', { adapterKind: 'claude-inbox', leaseExpiresAtMs: now.at });
    expect(routerHasWork(getDatabase(), now.at), 'a lease that ends this very millisecond').toBe(false);
    registerAgentSession(project, 'dave', { adapterKind: 'claude-inbox', leaseExpiresAtMs: now.at + 1 });
    expect(routerHasWork(getDatabase(), now.at)).toBe(true);
  });

  it('stays while a delivery attempt is running, but not for one abandoned long ago', () => {
    attempt('running', 'started', 1);
    expect(routerHasWork(getDatabase(), Date.now())).toBe(true);
    getDatabase().prepare("DELETE FROM agent_dispatch_attempts").run();
    attempt('stuck', 'started', 30);
    attempt('finished', 'adapter_returned', 1);
    expect(routerHasWork(getDatabase(), Date.now())).toBe(false);
  });

  it('counts a running attempt for five minutes and no longer', () => {
    attempt('four-minutes', 'started', 4);
    expect(routerHasWork(getDatabase(), Date.now())).toBe(true);
    getDatabase().prepare('DELETE FROM agent_dispatch_attempts').run();
    attempt('six-minutes', 'started', 6);
    expect(routerHasWork(getDatabase(), Date.now())).toBe(false);
  });

  it('looks on its own timer, and the timer does not keep the process alive', () => {
    vi.useFakeTimers();
    try {
      const onIdle = vi.fn();
      const unref = vi.spyOn(globalThis, 'setInterval');
      const w = watchRouterIdle({ db: getDatabase(), idleMs: 1000, checkMs: 100, onIdle });
      vi.advanceTimersByTime(900);
      expect(onIdle).not.toHaveBeenCalled();
      vi.advanceTimersByTime(300);
      expect(onIdle).toHaveBeenCalledTimes(1);
      expect(unref).toHaveBeenCalledTimes(1);
      // Node's timer object says whether it was unref'd.
      const timer = unref.mock.results[0].value as { hasRef?: () => boolean };
      if (typeof timer.hasRef === 'function') expect(timer.hasRef()).toBe(false);
      w.stop();
    } finally { vi.useRealTimers(); }
  });

  it('records the time of an idle exit, and reads it back, nothing when none was recorded', () => {
    expect(readRouterIdleExit(getDatabase())).toBeUndefined();
    recordRouterIdleExit(getDatabase(), new Date('2026-11-11T10:00:00.000Z'));
    expect(readRouterIdleExit(getDatabase())).toBe('2026-11-11T10:00:00.000Z');
    recordRouterIdleExit(getDatabase(), new Date('2026-11-11T11:30:00.000Z'));
    expect(readRouterIdleExit(getDatabase())).toBe('2026-11-11T11:30:00.000Z');
  });

  it('does not count a stored message for a session that is not connected as work', () => {
    sendAgentMessage(getDatabase(), { project, sender: 'a', recipient: 'nobody', idempotency_key: 'waiting', content_type: 'text/plain', payload: 'x' });
    expect(routerHasWork(getDatabase(), Date.now())).toBe(false);
  });

  it('can be turned off with an idle time of 0', () => {
    const now = { at: 1 };
    const { onIdle, w } = watch(now, 0);
    now.at += 100 * IDLE; w.check();
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('reads the idle time from the environment, ignoring values that are not whole milliseconds', () => {
    const warn = vi.fn();
    expect(routerIdleSettings({}, warn).idleMs).toBe(DEFAULT_ROUTER_IDLE_MS);
    expect(DEFAULT_ROUTER_IDLE_MS).toBe(600_000);
    expect(routerIdleSettings({ MEMESH_ROUTER_IDLE_MS: '1500', MEMESH_ROUTER_IDLE_CHECK_MS: '100' }, warn)).toEqual({ idleMs: 1500, checkMs: 100 });
    expect(routerIdleSettings({ MEMESH_ROUTER_IDLE_MS: '0' }, warn).idleMs).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    for (const bad of ['-1', '1.5', 'soon', '1e3', '0x10']) expect(routerIdleSettings({ MEMESH_ROUTER_IDLE_MS: bad }, warn).idleMs).toBe(DEFAULT_ROUTER_IDLE_MS);
    expect(warn.mock.calls).toHaveLength(5);
    expect(routerIdleSettings({ MEMESH_ROUTER_IDLE_CHECK_MS: '10' }, warn).checkMs).toBe(30_000);
  });
});
