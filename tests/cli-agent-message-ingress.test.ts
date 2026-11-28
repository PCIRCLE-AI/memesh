import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { closeDatabase, openDatabase } from '../src/db.js';
import { seedLegacyMessage } from './helpers/agent-session-fixture.js';
import { readConversationMessageBodyFromStdin } from '../src/transports/cli/cli.js';

const cliLoader = `
  import { createServer } from 'vite';
  const server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  try {
    const { runCli } = await server.ssrLoadModule('/src/transports/cli/cli.ts');
    await runCli([process.argv[0], 'memesh', ...process.argv.slice(1)]);
  } finally {
    await server.close();
  }
`;

function cliArgs(...args: string[]): string[] {
  return ['--input-type=module', '--eval', cliLoader, ...args];
}

describe('conversation stdin payload reader', () => {
  it('keeps a multi-byte character split across stdin writes intact', async () => {
    const bytes = Buffer.from('hi 你好', 'utf8');
    const stdin = Readable.from([bytes.subarray(0, 4), bytes.subarray(4)], { objectMode: true });
    await expect(readConversationMessageBodyFromStdin(stdin)).resolves.toBe('hi 你好');
  });

  it('keeps leading and trailing whitespace for the message audit', async () => {
    await expect(readConversationMessageBodyFromStdin(Readable.from([' \nbody\n ']))).resolves.toBe(' \nbody\n ');
  });
});

