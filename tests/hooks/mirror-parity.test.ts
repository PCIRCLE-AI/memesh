/**
 * F5 mirror-parity gates — the CI guard the P0 FTS bug proved was missing.
 *
 * `scripts/hooks/_shared.js` hand-mirrors part of `src/core` because hooks must
 * run the always-on capture path even when `dist/` is absent (plugin-marketplace
 * `--ignore-scripts`) or stale. The danger is DRIFT: when the mirror diverges
 * from core, real bugs ship silently. Two divergences matter most:
 *
 *   1. PATHS — if the mirror's DB-path / project-identity logic drifts from
 *      `src/core/paths.ts`, a hook resolves the WRONG database file or WRONG
 *      project and writes memory to the wrong place. Silent corruption.
 *
 *   2. FTS reindex — if the mirror's `captureEntity` FTS dance drifts from
 *      `src/storage/fts-index.ts`, hook-written memory stops being searchable.
 *      This is exactly the P0 (entity+obs written, FTS index skipped).
 *
 * `write-hook-invariants.test.ts` already checks captureEntity FTS-syncs in
 * isolation. THIS file is stronger: it pins the mirror to the CORE source of
 * truth, so a change to `paths.ts` / `fts-index.ts` that forgets the mirror
 * turns CI red. Verified non-vacuous: reintroducing the FTS omission in
 * captureEntity, or changing the mirror's path precedence, fails these tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  memeshDir as coreMemeshDir,
  getDbPath as coreGetDbPath,
  getMemeshDirFromDbPath as coreGetMemeshDirFromDbPath,
  canonicalRemoteLocator as coreCanonicalRemoteLocator,
  getProjectName as coreGetProjectName,
} from '../../src/core/paths.js';
import { removeFromFts, insertFtsRow } from '../../src/storage/fts-index.js';

const require = createRequire(import.meta.url);
// _shared.js is plain JS (hooks cannot import compiled TS) — require it raw.
const shared = require('../../scripts/hooks/_shared.js');

describe('F5 mirror parity: scripts/hooks/_shared.js vs src/core', () => {
  const savedHome = process.env.HOME;
  const savedDbPath = process.env.MEMESH_DB_PATH;

  afterEach(() => {
    // Restore env the path helpers read at call time.
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedDbPath === undefined) delete process.env.MEMESH_DB_PATH;
    else process.env.MEMESH_DB_PATH = savedDbPath;
  });

  describe('paths parity (wrong DB path / project = silent corruption)', () => {
    it('canonicalRemoteLocator matches core for every URL shape', () => {
      const urls = [
        'https://github.com/PCIRCLE-AI/memesh-llm-memory.git',
        'https://github.com/PCIRCLE-AI/memesh-llm-memory',
        'git@github.com:PCIRCLE-AI/memesh-llm-memory.git',
        'https://gitlab.com/group/subgroup/project.git',
        'ssh://git@example.com:2222/team/repo.git',
        'not-a-url',
        '',
      ];
      for (const url of urls) {
        expect(shared.canonicalRemoteLocator(url), `remote locator drift for ${JSON.stringify(url)}`)
          .toBe(coreCanonicalRemoteLocator(url));
      }
    });

    it('memeshDir matches core (MEMESH_DB_PATH unset, HOME redirected)', () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-parity-home-'));
      try {
        delete process.env.MEMESH_DB_PATH;
        process.env.HOME = tmpHome;
        expect(shared.memeshDir()).toBe(coreMemeshDir());
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });

    it('getDbPath matches core with and without MEMESH_DB_PATH override', () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-parity-home-'));
      try {
        // (a) no override — derived from HOME.
        delete process.env.MEMESH_DB_PATH;
        process.env.HOME = tmpHome;
        expect(shared.getDbPath()).toBe(coreGetDbPath());

        // (b) explicit override wins identically on both sides.
        const override = path.join(tmpHome, 'custom', 'kg.db');
        process.env.MEMESH_DB_PATH = override;
        expect(shared.getDbPath()).toBe(coreGetDbPath());
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });

    it('getMemeshDirFromDbPath matches core (override set and unset)', () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-parity-home-'));
      try {
        process.env.HOME = tmpHome;
        const override = path.join(tmpHome, 'nested', 'kg.db');
        process.env.MEMESH_DB_PATH = override;
        expect(shared.getMemeshDirFromDbPath()).toBe(coreGetMemeshDirFromDbPath());

        delete process.env.MEMESH_DB_PATH;
        expect(shared.getMemeshDirFromDbPath()).toBe(coreGetMemeshDirFromDbPath());
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });

    it('getProjectName matches core for the same working directory', () => {
      // Both read git identity for the same cwd; they must agree. This repo is
      // a git checkout, so the real remote/dir-name path is exercised.
      const cwd = process.cwd();
      expect(shared.getProjectName(cwd)).toBe(coreGetProjectName(cwd));
    });
  });

  describe('FTS reindex parity (the P0 class): captureEntity vs core fts-index', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-parity-fts-'));
    });
    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    /** Open a fresh hook DB (creates entities/observations/tags/entities_fts). */
    function openDb(file: string) {
      const handle = shared.openHookDb({ ...process.env, MEMESH_DB_PATH: file }, { fts: true });
      expect(handle).not.toBeNull();
      return handle.db;
    }

    /** rowids that MATCH a token in entities_fts, sorted for comparison. */
    function ftsMatch(db: any, token: string): number[] {
      return (db.prepare("SELECT rowid FROM entities_fts WHERE entities_fts MATCH ?").all(token) as Array<{ rowid: number }>)
        .map((r) => r.rowid)
        .sort((a, b) => a - b);
    }

    /** Reference write via the CORE primitive (what captureEntity must equal). */
    function coreWrite(db: any, name: string, type: string, observations: string[]): number {
      db.prepare('INSERT OR IGNORE INTO entities (name, type) VALUES (?, ?)').run(name, type);
      const id = (db.prepare('SELECT id FROM entities WHERE name = ?').get(name) as { id: number }).id;
      const insertObs = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
      for (const o of observations) insertObs.run(id, o);
      insertFtsRow(db, id, name, observations.join(' '));
      return id;
    }

    it('new-entity FTS state is identical to the core insertFtsRow path', () => {
      const observations = ['the quick brown zebra', 'jumped the fence at dawn'];

      const hookDb = openDb(path.join(tmpDir, 'hook.db'));
      const coreDb = openDb(path.join(tmpDir, 'core.db'));
      try {
        const hookRes = shared.captureEntity(hookDb, { name: 'e1', type: 'note', observations });
        const coreId = coreWrite(coreDb, 'e1', 'note', observations);

        for (const token of ['zebra', 'fence', 'dawn', 'brown']) {
          expect(ftsMatch(hookDb, token), `token ${token} drift`).toEqual(ftsMatch(coreDb, token));
        }
        // Both index the same single rowid.
        expect(ftsMatch(hookDb, 'zebra')).toEqual([hookRes.id]);
        expect(ftsMatch(coreDb, 'zebra')).toEqual([coreId]);
      } finally {
        hookDb.close();
        coreDb.close();
      }
    });

    it('re-index (existing entity) FTS state matches core remove+insert', () => {
      const first = ['alpha bravo charlie'];
      const second = ['delta echo foxtrot'];

      const hookDb = openDb(path.join(tmpDir, 'hook.db'));
      const coreDb = openDb(path.join(tmpDir, 'core.db'));
      try {
        // First write.
        shared.captureEntity(hookDb, { name: 'e1', type: 'note', observations: first });
        const coreId = coreWrite(coreDb, 'e1', 'note', first);

        // Second write to the SAME entity — captureEntity does delete-then-insert.
        shared.captureEntity(hookDb, { name: 'e1', type: 'note', observations: second });
        // Core reference: remove stale FTS, add the new observation, reindex full set.
        removeFromFts(coreDb, coreId, 'e1', first.join(' '));
        coreDb.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(coreId, second[0]);
        insertFtsRow(coreDb, coreId, 'e1', [...first, ...second].join(' '));

        // Old and new tokens must resolve identically on both sides — and the
        // stale index must NOT double-count (the reindex delete worked).
        for (const token of ['alpha', 'charlie', 'delta', 'foxtrot']) {
          expect(ftsMatch(hookDb, token), `token ${token} drift`).toEqual(ftsMatch(coreDb, token));
        }
      } finally {
        hookDb.close();
        coreDb.close();
      }
    });

    it('title fold parity: both sides index and un-index the title identically', () => {
      // UX-1 folds the title into the FTS feed. Contentless FTS5 makes the
      // fold a two-sided contract: the delete must be issued with the exact
      // folded text that was inserted. If the hook mirror folds on insert but
      // not on delete (or vice versa), a re-title leaves stale tokens behind
      // on one side only — precisely the drift class this file exists for.
      const observations = ['plain observation text'];

      const hookDb = openDb(path.join(tmpDir, 'hook.db'));
      const coreDb = openDb(path.join(tmpDir, 'core.db'));
      try {
        const hookRes = shared.captureEntity(hookDb, {
          name: 'e1', type: 'note', observations, title: 'walrus label one',
        });
        // Core reference: same write via the core primitives.
        coreDb.prepare('INSERT INTO entities (name, type, title) VALUES (?, ?, ?)').run('e1', 'note', 'walrus label one');
        const coreId = (coreDb.prepare("SELECT id FROM entities WHERE name = 'e1'").get() as { id: number }).id;
        coreDb.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(coreId, observations[0]);
        insertFtsRow(coreDb, coreId, 'e1', observations.join(' '), 'walrus label one');

        expect(ftsMatch(hookDb, 'walrus')).toEqual([hookRes.id]);
        expect(ftsMatch(coreDb, 'walrus')).toEqual([coreId]);
        // Anti-vacuity pin: the emptiness assertion after the re-title below
        // only means something because the token demonstrably WAS indexed.
        expect(ftsMatch(hookDb, 'walrus').length).toBe(1);

        // Re-title on both sides; the OLD title's tokens must vanish on both.
        shared.captureEntity(hookDb, {
          name: 'e1', type: 'note', observations: [], title: 'penguin label two',
        });
        removeFromFts(coreDb, coreId, 'e1', observations.join(' '), 'walrus label one');
        coreDb.prepare('UPDATE entities SET title = ? WHERE id = ?').run('penguin label two', coreId);
        insertFtsRow(coreDb, coreId, 'e1', observations.join(' '), 'penguin label two');

        for (const token of ['walrus', 'penguin', 'plain']) {
          expect(ftsMatch(hookDb, token), `token ${token} drift`).toEqual(ftsMatch(coreDb, token));
        }
        expect(ftsMatch(hookDb, 'walrus')).toEqual([]);
      } finally {
        hookDb.close();
        coreDb.close();
      }
    });
  });

  describe('query-side parity', () => {
    /**
     * The comments in _shared.js claimed the segmentation version and the hook
     * match builder were "pinned by tests/hooks/mirror-parity.test.ts". They
     * were not — this file never mentioned them, and the two implementations
     * had already drifted: the hook copy omitted the lone-unspaced-character
     * prefix branch, so a single CJK character in a filename was emitted as an
     * exact token and matched nothing against a bigram index.
     *
     * A claimed gate that does not exist is worse than no gate, so these are
     * the assertions the comment was describing.
     */
    it('the hook knows the same segmentation version core writes', async () => {
      const core = await import('../../src/db.js');
      expect(shared.FTS_SEGMENTATION_VERSION).toBe(core.FTS_SEGMENTATION_VERSION);
    });

    it('the hook builds the same MATCH expression core does', async () => {
      const fts = await import('../../src/storage/fts-index.js');

      // Every shape that has bitten: ASCII, an unbroken CJK run, a LONE CJK
      // character (the drift), mixed script, and an empty result.
      for (const query of ['SkillOpt codex', '資料庫遷移', 'v2-图-final', '用 Preact 做儀表板', '???']) {
        const coreTerms = fts.tokenizeQuery(query).slice(0, 32);
        const expected = fts.renderMatchExpression(coreTerms);
        expect(shared.hookMatchExpression(query)).toBe(expected);
      }
    });

    it('a lone CJK character becomes a prefix query on the hook side too', async () => {
      // Named separately because this is the case that was broken, and an
      // equality test against core would silently start passing if BOTH sides
      // regressed together.
      expect(shared.hookMatchExpression('v2-图-final')).toContain('"图"*');
    });
  });

  // #360, cross-model review round 1, item 5: briefing-level.ts is copied
  // VERBATIM to _generated/briefing-level.js (no hand-mirror, unlike the
  // paths/FTS logic above) — but the source of the copy is dist/, one build
  // step removed from src/. A mutation to src/core/briefing-level.ts that is
  // never rebuilt leaves _generated/briefing-level.js (and
  // dist/core/briefing-level.js) silently answering the OLD policy: the
  // TS-importing side (briefing.ts, and anything vitest transforms directly
  // from src/) sees the mutation immediately, the hook — which can only ever
  // import the generated copy — does not, and nothing above in this file
  // would have caught that split, because this file's coverage stops at
  // paths/FTS/query segmentation. This closes that gap directly: compare the
  // generated mirror's answer against the TS source's answer for every
  // level, so a source edit landing without `npm run build` /
  // generate-hook-core.mjs turns THIS file red instead of dist/'s staleness
  // being the only thing that would have caught it
  // (scripts/check-generated-mirror.mjs, a separate, not-always-run gate).
  describe('briefing-level parity (#360)', () => {
    it('the generated mirror answers the same policy as core for every level', async () => {
      const core = await import('../../src/core/briefing-level.js');
      for (const level of core.BRIEFING_LEVELS) {
        expect(shared.briefingLevelPolicy(level), `policy drift at level "${level}"`)
          .toEqual(core.briefingLevelPolicy(level));
      }
    });

    it('the generated mirror agrees on the level list, the default and validity', async () => {
      const core = await import('../../src/core/briefing-level.js');
      expect(shared.DEFAULT_BRIEFING_LEVEL).toBe(core.DEFAULT_BRIEFING_LEVEL);
      for (const level of ['minimal', 'standard', 'full', 'banana', '', 'FULL']) {
        expect(shared.isBriefingLevel(level), `isBriefingLevel drift for ${JSON.stringify(level)}`)
          .toBe(core.isBriefingLevel(level));
      }
    });

    // Round 5 (Codex round 4 re-review, finding 1): the new named predicate
    // — `session-start.js`'s ONLY call site for "should the notice be
    // appended at this level" — must answer identically from the generated
    // mirror and from core, for every level, same as `briefingLevelPolicy`
    // itself above.
    it('the generated mirror\'s sessionStartAppendsWorkPackageNotice agrees with core for every level', async () => {
      const core = await import('../../src/core/briefing-level.js');
      for (const level of core.BRIEFING_LEVELS) {
        expect(shared.sessionStartAppendsWorkPackageNotice(level), `workPackageNotice drift at level "${level}"`)
          .toBe(core.sessionStartAppendsWorkPackageNotice(level));
      }
    });
  });

  // #360 round 6 (Codex round 5 re-review, item 2): `_shared.js`'s
  // `HOOK_CONFIG_UNREADABLE_REASON` is NOT a byte-copy of core's
  // `warnUnreadable()` message on purpose — that one prints the real file
  // path and the raw parse-error text, which this hook-side reason is
  // explicitly forbidden from doing (it can quote the file). This is a
  // WEAKER, deliberate check: both describe the exact same event, so they
  // must still share the core descriptive phrase — if a future edit to
  // either message drops it, this test is the one thing that would notice
  // the two silently describing the same state in unrecognisably different
  // words.
  describe('config-unreadable wording parity (#360 round 6)', () => {
    it('the hook-side reason and the real core stderr trace share the same descriptive phrase', async () => {
      const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cfg-parity-'));
      const previousDir = process.env.MEMESH_DIR;
      process.env.MEMESH_DIR = configDir;
      fs.writeFileSync(path.join(configDir, 'config.json'), '{ broken');
      const writes: string[] = [];
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });
      let coreState: string;
      try {
        const core = await import('../../src/core/config.js');
        coreState = core.readConfigResult().state;
      } finally {
        spy.mockRestore();
        if (previousDir === undefined) delete process.env.MEMESH_DIR;
        else process.env.MEMESH_DIR = previousDir;
        fs.rmSync(configDir, { recursive: true, force: true });
      }
      expect(coreState).toBe('unreadable');
      const coreMessage = writes.find((line) => line.includes('[memesh config]'));
      expect(coreMessage, 'core must have traced something for the corrupt file').toBeTruthy();
      const SHARED_PHRASE = 'could not be read as a settings object';
      expect(coreMessage).toContain(SHARED_PHRASE);
      expect(shared.HOOK_CONFIG_UNREADABLE_REASON).toContain(SHARED_PHRASE);
    });
  });

  // #431 — session-limit.ts is copied VERBATIM to _generated/session-limit.js
  // (no hand-mirror, same as briefing-level.ts above), from dist/, one build
  // step removed from src/. A mutation to src/core/session-limit.ts that is
  // never rebuilt leaves the generated copy silently answering the OLD
  // policy: the TS-importing side (`core`, below) sees the mutation
  // immediately; the hook — which can only ever import the generated copy —
  // does not. This closes that gap directly: compare the generated mirror's
  // answer against the TS source's answer for the constants and for the
  // resolver across every case that has mattered so far (valid, clamped
  // above the max, fallen back below it or on a non-integer, and the
  // env-then-config precedence), so a source edit landing without
  // `npm run build` / generate-hook-core.mjs turns THIS file red.
  describe('session-limit parity (#431)', () => {
    it('the generated mirror agrees on the range and the default', async () => {
      const core = await import('../../src/core/session-limit.js');
      expect(shared.SESSION_LIMIT_MIN).toBe(core.SESSION_LIMIT_MIN);
      expect(shared.SESSION_LIMIT_MAX).toBe(core.SESSION_LIMIT_MAX);
      expect(shared.SESSION_LIMIT_DEFAULT).toBe(core.SESSION_LIMIT_DEFAULT);
      for (const n of [0, 1, 50, 100, 101, -5, 2.5, NaN]) {
        expect(shared.isSessionLimitInRange(n), `isSessionLimitInRange drift for ${n}`).toBe(core.isSessionLimitInRange(n));
      }
    });

    it('the generated mirror resolves the same value and adjustments as core, for every case', async () => {
      const core = await import('../../src/core/session-limit.js');
      const cases: Array<[string | undefined, unknown]> = [
        [undefined, undefined],
        [undefined, 25],
        [undefined, 500],
        [undefined, 0],
        [undefined, 2.5],
        ['1e3', undefined],
        ['150abc', 25],
        ['50.9', 25],
        ['500', 500],
        ['50', 500],
      ];
      for (const [envRaw, configValue] of cases) {
        expect(
          shared.resolveSessionLimitCore(envRaw, configValue),
          `resolveSessionLimit drift for env=${JSON.stringify(envRaw)} config=${JSON.stringify(configValue)}`,
        ).toEqual(core.resolveSessionLimit(envRaw, configValue));
      }
    });
  });

});
