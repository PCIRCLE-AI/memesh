import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { MemeshDatabase } from '../../src/storage/sqlite.js';
import { SKIP_REASONS } from '../../src/core/capture-liveness.js';

const require = createRequire(import.meta.url);
const HOOK = path.resolve('scripts/hooks/prompt-recall.js');

// A real process against a throwaway HOME and database. The database is seeded
// through the product's own writer so its full-text index is the real one.
// Most tests call the hook's own entry point (`handlePrompt`); one block runs the
// whole hook process.
describe('Feature: prompt-time recall hook', () => {
  let home: string;
  let project: string;
  let dbPath: string;
  let memeshDir: string;

  const MATCHING = 'should storage use node:sqlite or better-sqlite3 here?';
  const UNRELATED = 'what is the weather like in Taipei tomorrow afternoon';

  function seed(projectTag: string | null = `project:${require('../../scripts/hooks/_shared.js').getProjectName(project)}`): { decisionId: number } {
    openDatabase(dbPath);
    try {
      const kg = new KnowledgeGraph(getDatabase());
      const decisionId = kg.createEntity('storage-driver-decision', 'decision', {
        title: 'Use node:sqlite instead of better-sqlite3 for storage',
        observations: [
          'Storage uses the built-in node:sqlite driver rather than better-sqlite3.',
          'Why: the native build broke on three platforms; revisit if node:sqlite is removed.',
        ],
        tags: projectTag ? [projectTag] : [],
      });
      kg.createEntity('billing-notes', 'note', {
        title: 'Invoice rounding follows banker rounding',
        observations: ['Invoices round half to even.'],
        tags: projectTag ? [projectTag] : [],
      });
      return { decisionId };
    } finally {
      closeDatabase();
    }
  }

  const DRIVER = `
    import { handlePrompt } from ${JSON.stringify(path.resolve('scripts/hooks/prompt-recall.js'))};
    const out = await handlePrompt(JSON.parse(process.env.PAYLOAD));
    process.stdout.write(out ?? '');
  `;

  function run(prompt: string, extra: Record<string, unknown> = {}, session = 'sess-a') {
    const result = spawnSync('node', ['--input-type=module', '-e', DRIVER], {
      env: {
        ...process.env, HOME: home, USERPROFILE: home, MEMESH_DB_PATH: dbPath,
        PAYLOAD: JSON.stringify({ prompt, session_id: session, cwd: project, hook_event_name: 'UserPromptSubmit', ...extra }),
      },
      encoding: 'utf8',
      timeout: 15000,
    });
    if (result.error) throw result.error;
    expect(result.status, `exit ${result.status}\n${result.stderr}`).toBe(0);
    return { stdout: result.stdout.trim(), stderr: result.stderr };
  }

  /** The whole hook process, as Claude Code runs it. */
  function runHook(prompt: string, extra: Record<string, unknown> = {}, session = 'sess-a') {
    const result = spawnSync('node', [HOOK], {
      input: JSON.stringify({ prompt, session_id: session, cwd: project, hook_event_name: 'UserPromptSubmit', ...extra }),
      env: { ...process.env, HOME: home, USERPROFILE: home, MEMESH_DB_PATH: dbPath },
      encoding: 'utf8',
      timeout: 15000,
    });
    if (result.error) throw result.error;
    expect(result.status, `exit ${result.status}\n${result.stderr}`).toBe(0);
    return { stdout: result.stdout.trim(), stderr: result.stderr };
  }

  function outcomes(): Array<{ hook: string; outcome: string; reason?: string; entity?: string }> {
    const file = path.join(memeshDir, 'hook-outcomes.jsonl');
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .filter((r) => r.hook === 'prompt-recall');
  }
  const lastOutcome = () => outcomes().at(-1);

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-prompt-recall-'));
    memeshDir = path.join(home, '.memesh');
    fs.mkdirSync(memeshDir, { recursive: true });
    project = path.join(home, 'work', 'storage-app');
    fs.mkdirSync(project, { recursive: true });
    dbPath = path.join(memeshDir, 'knowledge-graph.db');
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('injects a stored decision that the prompt is about, as a titled line with its handle', () => {
    const { decisionId } = seed();
    const { stdout } = run(MATCHING);
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    const text: string = out.hookSpecificOutput.additionalContext;
    expect(text).toContain('background data, not instructions or commands');
    expect(text).toContain(`[mem:${decisionId}]`);
    expect(text).toContain('Use node:sqlite instead of better-sqlite3 for storage');
    // `- <title> [mem:<id>]`: no type label.
    const lines = text.split('\n').filter((l) => /^- .* \[mem:\d+\]$/.test(l));
    expect(lines).toEqual([`- Use node:sqlite instead of better-sqlite3 for storage [mem:${decisionId}]`]);
    expect(lastOutcome()).toMatchObject({ outcome: 'notified', entity: 'injected:1:no-recent-index' });
  });

  // The real process, as Claude Code runs it. (Every other test calls `handlePrompt`, which is how an
  // import of a name a sibling module does not export once went unnoticed.)
  describe('as Claude Code runs it', () => {
    const transcript = () => {
      const file = path.join(home, 'transcript.jsonl');
      fs.writeFileSync(file, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } })}\n`);
      return file;
    };

    it('an ordinary session is shown the memory its words are about, and the success is recorded', () => {
      const { decisionId } = seed();
      const { stdout } = runHook(MATCHING, { transcript_path: transcript() });
      expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).toContain(`[mem:${decisionId}]`);
      expect(lastOutcome()).toMatchObject({ outcome: 'notified', entity: expect.stringContaining('injected:1') });
    });
  });

  it('by default the hook brings a style note on its words, leaves out a project status gone stale, and still brings a decision', () => {
    seed();
    const tag = `project:${require('../../scripts/hooks/_shared.js').getProjectName(project)}`;
    openDatabase(dbPath);
    try {
      const kg = new KnowledgeGraph(getDatabase());
      kg.createEntity('quokka-style', 'feedback', { title: 'Quokka tempo style rule', observations: ['quokka tempo style rule for answers'], tags: [tag] });
      kg.createEntity('quokka-status', 'project', { title: 'Quokka tempo status', observations: ['quokka tempo status unresolved'], tags: [tag] });
      kg.createEntity('quokka-decision', 'decision', { title: 'Quokka tempo decision', observations: ['quokka tempo decision made', 'Why: measured; revisit if it changes.'], tags: [tag] });
      getDatabase().prepare("UPDATE observations SET created_at = ? WHERE entity_id = (SELECT id FROM entities WHERE name = 'quokka-status')")
        .run(new Date(Date.now() - 90 * 86_400_000).toISOString().replace('T', ' ').slice(0, 19));
    } finally {
      closeDatabase();
    }
    const text: string = JSON.parse(run('quokka tempo decision made').stdout).hookSpecificOutput.additionalContext;
    expect(text).toContain('Quokka tempo decision');
    expect(text).not.toContain('Quokka tempo status');
    const style: string = JSON.parse(run('quokka tempo style rule answers', {}, 'sess-style').stdout).hookSpecificOutput.additionalContext;
    expect(style).toContain('Quokka tempo style rule');
    expect(style).not.toContain('Quokka tempo status');
  });

  it('a match a newer decision in the session-start index replaces is not brought along, and the skip says why', () => {
    const tag = `project:${require('../../scripts/hooks/_shared.js').getProjectName(project)}`;
    openDatabase(dbPath);
    let olderId: number;
    try {
      const kg = new KnowledgeGraph(getDatabase());
      olderId = kg.createEntity('plan-roles-old', 'decision', { title: 'Codex runs the upgrade plan', observations: ['zebrafish quokka marmot handover'], tags: [tag] });
      kg.createEntity('plan-roles-new', 'decision', { title: 'Claude runs the upgrade plan', observations: ['ownership moved'], tags: [tag] });
      getDatabase().prepare("UPDATE entities SET created_at = datetime('now', '-1 day') WHERE name = 'plan-roles-old'").run();
      getDatabase().prepare("UPDATE observations SET created_at = datetime('now', '-1 day') WHERE entity_id = ?").run(olderId);
    } finally {
      closeDatabase();
    }
    // Session start records the unfiltered index the prompt hook compares with.
    const start = spawnSync('node', [path.resolve('scripts/hooks/session-start.js')], {
      input: JSON.stringify({ cwd: project, session_id: 'sess-a' }),
      env: { ...process.env, HOME: home, USERPROFILE: home, MEMESH_DB_PATH: dbPath },
      encoding: 'utf8',
      timeout: 15000,
    });
    expect(start.status).toBe(0);
    const { stdout } = run('zebrafish quokka marmot handover');
    expect(stdout).toBe('');
    expect(lastOutcome()).toMatchObject({ hook: 'prompt-recall', outcome: 'skipped', reason: SKIP_REASONS.promptStale });
    // Without the session's index the older decision has nothing to compare with, and is brought along.
    const fresh = run('zebrafish quokka marmot handover', {}, 'sess-other');
    expect(fresh.stdout).toContain(`[mem:${olderId}]`);
    expect(lastOutcome()).toMatchObject({ outcome: 'notified', entity: 'injected:1:no-recent-index' });
  });

  it('prints nothing at all for a prompt no memory is about, and records the skip', () => {
    seed();
    const { stdout } = run(UNRELATED);
    expect(stdout).toBe('');
    expect(lastOutcome()).toMatchObject({ outcome: 'skipped', reason: SKIP_REASONS.promptNoTerms });
  });

  it('needs the prompt to be mostly about the memory: sharing a couple of its words is not enough', () => {
    openDatabase(dbPath);
    try {
      const kg = new KnowledgeGraph(getDatabase());
      const tag = `project:${require('../../scripts/hooks/_shared.js').getProjectName(project)}`;
      kg.createEntity('alpha-note', 'reference', { title: 'Alpha beta gamma delta rollout', observations: ['alpha beta gamma delta'], tags: [tag] });
      kg.createEntity('epsilon-note', 'reference', { title: 'Epsilon zeta theta iota rollout', observations: ['epsilon zeta theta iota'], tags: [tag] });
      kg.createEntity('kappa-note', 'reference', { title: 'Kappa lambda omicron sigma rollout', observations: ['kappa lambda omicron sigma'], tags: [tag] });
    } finally {
      closeDatabase();
    }
    // A third of this prompt is about each memory: none is what it is about.
    expect(run('alpha beta epsilon zeta kappa lambda').stdout).toBe('');
    expect(lastOutcome()).toMatchObject({ outcome: 'skipped', reason: SKIP_REASONS.promptNoMatch });
    // One shared word is a topic, not a match.
    expect(run('alpha').stdout).toBe('');
    // Three quarters of this one is about the first.
    const strong = JSON.parse(run('alpha beta gamma epsilon').stdout).hookSpecificOutput.additionalContext as string;
    expect(strong).toContain('Alpha beta gamma delta rollout');
    expect(strong).not.toContain('Epsilon zeta');
  });

  it('never brings along more than two memories', () => {
    openDatabase(dbPath);
    try {
      const kg = new KnowledgeGraph(getDatabase());
      const tag = `project:${require('../../scripts/hooks/_shared.js').getProjectName(project)}`;
      for (let i = 0; i < 6; i++) kg.createEntity(`mauve-${i}`, 'reference', { title: `Mauve falcon harbor entry ${i}`, observations: ['mauve falcon harbor'], tags: [tag] });
    } finally {
      closeDatabase();
    }
    const text = JSON.parse(run('mauve falcon harbor').stdout).hookSpecificOutput.additionalContext as string;
    expect(text.split('\n').filter((l) => /^- .* \[mem:\d+\]$/.test(l))).toHaveLength(2);
  });

  it('does not repeat an id within a session, but shows it again to a new session', () => {
    seed();
    expect(run(MATCHING).stdout).not.toBe('');
    const again = run('remind me why storage moved to node:sqlite from better-sqlite3');
    expect(again.stdout).toBe('');
    expect(lastOutcome()).toMatchObject({ outcome: 'skipped', reason: SKIP_REASONS.promptAlreadyShown });
    expect(run(MATCHING, {}, 'sess-b').stdout).not.toBe('');
  });

  it('still never repeats an id when the injection record cannot be written', () => {
    seed();
    // A file where the sessions folder should be: the record cannot be updated.
    fs.writeFileSync(path.join(memeshDir, 'sessions'), 'not a folder');
    expect(run(MATCHING).stdout).not.toBe('');
    expect(lastOutcome()).toMatchObject({ outcome: 'notified', entity: 'injected:1:uncredited:no-recent-index' });
    expect(run('remind me why storage moved to node:sqlite from better-sqlite3').stdout).toBe('');
    expect(lastOutcome()).toMatchObject({ outcome: 'skipped', reason: SKIP_REASONS.promptAlreadyShown });
  });

  it('adds the injected id to the session injection record so a citation is credited', () => {
    const { decisionId } = seed();
    run(MATCHING);
    const dir = path.join(memeshDir, 'sessions');
    const records = fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    expect(records).toHaveLength(1);
    expect(records[0].entityIds).toContain(decisionId);
    expect(records[0].sessionId).toBe('sess-a');
  });

  it('does not show what session start already showed', () => {
    const { decisionId } = seed();
    const sessions = path.join(memeshDir, 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    const { recallSessionPath, getProjectName } = require('../../scripts/hooks/_shared.js');
    const name = getProjectName(project);
    fs.writeFileSync(recallSessionPath(sessions, 'sess-a', name), JSON.stringify({
      sessionId: 'sess-a', project: name, injectedAt: new Date().toISOString(),
      entityIds: [decisionId], entityNames: ['storage-driver-decision'], creditedIds: [], sessionCounted: false,
    }));
    expect(run(MATCHING).stdout).toBe('');
    expect(lastOutcome()).toMatchObject({ outcome: 'skipped', reason: SKIP_REASONS.promptAlreadyShown });
  });

  describe('switches', () => {
    it('stays silent and records why when promptRecall is false in the config', () => {
      seed();
      fs.writeFileSync(path.join(memeshDir, 'config.json'), JSON.stringify({ promptRecall: false }));
      expect(run(MATCHING).stdout).toBe('');
      expect(lastOutcome()).toMatchObject({ outcome: 'skipped', reason: SKIP_REASONS.promptRecallOff });
    });

    it('is on when the config does not mention it', () => {
      seed();
      fs.writeFileSync(path.join(memeshDir, 'config.json'), JSON.stringify({ sessionLimit: 5 }));
      expect(run(MATCHING).stdout).not.toBe('');
    });

    it('stays silent and records why when auto-capture is off', () => {
      seed();
      fs.writeFileSync(path.join(memeshDir, 'config.json'), JSON.stringify({ autoCapture: false }));
      expect(run(MATCHING).stdout).toBe('');
      expect(lastOutcome()).toMatchObject({ outcome: 'skipped', reason: SKIP_REASONS.autoCaptureOff });
    });
  });

  describe('never blocks the prompt', () => {
    it('exits 0 with nothing printed when there is no database yet', () => {
      expect(run(MATCHING).stdout).toBe('');
      expect(lastOutcome()).toMatchObject({ outcome: 'skipped', reason: SKIP_REASONS.noDatabaseForRecall });
    });

    it('exits 0 with nothing printed and records an error when the database is unreadable', () => {
      fs.writeFileSync(dbPath, 'this is not a sqlite file at all');
      const { stdout } = run(MATCHING);
      expect(stdout).toBe('');
      expect(lastOutcome()).toMatchObject({ outcome: 'error' });
    });

    it.each([
      ['no tables at all', ''],
      ['a schema that is only partly created', 'CREATE TABLE entities (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, type TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, metadata JSON)'],
    ])('a database with %s has no memories yet: nothing printed, a skip record, no error', (_label, ddl) => {
      const db = new MemeshDatabase(dbPath);
      if (ddl) db.exec(ddl);
      db.close();
      const { stdout, stderr } = run(MATCHING);
      expect(stdout).toBe('');
      expect(stderr).not.toContain('no such table');
      expect(outcomes().filter((o) => o.outcome === 'error')).toEqual([]);
      expect(lastOutcome()).toMatchObject({ outcome: 'skipped', reason: SKIP_REASONS.promptNoMatch });
    });

    it('records a malformed payload and an empty prompt', () => {
      const bad = spawnSync('node', [HOOK], { input: '{not json', env: { ...process.env, HOME: home, MEMESH_DB_PATH: dbPath }, encoding: 'utf8' });
      expect(bad.status).toBe(0);
      expect(bad.stdout).toBe('');
      expect(lastOutcome()).toMatchObject({ outcome: 'error' });
      const literalNull = spawnSync('node', [HOOK], { input: 'null', env: { ...process.env, HOME: home, MEMESH_DB_PATH: dbPath }, encoding: 'utf8' });
      expect(literalNull.status).toBe(0);
      expect(lastOutcome()).toMatchObject({ outcome: 'error' });
      expect(run('   ').stdout).toBe('');
      expect(lastOutcome()).toMatchObject({ outcome: 'skipped', reason: SKIP_REASONS.promptEmpty });
    });

    it('refuses a session id that is not safe to use as a file name', () => {
      seed();
      expect(run(MATCHING, {}, '../../escape').stdout).toBe('');
      expect(lastOutcome()).toMatchObject({ outcome: 'skipped', reason: SKIP_REASONS.noSessionId });
      expect(fs.existsSync(path.join(home, 'escape.json'))).toBe(false);
    });
  });

  describe('scope', () => {
    it('does not show another project\'s memory', () => {
      seed('project:some-other-project~0123456789abcdef0123456789abcdef');
      expect(run(MATCHING).stdout).toBe('');
    });

    it('in a checkout with a remote, both hooks show memories under its path id, and neither shows a same-name repository\'s', () => {
      expect(spawnSync('git', ['init', '-q', project]).status).toBe(0);
      expect(spawnSync('git', ['-C', project, 'remote', 'add', 'origin', 'https://github.com/acme/storage-app.git']).status).toBe(0);
      // The id this folder had before it got a remote, computed here rather than by the product.
      const pathId = `storage-app~${createHash('sha256').update(fs.realpathSync.native(project)).digest('hex').slice(0, 32)}`;
      const { decisionId } = seed(`project:${pathId}`);
      openDatabase(dbPath);
      let foreignId: number;
      try {
        foreignId = new KnowledgeGraph(getDatabase()).createEntity('foreign-storage', 'decision', {
          title: 'Use better-sqlite3 instead of node:sqlite for storage',
          observations: ['Storage keeps better-sqlite3 over node:sqlite here.'],
          tags: ['project:storage-app~0123456789abcdef0123456789abcdef'],
        });
      } finally {
        closeDatabase();
      }
      const start = spawnSync('node', [path.resolve('scripts/hooks/session-start.js')], {
        input: JSON.stringify({ cwd: project, session_id: 'sess-a' }),
        env: { ...process.env, HOME: home, USERPROFILE: home, MEMESH_DB_PATH: dbPath },
        encoding: 'utf8',
        timeout: 15000,
      });
      expect(start.status, start.stderr).toBe(0);
      expect(start.stdout).toContain(`[mem:${decisionId}]`);
      expect(start.stdout).not.toContain(`[mem:${foreignId}]`);
      const text = JSON.parse(run(MATCHING, {}, 'sess-b').stdout).hookSpecificOutput.additionalContext as string;
      expect(text).toContain(`[mem:${decisionId}]`);
      expect(text).not.toContain(`[mem:${foreignId}]`);
    });

    it('shows a memory that belongs to no project, but not one scoped to a host or agent', () => {
      openDatabase(dbPath);
      try {
        const kg = new KnowledgeGraph(getDatabase());
        kg.createEntity('free-pref', 'preference', { title: 'Storage code prefers node:sqlite over better-sqlite3', observations: ['Prefer node:sqlite over better-sqlite3 for storage code.'] });
        kg.createEntity('host-pref', 'preference', { title: 'Hermes storage notes mention node:sqlite and better-sqlite3', observations: ['Hermes storage node:sqlite better-sqlite3 notes.'], tags: ['platform:hermes'] });
      } finally {
        closeDatabase();
      }
      const text = JSON.parse(run(MATCHING).stdout).hookSpecificOutput.additionalContext as string;
      expect(text).toContain('Storage code prefers node:sqlite');
      expect(text).not.toContain('Hermes');
    });

    it('never injects a work record by type alone, nor anything the capture hooks tagged', () => {
      openDatabase(dbPath);
      try {
        const kg = new KnowledgeGraph(getDatabase());
        // A commit nobody tagged: excluded by its type.
        kg.createEntity('commit-explicit', 'commit', { title: 'switch storage to node:sqlite from better-sqlite3', observations: ['switch storage to node:sqlite from better-sqlite3'] });
        // A note the hooks tagged: excluded by the tag.
        kg.createEntity('tagged-note', 'note', { title: 'storage moved to node:sqlite from better-sqlite3', observations: ['storage moved to node:sqlite from better-sqlite3'], tags: ['source:auto-capture'] });
      } finally {
        closeDatabase();
      }
      expect(run(MATCHING).stdout).toBe('');
    });

    it('never injects an untrusted or imported memory unasked', () => {
      openDatabase(dbPath);
      try {
        const db = getDatabase();
        const kg = new KnowledgeGraph(db);
        kg.createEntity('untrusted-ref', 'reference', { title: 'storage uses node:sqlite not better-sqlite3', observations: ['storage uses node:sqlite not better-sqlite3'] });
        kg.createEntity('imported-ref', 'reference', { title: 'storage chose node:sqlite over better-sqlite3', observations: ['storage chose node:sqlite over better-sqlite3'] });
        db.prepare("UPDATE entities SET metadata = ? WHERE name = 'untrusted-ref'").run(JSON.stringify({ trust: 'untrusted' }));
        db.prepare("UPDATE entities SET metadata = ? WHERE name = 'imported-ref'").run(JSON.stringify({ provenance: { source: 'import' } }));
      } finally {
        closeDatabase();
      }
      expect(run(MATCHING).stdout).toBe('');
    });

    it('never injects auto-captured work records', () => {
      openDatabase(dbPath);
      try {
        new KnowledgeGraph(getDatabase()).createEntity('commit-abc1234', 'commit', {
          title: 'switch storage to node:sqlite from better-sqlite3',
          observations: ['switch storage to node:sqlite from better-sqlite3'],
          tags: ['source:auto-capture'],
        });
      } finally {
        closeDatabase();
      }
      expect(run(MATCHING).stdout).toBe('');
    });
  });
});