describe('CLI project and retired host safety', () => {
  it('rejects retired agent setup before writing config', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-retired-agent-'));
    try {
      const result = spawnSync(process.execPath, cliArgs('agent', 'setup', 'codex', '--principal', 'reviewer', '--workspace', home), {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, USERPROFILE: home, MEMESH_DIR: home, MEMESH_DB_PATH: path.join(home, 'memory.db'), MEMESH_AUTO_UPDATE: 'off', MEMESH_AUTO_CAPTURE: 'false' },
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/unknown (?:command|option)/);
      const help = spawnSync(process.execPath, cliArgs('--help'), {
        encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, MEMESH_AUTO_UPDATE: 'off' },
      });
      expect(help.status).toBe(0);
      expect(help.stdout).not.toMatch(/^\s+agent(?:\s|$)/m);
      expect(fs.existsSync(path.join(home, 'hosts'))).toBe(false);
      expect(fs.existsSync(path.join(home, 'agent-router.token'))).toBe(false);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('#519: kg rename-project --apply backs up next to the database, not in the current directory', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-rename-backup-'));
    try {
      const env = { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' };
      const seed = spawnSync(process.execPath, cliArgs(
        'remember', '--name', 'seed-519', '--type', 'note', '--obs', 'x', '--tags', 'project:old-519',
      ), { encoding: 'utf8', env });
      expect(seed.status, seed.stderr).toBe(0);
      const rename = spawnSync(process.execPath, cliArgs(
        'kg', 'rename-project', '--from', 'old-519', '--to', 'new-519', '--apply', '--json',
      ), { encoding: 'utf8', env });
      expect(rename.status, rename.stderr).toBe(0);
      const { backupPath } = JSON.parse(rename.stdout) as { backupPath: string };
      expect(fs.existsSync(backupPath)).toBe(true);
      expect(fs.realpathSync(path.dirname(path.dirname(backupPath)))).toBe(fs.realpathSync(path.join(home, '.memesh')));
      expect(path.resolve(backupPath).startsWith(path.resolve(process.cwd()) + path.sep)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('#519: kg rename-project --from X --to X is refused with one line and exit 1', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-rename-same-'));
    try {
      const env = { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' };
      const seed = spawnSync(process.execPath, cliArgs(
        'remember', '--name', 'seed-same', '--type', 'note', '--obs', 'x', '--tags', 'project:same-519',
      ), { encoding: 'utf8', env });
      expect(seed.status, seed.stderr).toBe(0);
      for (const extra of [[], ['--apply']]) {
        const r = spawnSync(process.execPath, cliArgs(
          'kg', 'rename-project', '--from', 'same-519', '--to', 'same-519', ...extra,
        ), { encoding: 'utf8', env });
        expect(r.status).toBe(1);
        expect(r.stderr.trim().split('\n')).toHaveLength(1);
        expect(r.stderr).toContain('same project');
        expect(r.stderr).not.toContain('    at ');
      }
      const list = spawnSync(process.execPath, cliArgs('kg', 'rename-project', '--json'), { encoding: 'utf8', env });
      expect(list.stdout).toContain('same-519');
      expect(fs.existsSync(path.join(home, '.memesh', 'backups'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('#519: a rename-project dry run persists nothing, not even auto-decay', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-rename-dry-'));
    const { DatabaseSync } = await import('node:sqlite');
    try {
      const env = { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' };
      const seed = spawnSync(process.execPath, cliArgs(
        'remember', '--name', 'stale-dry', '--type', 'note', '--obs', 'x', '--tags', 'project:dry-old',
      ), { encoding: 'utf8', env });
      expect(seed.status, seed.stderr).toBe(0);
      const dbFile = path.join(home, '.memesh', 'knowledge-graph.db');
      const writer = new DatabaseSync(dbFile);
      writer.exec("UPDATE entities SET confidence = 0.8, last_accessed_at = '2020-01-01' WHERE name = 'stale-dry'; DELETE FROM memesh_metadata WHERE key = 'last_decay_at'");
      writer.close();
      const dry = spawnSync(process.execPath, cliArgs('kg', 'rename-project', '--from', 'dry-old', '--to', 'dry-new'), { encoding: 'utf8', env });
      expect(dry.status, dry.stderr).toBe(0);
      expect(dry.stdout).toContain('Nothing written');
      const reader = new DatabaseSync(dbFile, { readOnly: true });
      try {
        expect((reader.prepare("SELECT confidence FROM entities WHERE name = 'stale-dry'").get() as { confidence: number }).confidence).toBe(0.8);
        expect(reader.prepare("SELECT value FROM memesh_metadata WHERE key = 'last_decay_at'").get()).toBeUndefined();
      } finally {
        reader.close();
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('#519: list mode and incomplete --from/--to never write to the database', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-rename-ro-'));
    const { DatabaseSync } = await import('node:sqlite');
    try {
      const env = { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' };
      const seed = spawnSync(process.execPath, cliArgs(
        'remember', '--name', 'stale-ro', '--type', 'note', '--obs', 'x', '--tags', 'project:ro-old',
      ), { encoding: 'utf8', env });
      expect(seed.status, seed.stderr).toBe(0);
      const dbFile = path.join(home, '.memesh', 'knowledge-graph.db');
      const writer = new DatabaseSync(dbFile);
      writer.exec("UPDATE entities SET confidence = 0.8, last_accessed_at = '2020-01-01' WHERE name = 'stale-ro'; DELETE FROM memesh_metadata WHERE key = 'last_decay_at'");
      writer.close();
      const snapshot = () => {
        const reader = new DatabaseSync(dbFile, { readOnly: true });
        try {
          return {
            entities: reader.prepare('SELECT name, confidence, last_accessed_at FROM entities ORDER BY id').all(),
            metadata: reader.prepare('SELECT key, value FROM memesh_metadata ORDER BY key').all(),
            schema: reader.prepare('SELECT type, name FROM sqlite_master ORDER BY type, name').all(),
          };
        } finally {
          reader.close();
        }
      };
      const before = snapshot();
      expect(before.metadata.some((m) => (m as { key: string }).key === 'last_decay_at')).toBe(false);

      for (const args of [[], ['--json']]) {
        const list = spawnSync(process.execPath, cliArgs('kg', 'rename-project', ...args), { encoding: 'utf8', env });
        expect(list.status, list.stderr).toBe(0);
        expect(list.stdout).toContain('ro-old');
        expect(snapshot()).toEqual(before);
      }
      for (const args of [['--from', 'ro-old'], ['--to', 'ro-new'], ['--from', 'ro-old', '--apply'], ['--to', 'ro-new', '--apply']]) {
        const r = spawnSync(process.execPath, cliArgs('kg', 'rename-project', ...args), { encoding: 'utf8', env });
        expect(r.status).toBe(1);
        expect(r.stderr.trim().split('\n')).toHaveLength(1);
        expect(r.stderr).toMatch(/^Error: .*--from and --to/);
        expect(snapshot()).toEqual(before);
      }
      expect(fs.existsSync(path.join(home, '.memesh', 'backups'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // The CLI operates on memory tags; historical message audit rows stay unchanged.
  function seedMemoryScopes(home: string, extra: (db: ReturnType<typeof openDatabase>) => void = () => {}): string {
    const file = path.join(home, 'seeded.db');
    const db = openDatabase(file);
    try {
      const id = db.prepare("INSERT INTO entities (name, type) VALUES ('rename-memory', 'note')").run().lastInsertRowid;
      db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)').run(id, 'project:mv-old');
      db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(id, 'retain this memory');
      extra(db);
    } finally { closeDatabase(); }
    return file;
  }
  const rename = (env: NodeJS.ProcessEnv, ...args: string[]) => spawnSync(
    process.execPath, cliArgs('kg', 'rename-project', '--from', 'mv-old', '--to', 'mv-new', ...args), { encoding: 'utf8', env });

  it('#519: preview counts match applied memory merges and preserve historical audit', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-rename-count-'));
    try {
      const file = seedMemoryScopes(home, db => {
        db.exec("INSERT INTO tags (entity_id, tag) SELECT id, 'project:mv-new' FROM entities WHERE name = 'rename-memory'");
        seedLegacyMessage(db, { project: 'mv-old', sender: 'author', recipient: 'reviewer', payload: 'historical audit' });
      });
      const snapshot = () => {
        const db = new DatabaseSync(file, { readOnly: true });
        try { return { audit: db.prepare('SELECT * FROM agent_messages').all(), observations: db.prepare('SELECT * FROM observations').all(), tags: db.prepare('SELECT * FROM tags ORDER BY id').all() }; }
        finally { db.close(); }
      };
      const env = { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false', MEMESH_DB_PATH: file };
      const before = snapshot();
      const preview = rename(env, '--json');
      expect(preview.status, preview.stderr).toBe(0);
      expect(snapshot()).toEqual(before);
      const apply = rename(env, '--apply', '--json');
      expect(apply.status, apply.stderr).toBe(0);
      const p = JSON.parse(preview.stdout), a = JSON.parse(apply.stdout);
      expect(p.merged).toBe(1);
      expect(a.merged).toBe(p.merged);
      expect(a.affectedEntities).toBe(p.affectedEntities);
      expect(a).not.toHaveProperty('messageRows');
      const after = snapshot();
      expect(after.audit).toEqual(before.audit);
      expect(after.observations).toEqual(before.observations);
      expect(after.tags.map(row => (row as { tag: string }).tag)).toEqual(['project:mv-new']);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  for (const [name, sql] of [
    ['ignored update', 'CREATE TRIGGER refuse_change BEFORE UPDATE OF tag ON tags BEGIN SELECT RAISE(IGNORE); END'],
    ['ignored merge', "INSERT INTO tags (entity_id, tag) SELECT id, 'project:mv-new' FROM entities; CREATE TRIGGER refuse_change BEFORE DELETE ON tags BEGIN SELECT RAISE(IGNORE); END"],
    ['unique trigger collision', "CREATE TABLE side (value UNIQUE); INSERT INTO side VALUES (1); CREATE TRIGGER refuse_change AFTER UPDATE OF tag ON tags BEGIN INSERT INTO side VALUES (1); END"],
  ]) {
    it(`#519: ${name} rejects preview and apply without changing memory`, () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-rename-rollback-'));
      try {
        const file = seedMemoryScopes(home, db => db.exec(sql));
        const tmp = path.join(home, 'tmp'); fs.mkdirSync(tmp);
        const env = { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false', MEMESH_DB_PATH: file, TMPDIR: tmp };
        const rows = () => {
          const db = new DatabaseSync(file, { readOnly: true });
          try { return ['tags', 'entities', 'observations'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()); }
          finally { db.close(); }
        };
        const before = rows();
        for (const extra of [[], ['--apply']]) {
          const r = rename(env, ...extra);
          expect(r.status).toBe(1);
          expect(r.stderr.trim().split('\n')).toHaveLength(1);
          expect(r.stderr).not.toContain('    at ');
          expect(r.stderr).toMatch(/changed the result|UNIQUE constraint failed/);
          expect(rows()).toEqual(before);
          expect(fs.readdirSync(tmp).filter(n => n.startsWith('memesh-rename-preview-'))).toEqual([]);
        }
      } finally { fs.rmSync(home, { recursive: true, force: true }); }
    });
  }

  it('#519: a refused same-name rename leaves the database untouched, even with --apply', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-rename-same-ro-'));
    const { DatabaseSync } = await import('node:sqlite');
    try {
      const env = { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' };
      const seed = spawnSync(process.execPath, cliArgs(
        'remember', '--name', 'stale-same', '--type', 'note', '--obs', 'x', '--tags', 'project:same-ro',
      ), { encoding: 'utf8', env });
      expect(seed.status, seed.stderr).toBe(0);
      const dbFile = path.join(home, '.memesh', 'knowledge-graph.db');
      const writer = new DatabaseSync(dbFile);
      writer.exec("UPDATE entities SET confidence = 0.8, last_accessed_at = '2020-01-01' WHERE name = 'stale-same'; DELETE FROM memesh_metadata WHERE key = 'last_decay_at'");
      writer.close();
      for (const extra of [[], ['--apply']]) {
        const r = spawnSync(process.execPath, cliArgs('kg', 'rename-project', '--from', 'same-ro', '--to', 'same-ro', ...extra), { encoding: 'utf8', env });
        expect(r.status).toBe(1);
        expect(r.stderr.trim().split('\n')).toHaveLength(1);
        expect(r.stderr).toContain('same project');
        const reader = new DatabaseSync(dbFile, { readOnly: true });
        try {
          expect((reader.prepare("SELECT confidence FROM entities WHERE name = 'stale-same'").get() as { confidence: number }).confidence).toBe(0.8);
          expect(reader.prepare("SELECT value FROM memesh_metadata WHERE key = 'last_decay_at'").get()).toBeUndefined();
        } finally {
          reader.close();
        }
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('#519: with no database yet, listing says so and exits 0, and nothing is created', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-rename-nodb-'));
    try {
      const env = { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' };
      const list = spawnSync(process.execPath, cliArgs('kg', 'rename-project'), { encoding: 'utf8', env });
      expect(list.status, list.stderr).toBe(0);
      expect(list.stdout).toContain('No MeMesh database yet');
      const json = spawnSync(process.execPath, cliArgs('kg', 'rename-project', '--json'), { encoding: 'utf8', env });
      expect(json.status, json.stderr).toBe(0);
      expect(JSON.parse(json.stdout)).toEqual([]);
      const dry = spawnSync(process.execPath, cliArgs('kg', 'rename-project', '--from', 'a', '--to', 'b'), { encoding: 'utf8', env });
      expect(dry.status).toBe(1);
      expect(dry.stderr.trim().split('\n')).toHaveLength(1);
      expect(dry.stderr).toContain('No MeMesh database');
      expect(fs.existsSync(path.join(home, '.memesh', 'knowledge-graph.db'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('#519: list and dry run work on a database in a read-only directory, and change nothing', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-rename-rodir-'));
    const dir = path.join(home, '.memesh');
    try {
      const env = { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' };
      const seed = spawnSync(process.execPath, cliArgs(
        'remember', '--name', 'ro-dir', '--type', 'note', '--obs', 'x', '--tags', 'project:rodir-old',
      ), { encoding: 'utf8', env });
      expect(seed.status, seed.stderr).toBe(0);
      const dbFile = path.join(dir, 'knowledge-graph.db');
      expect(fs.existsSync(`${dbFile}-wal`)).toBe(false);
      const state = () => ({
        db: createHash('sha256').update(fs.readFileSync(dbFile)).digest('hex'),
        files: fs.readdirSync(dir).sort(),
      });
      const before = state();
      fs.chmodSync(dir, 0o555);
      try {
        for (const args of [[], ['--json'], ['--from', 'rodir-old', '--to', 'rodir-new']]) {
          const r = spawnSync(process.execPath, cliArgs('kg', 'rename-project', ...args), { encoding: 'utf8', env });
          expect(r.status, r.stderr).toBe(0);
          expect(r.stderr).toBe('');
          expect(r.stdout).toContain('rodir-old');
          expect(state()).toEqual(before);
        }
        // An EMPTY write-ahead log holds no changes, so it is read as immutable too.
        fs.chmodSync(dir, 0o755);
        fs.writeFileSync(`${dbFile}-wal`, Buffer.alloc(0));
        fs.chmodSync(dir, 0o555);
        const emptyWal = spawnSync(process.execPath, cliArgs('kg', 'rename-project'), { encoding: 'utf8', env });
        expect(emptyWal.status, emptyWal.stderr).toBe(0);
        expect(emptyWal.stdout).toContain('rodir-old');
        expect(state().db).toBe(before.db);
        // A write-ahead log that may hold unread changes is not read as immutable: one line, exit 1.
        fs.chmodSync(dir, 0o755);
        fs.writeFileSync(`${dbFile}-wal`, Buffer.alloc(32));
        fs.chmodSync(dir, 0o555);
        const refused = spawnSync(process.execPath, cliArgs('kg', 'rename-project'), { encoding: 'utf8', env });
        expect(refused.status).toBe(1);
        expect(refused.stderr.trim().split('\n')).toHaveLength(1);
        expect(refused.stderr).not.toContain('    at ');
      } finally {
        fs.chmodSync(dir, 0o755);
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('#519: a symlinked database path finds the real write-ahead log, so a non-empty one is never read as immutable', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-rename-symlink-'));
    const dir = path.join(home, '.memesh');
    try {
      const env = { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' };
      const seed = spawnSync(process.execPath, cliArgs(
        'remember', '--name', 'link-seed', '--type', 'note', '--obs', 'x', '--tags', 'project:link-old',
      ), { encoding: 'utf8', env });
      expect(seed.status, seed.stderr).toBe(0);
      const link = path.join(home, 'link.db');
      fs.symlinkSync(path.join(dir, 'knowledge-graph.db'), link);
      const linked = { ...env, MEMESH_DB_PATH: link };
      fs.chmodSync(dir, 0o555);
      try {
        // No write-ahead log: nothing unread, so the immutable read works through the link.
        const clean = spawnSync(process.execPath, cliArgs('kg', 'rename-project'), { encoding: 'utf8', env: linked });
        expect(clean.status, clean.stderr).toBe(0);
        expect(clean.stdout).toContain('link-old');
        // A non-empty log beside the REAL file may hold changes the immutable read would miss.
        fs.chmodSync(dir, 0o755);
        fs.writeFileSync(path.join(dir, 'knowledge-graph.db-wal'), Buffer.alloc(32));
        fs.chmodSync(dir, 0o555);
        const refused = spawnSync(process.execPath, cliArgs('kg', 'rename-project'), { encoding: 'utf8', env: linked });
        expect(refused.status).toBe(1);
        expect(refused.stderr.trim().split('\n')).toHaveLength(1);
        expect(refused.stderr).not.toContain('    at ');
      } finally {
        fs.chmodSync(dir, 0o755);
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('#519: listing a database with no tags table is one line and exit 1, not a stack trace', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-rename-empty-'));
    try {
      const dir = path.join(home, '.memesh');
      fs.mkdirSync(dir);
      const dbFile = path.join(dir, 'knowledge-graph.db');
      const empty = new DatabaseSync(dbFile);
      empty.exec('CREATE TABLE unrelated (a)');
      empty.close();
      const env = { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' };
      const r = spawnSync(process.execPath, cliArgs('kg', 'rename-project'), { encoding: 'utf8', env });
      expect(r.status).toBe(1);
      expect(r.stderr.trim().split('\n')).toHaveLength(1);
      expect(r.stderr).not.toContain('    at ');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('#519: --apply without --from and --to is refused before the database is opened', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-rename-applyonly-'));
    const { DatabaseSync } = await import('node:sqlite');
    try {
      const env = { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' };
      const seed = spawnSync(process.execPath, cliArgs(
        'remember', '--name', 'stale-applyonly', '--type', 'note', '--obs', 'x', '--tags', 'project:applyonly',
      ), { encoding: 'utf8', env });
      expect(seed.status, seed.stderr).toBe(0);
      const dbFile = path.join(home, '.memesh', 'knowledge-graph.db');
      const writer = new DatabaseSync(dbFile);
      writer.exec("UPDATE entities SET confidence = 0.8, last_accessed_at = '2020-01-01' WHERE name = 'stale-applyonly'; DELETE FROM memesh_metadata WHERE key = 'last_decay_at'");
      writer.close();
      const r = spawnSync(process.execPath, cliArgs('kg', 'rename-project', '--apply'), { encoding: 'utf8', env });
      expect(r.status).toBe(1);
      expect(r.stderr.trim().split('\n')).toHaveLength(1);
      expect(r.stderr).toContain('--apply');
      const reader = new DatabaseSync(dbFile, { readOnly: true });
      try {
        expect((reader.prepare("SELECT confidence FROM entities WHERE name = 'stale-applyonly'").get() as { confidence: number }).confidence).toBe(0.8);
        expect(reader.prepare("SELECT value FROM memesh_metadata WHERE key = 'last_decay_at'").get()).toBeUndefined();
      } finally {
        reader.close();
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('#519: a refused --to is one line and exit 1, not a stack trace', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-rename-badto-'));
    try {
      const env = { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' };
      for (const extra of [[], ['--apply']]) {
        const r = spawnSync(process.execPath, cliArgs('kg', 'rename-project', '--from', 'old', '--to', '/tmp/bad', ...extra), { encoding: 'utf8', env });
        expect(r.status).toBe(1);
        expect(r.stderr.trim().split('\n')).toHaveLength(1);
        expect(r.stderr).toContain('--to');
        expect(r.stderr).not.toContain('    at ');
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('#519: the backup is owner-only and the printed restore command works for an awkward path', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "memesh cli it's \"odd\" $x-"));
    try {
      const env = { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' };
      const seed = spawnSync(process.execPath, cliArgs(
        'remember', '--name', 'seed-odd', '--type', 'note', '--obs', 'x', '--tags', 'project:odd-old',
      ), { encoding: 'utf8', env });
      expect(seed.status, seed.stderr).toBe(0);
      const rename = spawnSync(process.execPath, cliArgs(
        'kg', 'rename-project', '--from', 'odd-old', '--to', 'odd-new', '--apply',
      ), { encoding: 'utf8', env });
      expect(rename.status, rename.stderr).toBe(0);
      const backupLine = rename.stdout.split('\n').find((l) => l.trim().startsWith('Backup:'))!;
      const backupPath = backupLine.trim().slice('Backup: '.length);
      expect(fs.statSync(backupPath).mode & 0o777).toBe(0o600);
      const restoreLine = rename.stdout.split('\n').find((l) => l.includes('Restore if needed'))!;
      const commandStart = restoreLine.indexOf('memesh repair ');
      expect(commandStart).toBeGreaterThanOrEqual(0);
      const command = restoreLine.slice(commandStart);
      const bin = path.join(home, 'bin');
      fs.mkdirSync(bin);
      const quote = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`;
      fs.writeFileSync(path.join(bin, 'memesh'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.resolve('dist/transports/cli/cli.js'))} "$@"\n`, { mode: 0o700 });
      const run = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', env: { ...env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
      expect(run.status, run.stderr).toBe(0);
      const after = spawnSync(process.execPath, cliArgs('kg', 'rename-project'), { encoding: 'utf8', env });
      expect(after.stdout).toContain('odd-old');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('#519: the rename-project backup holds writes still in the WAL file of an open connection', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-rename-wal-'));
    const { DatabaseSync } = await import('node:sqlite');
    let held: InstanceType<typeof DatabaseSync> | undefined;
    try {
      const env = { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' };
      const seed = spawnSync(process.execPath, cliArgs(
        'remember', '--name', 'seed-wal', '--type', 'note', '--obs', 'x', '--tags', 'project:old-wal',
      ), { encoding: 'utf8', env });
      expect(seed.status, seed.stderr).toBe(0);
      // Another live process (a hook, the MCP server) keeps a connection
      // open, so its latest write sits in the -wal file, not the main file.
      const dbPath = path.join(home, '.memesh', 'knowledge-graph.db');
      held = new DatabaseSync(dbPath);
      held.exec('PRAGMA wal_autocheckpoint = 0');
      held.prepare("INSERT INTO entities (name, type) VALUES ('only-in-wal', 'note')").run();
      const rename = spawnSync(process.execPath, cliArgs(
        'kg', 'rename-project', '--from', 'old-wal', '--to', 'new-wal', '--apply', '--json',
      ), { encoding: 'utf8', env });
      expect(rename.status, rename.stderr).toBe(0);
      const { backupPath } = JSON.parse(rename.stdout) as { backupPath: string };
      const backup = new DatabaseSync(backupPath, { readOnly: true });
      try {
        expect(backup.prepare("SELECT count(*) AS n FROM entities WHERE name = 'only-in-wal'").get()).toEqual({ n: 1 });
      } finally {
        backup.close();
      }
    } finally {
      held?.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('kg rename-project refuses a filesystem path as --to, before computing any preview', () => {
    // `--to` names the destination scope that both entities and durable
    // agent-message rows get rewritten into — the same identity `send`
    // refuses as a path-shaped recipient. `--from` is deliberately exempt:
    // it must match an existing, possibly-broken row exactly, including one
    // that is itself path-shaped (the thing an owner is trying to fix).
    //
    // No `--apply` and no seeded data on purpose: `--from` names a project
    // that carries nothing, so if `--to` validation were ever removed, the
    // handler would fall through to `renameProjectTag`'s dry-run preview,
    // find zero affected rows, print "Nothing to do", and exit 0 — a
    // vacuous pass that never reaches the code this test is meant to guard.
    // Validation runs before the preview is even computed, so this must
    // fail regardless of --apply or of what --from resolves to.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-rename-'));
    try {
      const rename = spawnSync(process.execPath, cliArgs(
        'kg', 'rename-project', '--from', 'old-name', '--to', '/Users/x/Projects/repo',
      ), {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' },
      });
      expect(rename.status, rename.stdout).not.toBe(0);
      expect(rename.stderr).toContain('--to:');
      expect(rename.stderr).toContain('must be a stable identifier, not a filesystem path');
      expect(rename.stdout).not.toContain('Dry-run');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

});
