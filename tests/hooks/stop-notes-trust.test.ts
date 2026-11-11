/**
 * The Stop hook reads the session's own memory folder, so its notes are trusted; and a
 * folder it had already read (before its notes were trusted) is read once more, so the
 * notes already stored are made trusted without waiting for one of them to change.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { ingestNoteDirectory } from '../../src/core/note-ingest.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { runNoteIngestion, runStopNotes } from '../../scripts/hooks/_stop-notes.js';
import { spawnSync } from 'node:child_process';
import { getProjectName } from '../../src/core/paths.js';
import { SKIP_REASONS } from '../../scripts/hooks/_shared.js';

let root: string;
let dbPath: string;
let folder: string;
const saved: Record<string, string | undefined> = {};

const trust = (name: string) => {
  const r = getDatabase().prepare('SELECT metadata FROM entities WHERE name = ?').get(name) as { metadata: string };
  return (JSON.parse(r.metadata) as { trust?: string }).trust;
};
const metaUrl = pathToFileURL(path.resolve('scripts/hooks/session-start.js')).href;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-stop-notes-trust-')));
  for (const key of ['MEMESH_DIR', 'MEMESH_DB_PATH']) saved[key] = process.env[key];
  dbPath = path.join(root, 'kg.db');
  process.env.MEMESH_DIR = root;
  process.env.MEMESH_DB_PATH = dbPath;
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ updateCheck: false }));
  folder = path.join(root, 'memory');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'a.md'), '---\nname: feedback-a\ndescription: Prefer small diffs\nmetadata:\n  type: feedback\n---\nPrefer small diffs.\n');
  openDatabase(dbPath);
});
afterEach(() => {
  closeDatabase();
  for (const key of ['MEMESH_DIR', 'MEMESH_DB_PATH']) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('the Stop hook\'s note ingestion', () => {
  it('stores the session\'s own folder trusted, and reads an already-seen folder once more to make its stored notes trusted', async () => {
    // An earlier version stored this note untrusted and recorded the folder as read, with no `trusted` mark.
    ingestNoteDirectory({ trusted: false, dir: folder, project: 'proj-b' });
    expect(trust('feedback-a')).toBe('untrusted');
    const key = createHash('sha256').update(folder).digest('hex').slice(0, 16);
    fs.writeFileSync(path.join(root, 'note-ingest-state-2.json'), JSON.stringify({ [key]: { at: Date.now() + 60_000, more: false } }));
    closeDatabase();

    const first = await runNoteIngestion({ memoryDir: folder, project: 'proj-b', metaUrl });
    openDatabase(dbPath);
    expect(first.reason, 'the folder must be read, not skipped as unchanged').not.toBe(SKIP_REASONS.noNoteChanged);
    // The outcome says how many were changed and where the copy is, and names one of them.
    expect(first.outcome).toBe('wrote');
    expect(first.reason).toMatch(/1 made trusted \(copy of the database: knowledge-graph-before-note-trust-/);
    expect(first.entity).toBe('feedback-a');
    expect(trust('feedback-a')).toBe('trusted');
    expect(fs.readdirSync(path.join(root, 'backups')).filter(n => n.endsWith('.db'))).toHaveLength(1);
    closeDatabase();

    // Read and marked: the next Stop finds nothing changed.
    const second = await runNoteIngestion({ memoryDir: folder, project: 'proj-b', metaUrl });
    expect(second.reason).toBe(SKIP_REASONS.noNoteChanged);
  });

  it('the next Stop makes only the own folder\'s old notes trusted: other folders, imports and rows with no folder stay untrusted', async () => {
    const other = path.join(root, 'downloads-notes');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'b.md'), '---\nname: other-old\ndescription: From some other folder\nmetadata:\n  type: feedback\n---\nFrom some other folder.\n');
    ingestNoteDirectory({ trusted: false, dir: folder, project: 'proj-b' });
    ingestNoteDirectory({ trusted: false, dir: other, project: 'proj-b' });
    const kg = new KnowledgeGraph(getDatabase());
    kg.createEntity('imported-one', 'feedback', { observations: ['from a bundle'], metadata: { trust: 'untrusted', provenance: { source: 'import' } }, trustOverride: 'untrusted' });
    kg.createEntity('no-folder', 'feedback', { observations: ['odd'], tags: ['source:note-file'], metadata: { trust: 'untrusted', provenance: { source: 'note-file' } }, trustOverride: 'untrusted' });
    // Opening the database again lifts nothing: only a Stop that reads the own folder does.
    closeDatabase();
    openDatabase(dbPath);
    expect(['feedback-a', 'other-old', 'imported-one', 'no-folder'].map(trust)).toEqual(['untrusted', 'untrusted', 'untrusted', 'untrusted']);
    const key = createHash('sha256').update(folder).digest('hex').slice(0, 16);
    fs.writeFileSync(path.join(root, 'note-ingest-state-2.json'), JSON.stringify({ [key]: { at: Date.now() + 60_000, more: false } }));
    closeDatabase();

    const run = await runNoteIngestion({ memoryDir: folder, project: 'proj-b', metaUrl });
    openDatabase(dbPath);
    expect(run.reason).toMatch(/1 made trusted \(copy of the database: knowledge-graph-before-note-trust-/);
    expect(['feedback-a', 'other-old', 'imported-one', 'no-folder'].map(trust)).toEqual(['trusted', 'untrusted', 'untrusted', 'untrusted']);
    // The copy and the record of what changed exist, and the record names the one row.
    const backups = fs.readdirSync(path.join(root, 'backups'));
    const copy = backups.find((n) => n.endsWith('.db'));
    expect(copy, 'a copy of the database').toBeDefined();
    const record = JSON.parse(fs.readFileSync(path.join(root, 'backups', `${copy}.json`), 'utf8')) as { count: number; names: string[] };
    expect(record.count).toBe(1);
    expect(record.names).toEqual(['feedback-a']);
  });

  it('with no copy the Stop records an error, changes nothing, and reads the folder again next time', async () => {
    ingestNoteDirectory({ trusted: false, dir: folder, project: 'proj-b' });
    const key = createHash('sha256').update(folder).digest('hex').slice(0, 16);
    fs.writeFileSync(path.join(root, 'note-ingest-state-2.json'), JSON.stringify({ [key]: { at: Date.now() + 60_000, more: false } }));
    fs.writeFileSync(path.join(root, 'backups'), 'in the way');
    closeDatabase();

    const blocked = await runNoteIngestion({ memoryDir: folder, project: 'proj-b', metaUrl });
    openDatabase(dbPath);
    expect(blocked.outcome).toBe('error');
    expect(blocked.reason).toMatch(/none of them was made trusted/);
    expect(trust('feedback-a')).toBe('untrusted');
    closeDatabase();

    fs.rmSync(path.join(root, 'backups'));
    const retried = await runNoteIngestion({ memoryDir: folder, project: 'proj-b', metaUrl });
    openDatabase(dbPath);
    expect(retried.outcome).toBe('wrote');
    expect(trust('feedback-a')).toBe('trusted');
  });
});

// The memory folder comes from the transcript's path (the directory the session started
// in); the project a note is filed under comes from the payload's cwd. When the session has
// moved to another project, the folder is not that project's: its notes are not filed there.
describe('a memory folder is read only for the project it belongs to', () => {
  const gitInit = (dir: string) => {
    fs.mkdirSync(dir, { recursive: true });
    const r = spawnSync('git', ['-C', dir, 'init', '-q'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
  };
  const sessionIn = (startedIn: string) => {
    const projectDir = path.join(root, 'claude-projects', startedIn.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(path.join(projectDir, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'memory', 'a.md'), '---\nname: folder-note\ndescription: Prefer small diffs\nmetadata:\n  type: feedback\n---\nPrefer small diffs.\n');
    const transcript = path.join(projectDir, 'session-1.jsonl');
    fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', cwd: startedIn, message: { content: 'hi' } })}\n`);
    return transcript;
  };
  const stop = async (transcript: string, cwd: string) => {
    closeDatabase();
    const run = await runStopNotes({ session_id: 'session-1', transcript_path: transcript, cwd }, {
      captureEnabled: true, project: getProjectName(cwd), metaUrl, env: { ...process.env, MEMESH_DIR: root, MEMESH_DB_PATH: dbPath },
    });
    run.settle?.(false);
    openDatabase(dbPath);
  };
  const stored = () => getDatabase().prepare(
    "SELECT json_extract(e.metadata, '$.trust') AS trust, (SELECT group_concat(tag) FROM tags t WHERE t.entity_id = e.id AND t.tag LIKE 'project:%') AS project FROM entities e WHERE e.name = 'folder-note'",
  ).get() as { trust: string; project: string } | undefined;

  it('a session that moved to another repository does not file the folder\'s notes under it', async () => {
    const repoA = path.join(root, 'repo-a');
    const repoB = path.join(root, 'repo-b');
    gitInit(repoA);
    gitInit(repoB);
    await stop(sessionIn(repoA), repoB);
    expect(stored()).toBeUndefined();
  });

  it('a session that moved to a subdirectory of the same repository still files them, trusted', async () => {
    const repoA = path.join(root, 'repo-a');
    gitInit(repoA);
    fs.mkdirSync(path.join(repoA, 'sub'));
    await stop(sessionIn(repoA), path.join(repoA, 'sub'));
    expect(stored()).toEqual({ trust: 'trusted', project: `project:${getProjectName(repoA)}` });
  });

  it('a session that moved into a repository nested below the one it started in does not file them there', async () => {
    const repoA = path.join(root, 'repo-a');
    gitInit(repoA);
    const nested = path.join(repoA, 'vendor', 'lib');
    fs.mkdirSync(path.join(nested, 'src'), { recursive: true });
    gitInit(nested);
    await stop(sessionIn(repoA), path.join(nested, 'src'));
    expect(stored()).toBeUndefined();
  });

  it('a session that started outside any repository and moved to a subdirectory does not file them there', async () => {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(path.join(plain, 'sub'), { recursive: true });
    await stop(sessionIn(plain), path.join(plain, 'sub'));
    expect(stored()).toBeUndefined();
  });
});
