import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MemeshDatabase } from '../storage/sqlite.js';
import { sqliteUtcToIso } from './time-utils.js';
import { refuseMismatchedSidecars } from './file-mode.js';

/** Only the active data directory's named archive and historical shared archive. */
export function legacyConversationArchiveFiles(graph: string, target: string): string[] {
  const directory = path.dirname(path.resolve(graph));
  if (directory !== path.dirname(path.resolve(target))) throw new Error('Legacy archive and message store must share a data directory');
  const backups = path.join(directory, 'backups');
  const names = new Set([path.basename(graph) === 'knowledge-graph.db'
    ? 'agent-messages-expired.db' : `agent-messages-expired-${path.basename(graph)}`, 'agent-messages-expired.db']);
  const privateEntry = (file: string, directoryEntry: boolean) => {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !(directoryEntry ? stat.isDirectory() : stat.isFile())
      || (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0
        || (typeof process.getuid === 'function' && stat.uid !== process.getuid())))) {
      throw new Error(`Unsafe legacy archive path: ${file}`);
    }
  };
  const candidates = [...names].map(name => path.join(backups, name)).filter(file => {
    try { return fs.lstatSync(file) !== undefined; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return false;
      throw error;
    }
  });
  if (candidates.length === 0) return [];
  privateEntry(directory, true); privateEntry(backups, true);
  const files: string[] = [];
  for (const file of candidates) {
    privateEntry(file, false);
    assertLegacyPathsAreDifferent(file, graph); assertLegacyPathsAreDifferent(file, target);
    for (const suffix of ['-wal', '-shm', '-journal']) {
      if (fs.lstatSync(file + suffix, { throwIfNoEntry: false })) privateEntry(file + suffix, false);
    }
    refuseMismatchedSidecars(file, { readOnly: true });
    files.push(file);
  }
  return files;
}

/** Real legacy archives contain these copied tables, not live session registries. */
export function assertLegacyConversationArchiveSchema(source: MemeshDatabase): void {
  const tables = new Set((source.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name));
  for (const name of ['agent_messages', 'agent_message_deliveries', 'agent_network_outbox', 'agent_message_events',
    'agent_message_idempotency', 'agent_message_receipts', 'agent_retention_facts', 'agent_dispatch_attempts',
    'agent_host_accepts', 'agent_ack_facts', 'agent_workflow_facts', 'archive_log']) {
    if (!tables.has(name)) throw new Error(`Invalid legacy archive: missing ${name}`);
  }
}

/** Reserved for audit-only identities, never a newly registered conversation. */
export const LEGACY_CONVERSATION_PREFIX = 'legacy:';
type Row = Record<string, unknown>;
interface Snapshot { message: Row; facts: Record<string, Row[]> }
function readLegacyRow<T>(message: Row, read: () => T): T {
  try { return read(); }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    let reason = error.message;
    if (error instanceof SyntaxError) reason = 'invalid JSON';
    else if (reason.startsWith('Legacy migration conflict for message ')) reason = 'Legacy migration conflict';
    else if (!/^Legacy (?:message has (?:invalid [a-z_ ]+|multiple conversation targets)|timestamp is not a calendar instant|row contains an unsupported value)$/.test(reason)) throw error;
    const id = typeof message.message_id === 'string' ? message.message_id.slice(0, 200) : '<unknown>';
    throw new Error(`Cannot migrate legacy message ${JSON.stringify(id)}: ${reason}. Source data is unchanged. Restore a valid backup or repair this legacy row, then retry.`, {
      // eslint-disable-next-line preserve-caught-error -- Raw parser causes can expose stored message content.
      cause: { name: error.name, message: reason },
    });
  }
}
function historicalHostMatches(adapter: unknown, host: unknown, origin: Row): boolean {
  const family = adapter === 'codex-cli-queue' ? 'codex'
    : adapter === 'claude-channel' || adapter === 'claude-inbox' ? 'claude' : undefined;
  if (family === undefined) return false;
  const matches = (value: unknown): boolean => value === 'cli' ? origin.transport === 'cli'
    : family === 'codex' ? value === 'codex' || value === 'codex-mcp-client' : value === 'claude-code';
  return matches(host) && (origin.source_host === undefined || matches(origin.source_host));
}
function provenance(message: Row): Row {
  const value: unknown = JSON.parse(text(message.provenance_json, 'provenance_json'));
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`Legacy message has invalid ${field}`);
  return value;
}
function utc(value: unknown): string {
  const raw = text(value, 'timestamp');
  const iso = sqliteUtcToIso(raw);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(iso) || !Number.isFinite(Date.parse(iso))) {
    throw new Error('Legacy message has invalid timestamp');
  }
  const result = new Date(iso).toISOString();
  if (result !== (iso.includes('.') ? iso : iso.replace('Z', '.000Z'))) throw new Error('Legacy timestamp is not a calendar instant');
  return result;
}
function session(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > 200 || value.startsWith(LEGACY_CONVERSATION_PREFIX)
    || /[\s/@\\]/u.test(value) || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    || value !== value.normalize('NFC')) return undefined;
  return value;
}
function legacyIdentity(project: string, name: string): string {
  return LEGACY_CONVERSATION_PREFIX + createHash('sha256').update(JSON.stringify([project, name])).digest('hex');
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Legacy row contains an unsupported value');
  return encoded;
}

