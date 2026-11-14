import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, chmodSync, truncateSync, existsSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemeshDatabase } from '../../src/storage/sqlite.js';
import { salvageWithNode } from '../../src/core/node-salvage.js';
import { hasPagesWaiting, SIDECAR_PERMISSIONS_CODE } from '../../src/core/file-mode.js';

function fixture(run: (src: string, out: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'node-salvage-'));
  try { run(join(dir, 'source.db'), join(dir, 'output.db')); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
function damage(file: string, pages: number[], size = 512) {
  const bytes = readFileSync(file);
  for (const p of pages) bytes.fill(0xa5, (p - 1) * size, p * size);
  writeFileSync(file, bytes);
}
describe('node salvage', () => {
  it.skipIf(process.platform === 'win32').each([
    { mode: 0o600, empty: true },
    { mode: 0o400, empty: false },
    { mode: 0o400, empty: true },
  ])('preserves readonly input permissions with WAL: $mode / empty SHM $empty', ({ mode, empty }) => fixture((src, out) => {
    const db = new MemeshDatabase(src);
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE entities(id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE observations(entity_id INTEGER, content TEXT); INSERT INTO entities VALUES(1,'base-note'); PRAGMA wal_checkpoint(TRUNCATE)");
    db.close(); chmodSync(src, 0o600);
    const writer = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO entities VALUES(2,'wal-only'); INSERT INTO observations VALUES(2,'committed WAL observation')");
      process.kill(process.pid, 'SIGKILL');
    `, src], { encoding: 'utf8', timeout: 5000 });
    expect(writer.signal).toBe('SIGKILL');
    expect(() => process.kill(writer.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    expect(statSync(src + '-wal').size).toBeGreaterThan(32);
    expect(statSync(src + '-shm').size).toBeGreaterThan(0);
    if (empty) truncateSync(src + '-shm', 0);
    for (const suffix of ['-wal', '-shm']) chmodSync(src + suffix, mode);
    const suffixes = ['', '-wal', '-shm', '-journal'];
    const family = () => suffixes.map(suffix => existsSync(src + suffix)
      ? { bytes: readFileSync(src + suffix), mode: statSync(src + suffix).mode & 0o777 } : null);
    const before = family();
    expect(hasPagesWaiting(src)).toBe(true);
    let readFrom = out;
    if (empty && mode === 0o400) {
      expect(() => salvageWithNode(src, out)).toThrow(expect.objectContaining({ code: SIDECAR_PERMISSIONS_CODE }));
      expect(family()).toEqual(before);
      expect(existsSync(out)).toBe(false);
      readFrom = out + '.disposable-clone';
      for (const suffix of suffixes) if (existsSync(src + suffix)) {
        copyFileSync(src + suffix, readFrom + suffix);
        chmodSync(readFrom + suffix, 0o600);
      }
    } else {
      expect(salvageWithNode(src, out).tables).toContainEqual({ name: 'entities', copied: 2, complete: true });
      expect(family().map(row => row?.mode)).toEqual(before.map(row => row?.mode));
      expect(readFileSync(src)).toEqual(before[0]!.bytes);
      expect(readFileSync(src + '-wal')).toEqual(before[1]!.bytes);
    }
    const restored = new MemeshDatabase(readFrom, { readOnly: true });
    try {
      expect(restored.prepare('SELECT name FROM entities ORDER BY id').all().map(row => row.name)).toEqual(['base-note', 'wal-only']);
      expect(restored.prepare('SELECT content FROM observations WHERE entity_id=2').all().map(row => row.content)).toEqual(['committed WAL observation']);
    } finally { restored.close(); }
    if (empty && mode === 0o400) expect(family()).toEqual(before);
  }));
  it('keeps all 20 memories when another root is damaged; reports an unreadable entity root', () => fixture((src, out) => {
    const db = new MemeshDatabase(src);
    db.exec('PRAGMA page_size=512; CREATE TABLE entities(id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE deliveries(id INTEGER PRIMARY KEY)');
    for (let i = 1; i <= 20; i++) db.prepare('INSERT INTO entities VALUES (?,?)').run(i, 'memory' + i);
    const root = Number(db.prepare("SELECT rootpage FROM sqlite_master WHERE name='deliveries'").get()!.rootpage);
    const eroot = Number(db.prepare("SELECT rootpage FROM sqlite_master WHERE name='entities'").get()!.rootpage);
    db.close(); damage(src, [root]);
    const bytes = readFileSync(src);
    expect(salvageWithNode(src, out).tables).toEqual([
      { name: 'entities', copied: 20, complete: true }, { name: 'deliveries', copied: 0, complete: false }
    ]);
    expect(readFileSync(src)).toEqual(bytes);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    damage(src, [eroot]);
    expect(salvageWithNode(src, out + '2').tables[0]).toEqual({ name: 'entities', copied: 0, complete: false });
  }));
  it('continues through two bad leaves, including readable rows between them', () => fixture((src, out) => {
    const db = new MemeshDatabase(src);
    db.exec('PRAGMA page_size=512; CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT); CREATE INDEX items_value ON items(value)');
    const put = db.prepare('INSERT INTO items VALUES (?,?)');
    db.exec('BEGIN');
    for (let i = 1; i <= 1000; i++) put.run(i, 'salvage-payload-' + 'x'.repeat(80));
    db.exec('COMMIT'); db.close();
    const bytes = readFileSync(src), leaves: number[] = [];
    for (let p = 2; p <= bytes.length / 512; p++)
      if (bytes[(p-1)*512] === 13 && bytes.subarray((p-1)*512,p*512).includes(Buffer.from('salvage-payload-'))) leaves.push(p);
    expect(leaves.length).toBeGreaterThan(50);
    const bad = [leaves[Math.floor(leaves.length/4)], leaves[Math.floor(leaves.length*3/4)]];
    let lost = 0;
    for (const p of bad) lost += bytes.readUInt16BE((p-1)*512+3);
    damage(src, bad);
    const original = readFileSync(src);
    const report = salvageWithNode(src, out).tables[0];
    expect(report).toEqual({ name: 'items', copied: 1000-lost, complete: false });
    const restored = new MemeshDatabase(out);
    expect(restored.prepare('SELECT count(*) n FROM items WHERE id BETWEEN 400 AND 600').get()!.n).toBe(201);
    expect(restored.prepare('PRAGMA quick_check').get()!.quick_check).toBe('ok');
    restored.close(); expect(readFileSync(src)).toEqual(original);
  }));
  it('preserves signed/sparse bigint rowids and ordinary FTS-prefix tables', () => fixture((src, out) => {
    const db = new MemeshDatabase(src);
    db.exec("CREATE VIRTUAL TABLE search USING fts5(text); CREATE TABLE search_custom(v BLOB, n INTEGER); CREATE INDEX custom_n ON search_custom(n)");
    const ids = [-(1n<<63n), -5n, 9007199254740999n, (1n<<63n)-1n];
    const put = db.prepare('INSERT INTO search_custom(rowid,v,n) VALUES (?,?,?)'); put.setReadBigInts(true);
    for (const id of ids) put.run(id, Buffer.from([1,2]), id);
    db.close();
    expect(salvageWithNode(src,out).tables).toEqual([{ name: 'search_custom', copied: 4, complete: true }]);
    const restored = new MemeshDatabase(out);
    const stmt = restored.prepare('SELECT rowid,n FROM search_custom ORDER BY rowid'); stmt.setReadBigInts(true);
    expect(stmt.all().map(r => [r.rowid,r.n])).toEqual(ids.map(i => [i,i]));
    expect(restored.prepare("SELECT name FROM sqlite_master WHERE name='custom_n'").get()).toBeTruthy();
    restored.close();
    expect(() => salvageWithNode(src,out)).toThrow();
  }));
  it('rejects WITHOUT ROWID rather than silently dropping it', () => fixture((src,out) => {
    const db = new MemeshDatabase(src); db.exec('CREATE TABLE special(id TEXT PRIMARY KEY) WITHOUT ROWID'); db.close();
    expect(() => salvageWithNode(src,out)).toThrow('WITHOUT ROWID');
  }));
  it('propagates destination constraint failures', () => fixture((src,out) => {
    const db = new MemeshDatabase(src);
    db.exec('CREATE TABLE checked(n INTEGER CHECK(n>0)); PRAGMA ignore_check_constraints=ON; INSERT INTO checked VALUES(-1)');
    db.close();
    expect(() => salvageWithNode(src,out)).toThrow(/CHECK constraint failed/);
  }));
  it('throws explicitly if damaged sparse rowids exceed the seek budget', () => fixture((src,out) => {
    const db = new MemeshDatabase(src);
    db.exec('PRAGMA page_size=512; CREATE TABLE sparse(id INTEGER PRIMARY KEY, v TEXT)');
    const put = db.prepare('INSERT INTO sparse VALUES (?,?)'); put.setReadBigInts(true);
    for (let i=1; i<=100; i++) put.run(BigInt(i)*1000000000000n, 'sparse-payload-'+'x'.repeat(80));
    db.close();
    const bytes = readFileSync(src), leaves: number[] = [];
    for (let p=2;p<=bytes.length/512;p++)
      if (bytes[(p-1)*512]===13 && bytes.subarray((p-1)*512,p*512).includes(Buffer.from('sparse-payload-'))) leaves.push(p);
    damage(src,[leaves[Math.floor(leaves.length/2)]]);
    expect(() => salvageWithNode(src,out)).toThrow('Salvage seek limit exceeded');
  }));

  it('preserves AUTOINCREMENT high-water after deleting the largest ID', () => fixture((src,out) => {
    const db = new MemeshDatabase(src);
    db.exec("CREATE TABLE entities(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT); INSERT INTO entities VALUES(1,'kept'),(900,'deleted'); DELETE FROM entities WHERE id=900");
    db.close();
    const result = salvageWithNode(src,out);
    expect(result.tables.find(t => t.name==='sqlite_sequence')).toEqual({name:'sqlite_sequence',copied:1,complete:true});
    const restored = new MemeshDatabase(out);
    expect(restored.prepare("INSERT INTO entities(name) VALUES('new')").run().lastInsertRowid).toBe(901);
    restored.close();
  }));
  it('rescues all later rows after the first positive-ID leaf is damaged', () => fixture((src,out) => {
    const db = new MemeshDatabase(src);
    db.exec('PRAGMA page_size=512; CREATE TABLE items(id INTEGER PRIMARY KEY, v TEXT)');
    const put = db.prepare('INSERT INTO items VALUES (?,?)');
    for (let i=1;i<=100;i++) put.run(i, 'first-payload-'+'x'.repeat(80));
    db.close();
    const bytes=readFileSync(src);
    let first=0;
    for(let p=2;p<=bytes.length/512;p++)
      if(bytes[(p-1)*512]===13 && bytes.subarray((p-1)*512,p*512).includes(Buffer.from('first-payload-'))) { first=p; break; }
    expect(first).toBeGreaterThan(0);
    const lost=bytes.readUInt16BE((first-1)*512+3);
    damage(src,[first]);
    expect(salvageWithNode(src,out).tables[0]).toEqual({name:'items',copied:100-lost,complete:false});
  }));
  it('rejects triggers explicitly rather than silently dropping behavior', () => fixture((src,out) => {
    const db=new MemeshDatabase(src);
    db.exec('CREATE TABLE items(n INTEGER); CREATE TRIGGER changed AFTER INSERT ON items BEGIN UPDATE items SET n=2; END');
    db.close();
    expect(() => salvageWithNode(src,out)).toThrow('Unsupported triggers');
  }));

});
