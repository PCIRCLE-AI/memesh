// Through the real CLI: your own backup restores in one command, a file that
// is not your unchanged backup stays untrusted, and the output says what happened.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { bundleCliFromSource, runBundledCli } from '../helpers/cli-source-bundle.js';
import { removeTempDir } from '../helpers/temp-dir.js';

let bundleDir: string;
let CLI_PATH: string;

describe('memesh import of your own backup', () => {
  let home: string;
  let file: string;
  const cli = (args: string[], h = home) => runBundledCli(CLI_PATH, args, h);
  const dbPath = (h = home) => path.join(h, '.memesh', 'knowledge-graph.db');

  function row(name: string, h = home): { status: string; trust: string | null } | undefined {
    const db = new DatabaseSync(dbPath(h), { readOnly: true });
    try {
      return db.prepare("SELECT status, json_extract(metadata, '$.trust') AS trust FROM entities WHERE name = ?").get(name) as { status: string; trust: string | null } | undefined;
    } finally { db.close(); }
  }
  function observations(name: string): string[] {
    const db = new DatabaseSync(dbPath(), { readOnly: true });
    try {
      return (db.prepare('SELECT o.content FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.name = ? ORDER BY o.id').all(name) as Array<{ content: string }>).map((r) => r.content);
    } finally { db.close(); }
  }
  const wipeDatabase = () => { for (const f of fs.readdirSync(path.join(home, '.memesh'))) if (f.startsWith('knowledge-graph.db')) fs.rmSync(path.join(home, '.memesh', f)); };
  const make = (name: string, obs: string, h = home) => expect(cli(['remember', '--name', name, '--type', 'note', '--obs', obs], h).status).toBe(0);
  const writeForeign = (target: string) => fs.writeFileSync(target, JSON.stringify({
    version: '3.1.0', exported_at: '2026-09-20T00:00:00.000Z', entity_count: 1,
    entities: [{ name: 'foreign', type: 'note', namespace: 'personal', observations: ['from elsewhere'], tags: [], relations: [] }],
  }));

  beforeAll(async () => { ({ cliPath: CLI_PATH, dir: bundleDir } = await bundleCliFromSource()); }, 120_000);
  afterAll(() => { fs.rmSync(bundleDir, { recursive: true, force: true }); });
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-own-backup-'));
    make('alpha', 'ALPHA text');
    make('beta', 'BETA text');
    file = path.join(home, 'backup.json');
    expect(cli(['export', '-o', file]).status).toBe(0);
    // The fixture the tests below depend on: two memories and a signature.
    expect((JSON.parse(fs.readFileSync(file, 'utf8')) as { entities: unknown[] }).entities).toHaveLength(2);
  });
  afterEach(() => removeTempDir(home));

  describe('trust', () => {
    it('your unchanged backup is trusted again, and the output says so', () => {
      wipeDatabase();
      const r = cli(['import', file]);
      expect(r.status, r.stderr).toBe(0);
      expect(row('alpha')?.trust).toBe('trusted');
      expect(row('beta')?.trust).toBe('trusted');
      expect(r.stdout).toContain('Verified: this file was exported from this MeMesh folder and has not been changed');
      expect(r.stdout).toContain('Trusted: 2.');
      expect(r.stdout).not.toContain('as untrusted');
    });

    it('a memory that was untrusted when exported stays untrusted', () => {
      const foreign = path.join(home, 'foreign.json');
      writeForeign(foreign);
      expect(cli(['import', foreign]).status).toBe(0);
      expect(row('foreign')?.trust).toBe('untrusted');
      expect(cli(['export', '-o', file]).status).toBe(0);
      wipeDatabase();
      const r = cli(['import', file]);
      expect(r.status, r.stderr).toBe(0);
      expect(row('foreign')?.trust).toBe('untrusted');
      expect(row('alpha')?.trust).toBe('trusted');
      expect(r.stdout).toContain('Trusted: 2.');
      expect(r.stdout).toContain('1 memory imported as untrusted');
    });

    it('one changed byte makes the whole file untrusted', () => {
      const text = fs.readFileSync(file, 'utf8');
      expect(text).toContain('ALPHA text');
      fs.writeFileSync(file, text.replace('ALPHA text', 'ALPHA tex7'));
      wipeDatabase();
      const r = cli(['import', file]);
      expect(r.status, r.stderr).toBe(0);
      expect(row('alpha')?.trust).toBe('untrusted');
      expect(row('beta')?.trust).toBe('untrusted');
      expect(r.stdout).toContain('signature does not match this MeMesh folder');
      expect(r.stdout).toContain('2 memories imported as untrusted');
    });

    it('a file with its signature removed is untrusted', () => {
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      expect(data.signature).toBeDefined();
      delete data.signature;
      fs.writeFileSync(file, JSON.stringify(data));
      wipeDatabase();
      const r = cli(['import', file]);
      expect(r.status, r.stderr).toBe(0);
      expect(row('alpha')?.trust).toBe('untrusted');
      expect(r.stdout).toContain('2 memories imported as untrusted');
      expect(r.stdout).toContain('--trust');
    });

    it('a file signed by another folder is untrusted', () => {
      const other = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-own-backup-other-'));
      try {
        make('alpha', 'ALPHA text', other);
        const otherFile = path.join(other, 'backup.json');
        expect(cli(['export', '-o', otherFile], other).status).toBe(0);
        wipeDatabase();
        const r = cli(['import', otherFile]);
        expect(r.status, r.stderr).toBe(0);
        expect(row('alpha')?.trust).toBe('untrusted');
        expect(r.stdout).toContain('signature does not match this MeMesh folder');
      } finally { removeTempDir(other); }
    });

    it('a folder that has no secret yet cannot verify anything: the file stays untrusted', () => {
      const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-own-backup-fresh-'));
      try {
        const r = cli(['import', file], fresh);
        expect(r.status, r.stderr).toBe(0);
        expect(row('alpha', fresh)?.trust).toBe('untrusted');
        expect(fs.existsSync(path.join(fresh, '.memesh', 'agent-router.token'))).toBe(false);
      } finally { removeTempDir(fresh); }
    });
  });

  describe('forgotten memories', () => {
    beforeEach(() => { expect(cli(['forget', '--name', 'alpha']).status).toBe(0); });

    it('the default import leaves it archived and prints the one command that brings it back', () => {
      const r = cli(['import', file]);
      expect(r.status, r.stderr).toBe(0);
      expect(row('alpha')?.status).toBe('archived');
      expect(r.stdout).toContain('Kept archived: 1 memory you archived (forgot), left alone.');
      expect(r.stdout).toContain(`run: memesh import ${file} --restore-archived`);
      // Only beta, which is active and unchanged, counts as skipped; the forgotten alpha has its own line.
      expect(r.stdout).toContain('Imported: 0, Skipped: 1, Appended: 0');
    });

    it('that command makes it active again, keeps its text and trust, and replaces nothing newer', () => {
      expect(cli(['remember', '--name', 'beta', '--type', 'note', '--obs', 'NEWER than the backup']).status).toBe(0);
      const r = cli(['import', file, '--restore-archived']);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('Restored: 1 memory you archived (forgot), active again.');
      expect(row('alpha')?.status).toBe('active');
      expect(row('alpha')?.trust).not.toBe('untrusted');
      expect(observations('alpha')).toEqual(['ALPHA text']);
      expect(observations('beta')).toEqual(['BETA text', 'NEWER than the backup']);
      expect(r.stdout).toContain('Skipped: 1 memory already here, left as they are.');
      const found = cli(['recall', 'ALPHA', '--json']);
      expect((JSON.parse(found.stdout) as { entities: Array<{ name: string }> }).entities.map((e) => e.name)).toContain('alpha');
    });

    it('--merge append names the same command with its own flag', () => {
      const r = cli(['import', file, '--merge', 'append']);
      expect(r.stdout).toContain(`run: memesh import ${file} --merge append --restore-archived`);
    });
  });

  it('the import output counts what it did in every class', () => {
    wipeDatabase();
    const r = cli(['import', file]);
    expect(r.stdout).toMatch(/Imported: 2, Skipped: 0, Appended: 0/);
    const again = cli(['import', file]);
    expect(again.stdout).toContain('Skipped: 2 memories already here, left as they are.');
  });

  it('export says so when it cannot sign, instead of silently writing an unsigned file', () => {
    const noSecret = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-own-backup-nosecret-'));
    try {
      make('alpha', 'ALPHA text', noSecret);
      // The secret's path is taken by a directory: signing fails, the export must still succeed.
      fs.rmSync(path.join(noSecret, '.memesh', 'agent-router.token'), { force: true });
      fs.mkdirSync(path.join(noSecret, '.memesh', 'agent-router.token'));
      const r = cli(['export'], noSecret);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toContain('this file is not signed');
      expect(JSON.parse(r.stdout)).not.toHaveProperty('signature');
    } finally { removeTempDir(noSecret); }
  });
});
