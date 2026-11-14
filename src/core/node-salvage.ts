import { openSync, closeSync } from 'node:fs';
import { MemeshDatabase, type SqlInputValue, type SqlOutputValue } from '../storage/sqlite.js';
import { hasPagesWaiting, immutableAddress, refuseMismatchedSidecars } from './file-mode.js';

const q = (s: string): string => '"' + s.replaceAll('"', '""') + '"';
const MIN = -(1n << 63n), MAX = (1n << 63n) - 1n;
function corrupt(e: unknown): boolean {
  const code = (e as { errcode?: number })?.errcode;
  return typeof code === 'number' && [11, 26].includes(code & 255);
}

/** Rowid tables only. Virtual/shadow tables are excluded; triggers are rejected explicitly.
 * WITHOUT ROWID/all-rowid-alias-shadowed schemas throw. Source corruption is
 * reported; other source errors and all writer errors propagate.
 * Failure can leave a private partial output for caller disposal.
 */
export function salvageWithNode(sourcePath: string, outputPath: string): {
  tables: Array<{ name: string; copied: number; complete: boolean }>;
} {
  const pending = hasPagesWaiting(sourcePath);
  if (pending) refuseMismatchedSidecars(sourcePath, { readOnly: true });
  const src = new MemeshDatabase(pending ? sourcePath : immutableAddress(sourcePath), { readOnly: true });
  let dst: MemeshDatabase | undefined;
  try {
    src.exec('PRAGMA trusted_schema=OFF; BEGIN');
    const master = src.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL").all();
    const kinds = src.prepare('PRAGMA main.table_list').all();
    const tables = master.filter(t => t.type === 'table' && !String(t.name).startsWith('sqlite_') &&
      kinds.some(k => k.schema === 'main' && k.name === t.name && k.type === 'table'));
    for (const t of tables) {
      if (kinds.some(k => k.schema === 'main' && k.name === t.name && k.wr === 1))
        throw new Error('Unsupported WITHOUT ROWID table: ' + t.name);
      if (!/^CREATE\s+TABLE\s/i.test(String(t.sql))) throw new Error('Unsupported schema: ' + t.name);
    }
    if (master.some(t => t.type === 'trigger')) throw new Error('Unsupported triggers in salvage source');
    closeSync(openSync(outputPath, 'wx', 0o600));
    dst = new MemeshDatabase(outputPath);
    dst.exec('PRAGMA foreign_keys=OFF; PRAGMA trusted_schema=OFF; BEGIN');
    for (const t of tables) dst.prepare(String(t.sql)).run();
    const reports: Array<{ name: string; copied: number; complete: boolean }> = [];
    for (const t of tables) {
      const name = String(t.name);
      const cols = src.prepare('PRAGMA main.table_xinfo(' + q(name) + ')').all();
      const names = cols.map(c => String(c.name));
      const rowid = ['rowid', '_rowid_', 'oid'].find(n => !names.some(c => c.toLowerCase() === n));
      if (!rowid) throw new Error('Unsupported shadowed rowid: ' + name);
      const writable = cols.filter(c => c.hidden === 0).map(c => String(c.name));
      let alias = '__salvage_rowid';
      while (names.includes(alias)) alias += '_';
      const report = { name, copied: 0, complete: true };
      reports.push(report);
      const read = src.prepare('SELECT ' + q(rowid) + ' AS ' + q(alias) + ', * FROM ' + q(name) +
        ' NOT INDEXED WHERE ' + q(rowid) + ' >= ? ORDER BY ' + q(rowid));
      read.setReadBigInts(true);
      const fields = [rowid, ...writable];
      const insert = dst.prepare('INSERT INTO ' + q(name) + ' (' + fields.map(q).join(',') +
        ') VALUES (' + fields.map(() => '?').join(',') + ')');
      insert.setReadBigInts(true);
      let from = MIN, failures = 0, finished = false;
      // A table whose first and last row cannot be reached may have a broken root.
      try { read.get(MIN); }
      catch (error) {
        if (!corrupt(error)) throw error;
        const reverse = src.prepare('SELECT ' + q(rowid) + ' FROM ' + q(name) + ' NOT INDEXED ORDER BY ' + q(rowid) + ' DESC LIMIT 1');
        reverse.setReadBigInts(true);
        try {
          const last = reverse.get();
          if (last && (Object.values(last)[0] as bigint) < 0n)
            throw new Error('Unsupported damaged first leaf with negative rowids: ' + name, { cause: error });
        }
        catch (reverseError) {
          if (!corrupt(reverseError)) throw reverseError;
          report.complete = false;
          continue;
        }
        // Normal MeMesh IDs start at 1. Do not spend the finite seek budget
        // traversing the entire negative int64 range after a broken first leaf.
        const negative = src.prepare('SELECT ' + q(rowid) + ' FROM ' + q(name) +
          ' NOT INDEXED WHERE ' + q(rowid) + ' < 0 ORDER BY ' + q(rowid) + ' DESC LIMIT 1');
        negative.setReadBigInts(true);
        try {
          if (negative.get()) throw new Error('Unsupported damaged first leaf with negative rowids: ' + name, { cause: error });
        } catch (negativeError) {
          if (!corrupt(negativeError)) throw negativeError;
        }
        report.complete = false;
        from = 0n;
      }
      while (!finished && failures < 4096) {
        const iterator = read.iterate(from);
        try {
          while (true) {
            let next: IteratorResult<Record<string, SqlOutputValue>>;
            try { next = iterator.next(); }
            catch (error) {
              if (!corrupt(error)) throw error;
              report.complete = false;
              failures++;
              if (from === MAX) finished = true;
              else from++;
              break;
            }
            if (next.done) { finished = true; break; }
            const row = next.value, id = row[alias] as bigint;
            insert.run(id, ...writable.map(c => row[c] as SqlInputValue));
            report.copied++;
            if (id === MAX) { finished = true; break; }
            from = id + 1n;
          }
        } finally { iterator.return?.(); }
      }
      if (!finished) throw new Error('Salvage seek limit exceeded for ' + name + '; output must not replace source');
    }
    // INSERT rebuilds sqlite_sequence from surviving rows, but deleted IDs may
    // have advanced it further. Preserve readable source high-water values.
    if (kinds.some(k => k.schema === 'main' && k.name === 'sqlite_sequence')) {
      const sequence = src.prepare('SELECT name,seq FROM sqlite_sequence');
      sequence.setReadBigInts(true);
      let rows: Array<Record<string, SqlOutputValue>> = [];
      const report = { name: 'sqlite_sequence', copied: 0, complete: true };
      reports.push(report);
      try { rows = sequence.all(); }
      catch (error) {
        if (!corrupt(error)) throw error;
        report.complete = false;
      }
      const current = dst.prepare('SELECT seq FROM sqlite_sequence WHERE name=?');
      current.setReadBigInts(true);
      const update = dst.prepare('UPDATE sqlite_sequence SET seq=? WHERE name=?');
      const insert = dst.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES (?,?)');
      update.setReadBigInts(true); insert.setReadBigInts(true);
      for (const row of rows) {
        if (typeof row.name !== 'string' || typeof row.seq !== 'bigint' || row.seq < 0n)
          throw new Error('Unsupported sqlite_sequence entry');
        if (!tables.some(t => t.name === row.name)) continue;
        const prior = current.get(row.name);
        if (prior) {
          if (typeof prior.seq !== 'bigint') throw new Error('Invalid destination sequence');
          update.run(row.seq > prior.seq ? row.seq : prior.seq, row.name);
        } else insert.run(row.name, row.seq);
        report.copied++;
      }
    }
    for (const i of master.filter(t => t.type === 'index' && tables.some(a => a.name === t.tbl_name))) {
      if (!/^CREATE\s+(UNIQUE\s+)?INDEX\s/i.test(String(i.sql))) throw new Error('Unsupported index: ' + i.name);
      const ddl = dst.prepare(String(i.sql));
      ddl.setReadBigInts(true);
      ddl.run();
    }
    dst.exec('COMMIT');
    const checks = dst.prepare('PRAGMA quick_check').all();
    if (checks.length !== 1 || Object.values(checks[0])[0] !== 'ok') throw new Error('Destination quick_check failed');
    return { tables: reports };
  } finally {
    dst?.close();
    src.close();
  }
}
