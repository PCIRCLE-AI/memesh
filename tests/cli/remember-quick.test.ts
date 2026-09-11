import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MemeshDatabase } from '../../src/storage/sqlite.js';

// v4.1 adds a quick-capture fallback for `memesh remember "<text>"`:
// fresh users naturally try the one-arg shape before reading the README,
// and the explicit --name/--type form would reject them. These tests lock
// that behavior so a future refactor cannot silently regress the
// first-time-user happy path.

const CLI_PATH = path.join(__dirname, '..', '..', 'dist', 'transports', 'cli', 'cli.js');

function runCli(args: string[], env: Record<string, string>): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], {
      encoding: 'utf8',
      // Mirror HOME → USERPROFILE so Windows os.homedir() resolves to the test tmpdir
      env: { ...process.env, ...env, USERPROFILE: env.HOME ?? process.env.USERPROFILE ?? '' },
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
      exitCode: err.status ?? 1,
    };
  }
}

describe('memesh remember CLI: quick-capture form', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-remember-'));
    fs.mkdirSync(path.join(tmpHome, '.memesh'), { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tmpHome)) fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('accepts a single positional text argument and stores it as a note', () => {
    const { stdout, stderr, exitCode } = runCli(
      ['remember', 'OAuth 2.0 with PKCE for the API'],
      { HOME: tmpHome },
    );

    expect(exitCode, `stderr was: ${stderr}`).toBe(0);
    // Default success line includes the derived name (slug + text digest)
    // and echoes the derived title (#324).
    expect(stdout).toMatch(/Stored "oauth-2-0-with-pkce-for-the-api-[0-9a-f]{8}"/);
    expect(stdout).toContain('1 observations');
    expect(stdout).toContain('title: OAuth 2.0 with PKCE for the API');
  }, 60_000);

  it('quick-capture with --obs keeps BOTH the positional text and the flag observations', () => {
    // Reviewer-caught variant of the P7 text-drop bug: with --obs but no
    // --name/--type, the quick-capture branch used to discard the positional
    // text while slugging the entity NAME from it — the entity looked like
    // it captured the content when it stored only the --obs value.
    const { stdout, stderr, exitCode } = runCli(
      ['remember', 'the actual content', '--obs=explicit note'],
      { HOME: tmpHome },
    );
    expect(exitCode, `stderr was: ${stderr}`).toBe(0);
    expect(stdout).toMatch(/Stored "the-actual-content-[0-9a-f]{8}"/);
    expect(stdout).toContain('2 observations');

    const recalled = runCli(['recall', 'actual content', '--json'], { HOME: tmpHome });
    expect(recalled.stdout).toContain('the actual content');
    expect(recalled.stdout).toContain('explicit note');
  }, 60_000);

  it('flag form with positional text keeps both too', () => {
    const { stdout, stderr, exitCode } = runCli(
      ['remember', 'positional content', '--name=combo-note', '--type=note', '--obs=flagged note'],
      { HOME: tmpHome },
    );
    expect(exitCode, `stderr was: ${stderr}`).toBe(0);
    expect(stdout).toContain('2 observations');
  }, 60_000);

  it('still accepts the explicit --name/--type form', () => {
    const { exitCode } = runCli(
      ['remember', '--name=auth-decision', '--type=decision', '--obs=Use OAuth 2.0'],
      { HOME: tmpHome },
    );
    expect(exitCode).toBe(0);
  }, 60_000);

  it('stamps source_host=cli on the stored entity', () => {
    // The `sourceHost: 'cli'` literal in cli.ts is the only carrier of CLI
    // write provenance; deleting it used to leave the whole suite green.
    // The CLI's stdout does not print metadata, so read the database.
    const { exitCode, stderr } = runCli(
      ['remember', '--name=cli-prov', '--type=note', '--obs=prov check'],
      { HOME: tmpHome },
    );
    expect(exitCode, `stderr was: ${stderr}`).toBe(0);

    const db = new MemeshDatabase(path.join(tmpHome, '.memesh', 'knowledge-graph.db'));
    const row = db.prepare('SELECT metadata FROM entities WHERE name = ?').get('cli-prov') as { metadata: string };
    db.close();
    expect(JSON.parse(row.metadata).provenance.source_host).toBe('cli');
  }, 60_000);

  it('errors with helpful guidance when no text and no flags are given', () => {
    const { stderr, exitCode } = runCli(['remember'], { HOME: tmpHome });
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('--name');
    expect(stderr).toContain('quick-capture');
  }, 60_000);

  // Codex challenge regression (2026-05-05), restated for #324. The old
  // `quick-<date>-<slug40>` name merged DIFFERENT texts that began alike on
  // the same day — silent data loss. The random suffix that fixed it made
  // every repeat of the SAME text a duplicate. The name now carries a digest
  // of the whole text: different texts never merge, the same text is one
  // memory.
  it('different texts sharing a long prefix stay separate; the same text twice is one memory', () => {
    const prefix = 'fixed the flaky lock timeout in the release pipeline again';
    const a = runCli(['remember', `${prefix} — cause A`], { HOME: tmpHome });
    const b = runCli(['remember', `${prefix} — cause B`], { HOME: tmpHome });
    const a2 = runCli(['remember', `${prefix} — cause A`], { HOME: tmpHome });
    for (const r of [a, b, a2]) expect(r.exitCode, `stderr: ${r.stderr}`).toBe(0);

    const name = (out: string) => out.match(/Stored "([\w-]+)"/)?.[1];
    expect(name(a.stdout)).toBeDefined();
    expect(name(a.stdout)).not.toBe(name(b.stdout));
    expect(name(a2.stdout)).toBe(name(a.stdout));
    expect(a2.stdout).toContain('(0 observations');

    const db = new MemeshDatabase(path.join(tmpHome, '.memesh', 'knowledge-graph.db'));
    const count = db.prepare("SELECT COUNT(*) AS c FROM entities WHERE type = 'note'").get() as { c: number };
    db.close();
    expect(count.c).toBe(2);
  }, 60_000);

  it('--replace rewrites a named memory and needs --name', () => {
    expect(runCli(['remember', '--name=r1', '--type=note', '--obs=wrong line'], { HOME: tmpHome }).exitCode).toBe(0);
    const r = runCli(['remember', '--name=r1', '--type=note', '--obs=right line', '--replace'], { HOME: tmpHome });
    expect(r.exitCode, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('replaced');
    const db = new MemeshDatabase(path.join(tmpHome, '.memesh', 'knowledge-graph.db'));
    const obs = db.prepare("SELECT o.content FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.name = 'r1'").all() as { content: string }[];
    db.close();
    expect(obs.map((o) => o.content)).toEqual(['right line']);

    const noName = runCli(['remember', 'some text', '--replace'], { HOME: tmpHome });
    expect(noName.exitCode).not.toBe(0);
    expect(noName.stderr).toContain('--replace needs --name');
  }, 60_000);
});