const databaseFile = (db: MemeshDatabase): string | undefined =>
  (db.prepare("SELECT file FROM pragma_database_list WHERE name = 'main'").get() as { file?: string } | undefined)?.file;

/** Check before opening or changing the destination; a missing target is not created. */
export function assertLegacyDestinationIsDifferent(source: MemeshDatabase, targetFile: string): void {
  const sourceFile = databaseFile(source);
  if (!sourceFile || !targetFile) return;
  assertLegacyPathsAreDifferent(sourceFile, targetFile);
}

/** No filesystem mutation, including when neither path exists yet. */
export function assertLegacyPathsAreDifferent(sourceFile: string, targetFile: string): void {
  if (path.resolve(sourceFile) === path.resolve(targetFile)) throw new Error('Legacy source and target must be different files');
  // File IDs can exceed Number's exact integer range.
  let a: fs.BigIntStats, b: fs.BigIntStats;
  try { a = fs.statSync(sourceFile, { bigint: true }); b = fs.statSync(targetFile, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (a.dev === b.dev && a.ino === b.ino) throw new Error('Legacy source and target must be different files');
}

/**
 * Explicit-handle import only. No ambient graph path, source writes, expiry,
 * archive recovery or cutover. Caller supplies an initialized target schema.
 * A read transaction takes one source snapshot; one target transaction commits
 * all imports. Changed message content conflicts; new audit versions append.
 */
export function importLegacyConversationMessages(
  source: MemeshDatabase,
  target: MemeshDatabase,
  options: { nowMs: number; localMachine: string; messageIds?: readonly string[] },
): { imported: number; alreadyImported: number } {
  if (source === target) throw new Error('Legacy source and target must be different databases');
  const targetFile = databaseFile(target);
  if (targetFile) assertLegacyDestinationIsDifferent(source, targetFile);
  const at = new Date(options.nowMs).toISOString();
  const snapshots = source.transaction((): Snapshot[] => {
    const tables = new Set((source.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name));
    if (!tables.has('agent_messages')) return [];
    // Table and column names below are fixed program literals, never source SQL.
    const rows = (table: string, column: string, values: unknown[]): Row[] => tables.has(table)
      ? (source.prepare(`SELECT * FROM ${table} WHERE ${column} IN (SELECT value FROM json_each(?))`).all(JSON.stringify(values)) as Row[])
        .sort((a, b) => canonical(a).localeCompare(canonical(b))) : [];
    const messages = options.messageIds === undefined
      ? source.prepare('SELECT * FROM agent_messages ORDER BY message_id').all()
      : source.prepare('SELECT * FROM agent_messages WHERE message_id IN (SELECT value FROM json_each(?)) ORDER BY message_id').all(JSON.stringify(options.messageIds));
    return (messages as Row[]).flatMap(message => readLegacyRow(message, () => {
      const sentAt = utc(message.created_at); // Invalid time fails the whole snapshot, not a silently skipped row.
      if (Date.parse(sentAt) <= options.nowMs - 14 * 86_400_000) return [];
      const id = text(message.message_id, 'message_id');
      const facts: Record<string, Row[]> = {};
      for (const table of ['agent_message_deliveries', 'agent_message_events', 'agent_message_receipts',
        'agent_message_idempotency', 'agent_retention_facts', 'agent_network_outbox', 'agent_message_expiries', 'archive_log']) {
        facts[table] = rows(table, 'message_id', [id]);
      }
      facts.agent_message_expiry_runs = rows('agent_message_expiry_runs', 'run_id', facts.agent_message_expiries.map(row => row.run_id));
      const deliveries = facts.agent_message_deliveries.map(row => row.delivery_id);
      for (const table of ['agent_dispatch_attempts', 'agent_host_accepts', 'agent_ack_facts', 'agent_workflow_facts']) {
        facts[table] = rows(table, 'delivery_id', deliveries);
      }
      const connections = facts.agent_dispatch_attempts.map(row => row.connection_id);
      facts.agent_session_connections = rows('agent_session_connections', 'connection_id', connections);
      facts.agent_presence_facts = rows('agent_presence_facts', 'connection_id', connections);
      const project = text(message.project, 'project');
      const identities = new Set([message.sender, message.recipient, provenance(message).sender_session,
        ...facts.agent_message_deliveries.flatMap(row => [row.recipient, row.intended_session]),
        ...facts.agent_session_connections.map(row => row.session_instance_id)]);
      facts.agent_session_instances = tables.has('agent_session_instances')
        ? (source.prepare('SELECT * FROM agent_session_instances WHERE project = ?').all(project) as Row[])
          .filter(row => identities.has(row.session_instance_id) || identities.has(row.principal_id))
          .sort((a, b) => canonical(a).localeCompare(canonical(b))) : [];
      facts.agent_principals = rows('agent_principals', 'project', [project])
        .filter(row => identities.has(row.principal_id));
      return [{ message, facts }];
    }));
  })();

  return target.transaction(() => {
    let imported = 0, alreadyImported = 0;
    for (const snapshot of snapshots) readLegacyRow(snapshot.message, () => {
      const { message: original, facts } = snapshot;
      const project = text(original.project, 'project');
      const id = text(original.message_id, 'message_id');
      const senderName = text(original.sender, 'sender');
      const recipientName = text(original.recipient, 'recipient');
      const explicitTargets = [...new Set(facts.agent_message_deliveries.map(row =>
        row.target_kind === 'session' ? session(row.recipient) : session(row.intended_session)).filter(value => value !== undefined))];
      if (explicitTargets.length > 1) throw new Error('Legacy message has multiple conversation targets');
      const recipient = explicitTargets[0] ?? legacyIdentity(project, recipientName);
      const origin = provenance(original);
      const senderSession = session(origin.sender_session);
      const matchingSenders = facts.agent_session_instances.filter(row => row.session_instance_id === senderSession
        && row.project === project && (row.principal_id === senderName || row.session_instance_id === senderName)
        && historicalHostMatches(row.adapter_kind, original.sender_host, origin));
      const localSender = senderSession !== undefined && matchingSenders.length === 1
        && origin.via !== 'network'
        && origin.from_machine === undefined && origin.origin_message_id === undefined;
      // Only explicit historical session + matching identity/host evidence binds;
      // neither current liveness nor claimed machine metadata supplies identity.
      const sender = localSender ? senderSession : legacyIdentity(project, senderName);
      const payload = text(original.payload_json, 'payload_json');
      const decoded: unknown = JSON.parse(payload);
      const body = original.content_type === 'text/plain' && original.payload_tombstoned_at == null
        ? text(decoded, 'text payload') : payload;
      const mapped = {
        id, sender, sender_host: typeof original.sender_host === 'string' && original.sender_host ? original.sender_host : 'unknown',
        sender_machine: localSender ? options.localMachine : 'unknown', recipient, recipient_host: null,
        recipient_machine: explicitTargets.length === 1 ? options.localMachine : 'unknown',
        kind: 'legacy', body, body_bytes: Buffer.byteLength(body, 'utf8'),
        reply_to: original.reply_to_message_id == null ? null : text(original.reply_to_message_id, 'reply_to'),
        sent_at: utc(original.created_at),
      };
      const detail = canonical({ version: 1, source: snapshot, mapped });
      const existing = target.prepare('SELECT id,sender,sender_host,sender_machine,recipient,recipient_host,recipient_machine,kind,body,body_bytes,reply_to,sent_at FROM messages WHERE id = ?').get(id);
      if (existing) {
        const receipts = target.prepare("SELECT detail FROM events WHERE message_id = ? AND event = 'legacy_imported'").all(id) as Array<{ detail: string }>;
        const initial = receipts.length === 1 ? JSON.parse(receipts[0].detail) as { source?: Partial<Snapshot>; mapped?: unknown } : undefined;
        const routing = (deliveries: Row[]) => deliveries.map(row => canonical({
          delivery_id: row.delivery_id ?? null, message_id: row.message_id ?? null, project: row.project ?? null,
          recipient: row.recipient ?? null, target_kind: row.target_kind ?? 'principal', intended_session: row.intended_session ?? null,
        })).sort();
        if (!initial?.source?.message || !initial.mapped || !initial.source.facts?.agent_message_deliveries
          || canonical(existing) !== canonical(initial.mapped) || canonical(initial.source.message) !== canonical(original)
          || canonical(routing(initial.source.facts.agent_message_deliveries)) !== canonical(routing(facts.agent_message_deliveries))) {
          throw new Error(`Legacy migration conflict for message ${id}`);
        }
        alreadyImported++;
      } else {
        target.prepare('INSERT INTO messages (id,sender,sender_host,sender_machine,recipient,recipient_host,recipient_machine,kind,body,body_bytes,reply_to,sent_at,sender_local,recipient_local) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(mapped.id, mapped.sender, mapped.sender_host, mapped.sender_machine, mapped.recipient,
          mapped.recipient_host, mapped.recipient_machine, mapped.kind, mapped.body, mapped.body_bytes, mapped.reply_to, mapped.sent_at,
          localSender ? 1 : 0, explicitTargets.length === 1 ? 1 : 0);
        target.prepare('INSERT INTO events (message_id,at,event,detail) VALUES (?,?,?,?)').run(id, at, 'legacy_imported', detail);
        imported++;
      }
      const priorRows = target.prepare("SELECT event,detail FROM events WHERE message_id = ? AND event IN ('legacy_fact','legacy_handled')").all(id) as Array<{ event: string; detail: string }>;
      const prior = new Set(priorRows.map(row => `${row.event}:${row.detail}`));
      for (const [table, records] of Object.entries(facts)) for (const row of records) {
        const handled = (table === 'agent_message_receipts' && ['intake', 'ack', 'disposition'].includes(String(row.receipt_kind)))
          || table === 'agent_ack_facts' || table === 'agent_workflow_facts';
        const event = handled ? 'legacy_handled' : 'legacy_fact';
        const fact = canonical({ table, row });
        const key = `${event}:${fact}`;
        if (!prior.has(key)) {
          target.prepare('INSERT INTO events (message_id,at,event,detail) VALUES (?,?,?,?)').run(id, at, event, fact);
          prior.add(key);
        }
      }
    });
    return { imported, alreadyImported };
  }).immediate();
}

export const LEGACY_CONVERSATION_TABLES = [
  'agent_messages', 'agent_message_deliveries', 'agent_message_events', 'agent_message_idempotency',
  'agent_message_cursors', 'agent_message_receipts', 'agent_principals', 'agent_session_instances',
  'agent_session_connections', 'agent_presence_facts', 'agent_dispatch_attempts', 'agent_host_accepts',
  'agent_ack_facts', 'agent_workflow_facts', 'agent_retention_facts', 'agent_message_expiry_runs',
  'agent_message_expiry_lease', 'agent_message_expiries', 'agent_network_outbox', 'agent_network_presence',
] as const;

/** Commit the full eligible copy before retiring tables, with legacy writers locked out. */
export function retireLegacyConversationTables(
  source: MemeshDatabase, target: MemeshDatabase, options: { nowMs: number; localMachine: string },
): { imported: number; alreadyImported: number; retired: number } {
  if (source === target) throw new Error('Legacy source and target must be different databases');
  const file = databaseFile(target);
  if (file) assertLegacyDestinationIsDifferent(source, file);
  const tableNames = () => (source.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name);
  if (!tableNames().some(name => (LEGACY_CONVERSATION_TABLES as readonly string[]).includes(name))) {
    return { imported: 0, alreadyImported: 0, retired: 0 };
  }
  return source.transaction(() => {
    const tables = tableNames();
    const remaining = new Set<string>(LEGACY_CONVERSATION_TABLES.filter(name => tables.includes(name)));
    const parents = new Map(tables.map(name => [name,
      (source.prepare('SELECT "table" AS parent FROM pragma_foreign_key_list(?)').all(name) as Array<{ parent: string }>).map(row => row.parent),
    ]));
    for (const name of tables) {
      if (!remaining.has(name) && parents.get(name)!.some(parent => remaining.has(parent))) {
        throw new Error(`Cannot retire legacy messaging: retained table ${name} still references it`);
      }
    }
    if (!remaining.has('agent_messages') && [...remaining].some(name => source.prepare(`SELECT 1 FROM ${name} LIMIT 1`).get())) {
      throw new Error('Cannot retire legacy messaging without its source message table');
    }
    const order: string[] = [];
    while (remaining.size) {
      const next = [...remaining].find(name => ![...remaining].some(child => parents.get(child)!.includes(name)));
      if (!next) throw new Error('Cannot retire cyclic legacy message tables');
      order.push(next); remaining.delete(next);
    }
    const copied = importLegacyConversationMessages(source, target, {
      nowMs: options.nowMs, localMachine: options.localMachine,
    });
    // Copy commits in the separate destination first. A later DROP/commit failure
    // rolls back the source and leaves an idempotent durable copy for a retry.
    for (const name of order) source.exec(`DROP TABLE ${name}`);
    return { ...copied, retired: order.length };
  }).immediate();
}
