import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { build } from 'esbuild';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MemeshDatabase } from '../../src/storage/sqlite.js';

// v4.1 adds a quick-capture fallback for `memesh remember "<text>"`:
// fresh users naturally try the one-arg shape before reading the README,
// and the explicit --name/--type form would reject them. These tests lock
// that behavior so a future refactor cannot silently regress the
// first-time-user happy path.

// These tests used to spawn `dist/transports/cli/cli.js`. That made them blind
// to the source they exist to cover: mutating src/transports/cli/cli.ts left
// the whole file green, because `dist` is whatever the last build wrote.
// Bundle the SOURCE into a throwaway directory per run instead, and spawn
// that. The layout matters — cli.ts reads '../../../package.json' relative to
// its own URL, so the bundle sits at <tmp>/dist/transports/cli/cli.js with a
// copy of the real package.json at <tmp>/package.json. `dist` itself stays
// covered by the doctor-fix, setup and node-runtime-check tests.
const REPO_ROOT = path.join(__dirname, '..', '..');
let bundleDir: string;
let CLI_PATH: string;

async function bundleCliFromSource(): Promise<void> {
  // A fresh mkdtemp every run: a stable path that is reused would let a stale
  // bundle answer for edited source, which is the exact defect this replaces.
  bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-src-'));
  CLI_PATH = path.join(bundleDir, 'dist', 'transports', 'cli', 'cli.js');
  fs.mkdirSync(path.dirname(CLI_PATH), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'package.json'), path.join(bundleDir, 'package.json'));
  await build({
    absWorkingDir: REPO_ROOT,
    entryPoints: [path.join(REPO_ROOT, 'src', 'transports', 'cli', 'cli.ts')],
    outfile: CLI_PATH,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22.13',
    packages: 'bundle',
    external: ['node:*'],
    legalComments: 'none',
    // Commander is CommonJS and needs a real `require`, same as the shipped
    // bundle built by scripts/build-cli-bundle.mjs.
    banner: { js: "import { createRequire as __memeshCreateRequire } from 'node:module'; const require = __memeshCreateRequire(import.meta.url);" },
  });
}

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

  beforeAll(async () => { await bundleCliFromSource(); }, 120_000);
  afterAll(() => { fs.rmSync(bundleDir, { recursive: true, force: true }); });

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

  // #324 T1, data loss. `remember "<text>" --title "X"` stored only the
  // paragraphs AFTER the first line: deriveNote leaves the first line out of
  // the observations only because it expects that line to BECOME the title,
  // and an explicit --title removes that premise. The first line then existed
  // nowhere but the slug. Asserted against the DATABASE, not the receipt —
  // the receipt said "stored" while the text was gone.
  it('--title alongside positional text keeps the first line as content', () => {
    const r = runCli(
      ['remember', 'First line title\n\nSecond paragraph body', '--title', 'MY TITLE'],
      { HOME: tmpHome },
    );
    expect(r.exitCode, `stderr: ${r.stderr}`).toBe(0);

    // And with no blank line, the note splits into one paragraph: the shape
    // changes, but nothing the user typed disappears.
    const r2 = runCli(['remember', 'Alpha headline\nBeta detail', '--title', 'SECOND TITLE'], { HOME: tmpHome });
    expect(r2.exitCode, `stderr: ${r2.stderr}`).toBe(0);

    const db = new MemeshDatabase(path.join(tmpHome, '.memesh', 'knowledge-graph.db'));
    const obsFor = (title: string) => (db
      .prepare('SELECT o.content FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.title = ? ORDER BY o.id')
      .all(title) as { content: string }[]).map((o) => o.content);
    const stored = { first: obsFor('MY TITLE'), second: obsFor('SECOND TITLE') };
    db.close();

    expect(stored.first).toEqual(['First line title', 'Second paragraph body']);
    expect(stored.second).toEqual(['Alpha headline Beta detail']);
  }, 60_000);

  it('flag form with positional text keeps both too', () => {
    const { stdout, stderr, exitCode } = runCli(
      ['remember', 'positional content', '--name=combo-note', '--type=note', '--obs=flagged note'],
      { HOME: tmpHome },
    );
    expect(exitCode, `stderr was: ${stderr}`).toBe(0);
    expect(stdout).toContain('2 observations');
  }, 60_000);

  // #324 T2. RememberSchema ran only on the pure-note branch, so the CLI
  // accepted what MCP and HTTP reject: 101 paragraphs as a note exited 1,
  // the same content as --obs exited 0 and stored 102 observations.
  it('the structured form gets the same limits as the note form', () => {
    const many = Array.from({ length: 101 }, (_, i) => `paragraph number ${i}`);
    const r = runCli(['remember', '--name=too-many', '--type=note', '--obs', ...many], { HOME: tmpHome });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('at most 100');

    // Same cap when the observations come from quick-capture text plus --obs.
    const q = runCli(['remember', 'a heading', '--obs', ...many], { HOME: tmpHome });
    expect(q.exitCode).toBe(1);

    // And on the --title branch, where the text itself splits past the cap.
    const overCapText = Array.from({ length: 103 }, (_, i) => `paragraph number ${i}`).join('\n\n');
    const t = runCli(['remember', overCapText, '--title', 'T'], { HOME: tmpHome });
    expect(t.exitCode).toBe(1);
    expect(t.stderr).toContain('at most 100');

    // Both were refused before any write, so the only entity in the graph is
    // the one stored after them.
    expect(runCli(['remember', '--name=ok-one', '--type=note', '--obs=fine'], { HOME: tmpHome }).exitCode).toBe(0);
    const db = new MemeshDatabase(path.join(tmpHome, '.memesh', 'knowledge-graph.db'));
    const rows = db.prepare('SELECT name FROM entities').all() as { name: string }[];
    db.close();
    expect(rows.map((e) => e.name)).toEqual(['ok-one']);
  }, 60_000);

  // #324 T3. The receipt printed result.derived.title — the title the text
  // WOULD have produced — while a memory that already exists keeps its own.
  // The screen said one thing and the database held another.
  it('prints the title the database holds, not the derived one', () => {
    const first = runCli(['remember', 'Use PKCE for auth'], { HOME: tmpHome });
    const name = first.stdout.match(/Stored "([\w-]+)"/)?.[1] ?? '';
    expect(name, first.stdout).not.toBe('');
    expect(runCli(['remember', `--name=${name}`, '--type=note', '--title=T', '--obs=body'], { HOME: tmpHome }).exitCode).toBe(0);

    const again = runCli(['remember', 'Use PKCE for auth'], { HOME: tmpHome });
    expect(again.exitCode, `stderr: ${again.stderr}`).toBe(0);

    const db = new MemeshDatabase(path.join(tmpHome, '.memesh', 'knowledge-graph.db'));
    const row = db.prepare('SELECT title FROM entities WHERE name = ?').get(name) as { title: string | null };
    db.close();
    expect(row.title).toBe('T');
    expect(again.stdout).toContain('title: T');
    expect(again.stdout).not.toContain('title: Use PKCE for auth');
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

  // #333 T4. cli.ts holds its OWN copy of the "name + type or nothing" rule,
  // ahead of the RememberSchema check — so relaxing only the schema would
  // have left the terminal rejecting the correction call that MCP and HTTP
  // accept. Asserted on the stored row, not just the exit code.
  it('--replace without --type keeps the type the memory already has', () => {
    expect(runCli(['remember', '--name=r2', '--type=decision', '--obs=wrong line'], { HOME: tmpHome }).exitCode).toBe(0);
    const r = runCli(['remember', '--name=r2', '--obs=right line', '--replace'], { HOME: tmpHome });
    expect(r.exitCode, `stderr: ${r.stderr}`).toBe(0);
    const db = new MemeshDatabase(path.join(tmpHome, '.memesh', 'knowledge-graph.db'));
    const row = db.prepare("SELECT type FROM entities WHERE name = 'r2'").get() as { type: string };
    const obs = db.prepare("SELECT o.content FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.name = 'r2'").all() as { content: string }[];
    db.close();
    expect(row.type).toBe('decision');
    expect(obs.map((o) => o.content)).toEqual(['right line']);
  }, 60_000);

  it('--name without --replace still needs --type', () => {
    const r = runCli(['remember', '--name=r3', '--obs=a new memory'], { HOME: tmpHome });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('--name and --type');
  }, 60_000);
});
