/**
 * #408: memories tagged with a plain project name (`project:acme-private`) are
 * invisible to sessions that resolve the hashed id
 * (`project:acme-private~<hash>`), and nothing said so. Doctor now finds the
 * split, counts the active memories that only the plain name holds, and points
 * at `memesh kg rename-project` — without naming any project, because doctor
 * rows are copied into public feedback issues.
 */
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runDoctor } from '../../src/core/doctor.js';
import { forget, remember } from '../../src/core/operations.js';
import { findProjectIdentitySplits } from '../../src/core/project-identity-split.js';
import { getDatabase } from '../../src/db.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

const dbHandle = useTestDatabase('memesh-project-split-doctor-');

afterEach(() => {
  expect(dbHandle.dbPath.endsWith('test.db')).toBe(true);
});

const PLAIN = 'acme-private';
const ID = `${PLAIN}~${'a'.repeat(32)}`;
const OTHER_ID = `${PLAIN}~${'b'.repeat(32)}`;

function doctor() {
  return runDoctor({
    packageRoot: process.cwd(),
    packageVersion: 'test',
    openDatabaseImpl: () => getDatabase(),
    closeDatabaseImpl: () => undefined,
    isDatabaseOpenImpl: () => true,
    getConfigPathImpl: () => path.join(dbHandle.tmpDir, 'config.json'),
    getUpdateCheckImpl: async () => ({ checkSucceeded: true, updateAvailable: false }) as never,
    getCurrentInstallChannelImpl: () => 'npm-global',
    getInstallChannelSupportImpl: () => ({ label: 'npm global', canSelfUpdate: false }) as never,
    nativeBindingProbeImpl: () => ({ ok: true }),
    resolveShellMemeshImpl: () => null,
  });
}

const row = async () => (await doctor()).checks.find((check) => check.id === 'project-identity-split');

describe('#408 doctor finds a project split between a plain name and its id', () => {
  it('warns with the count of memories only the plain name holds, and points at kg rename-project', async () => {
    remember({ name: 'hashed-1', type: 'decision', observations: ['o'], tags: [`project:${ID}`] });
    remember({ name: 'plain-1', type: 'decision', observations: ['o'], tags: [`project:${PLAIN}`] });
    remember({ name: 'plain-2', type: 'decision', observations: ['o'], tags: [`project:${PLAIN}`] });
    remember({ name: 'plain-gone', type: 'decision', observations: ['o'], tags: [`project:${PLAIN}`] });
    forget({ name: 'plain-gone' });
    // Carries the id too, so that project already sees it: not counted. Written
    // directly — remember() refuses two project tags now; older builds did not.
    remember({ name: 'both', type: 'decision', observations: ['o'], tags: [`project:${PLAIN}`] });
    getDatabase().prepare("INSERT INTO tags (entity_id, tag) SELECT id, ? FROM entities WHERE name = 'both'").run(`project:${ID}`);

    expect(findProjectIdentitySplits(getDatabase())).toEqual([{ plain: PLAIN, ids: [ID], activeMemories: 2 }]);
    const found = await row();
    expect(found?.status).toBe('warn');
    expect(found?.summary).toMatch(/^2 active memories in 1 project is filed under a plain project name/);
    expect(found?.fix).toContain('`memesh kg rename-project`');
    expect(found?.fix).toContain('--apply');
    expect(found?.fix).toContain('if a different repository used that name, leave it');
  });

  it('names no project in the summary or the fix — they reach public feedback issues', async () => {
    remember({ name: 'hashed-a', type: 'decision', observations: ['o'], tags: [`project:${ID}`] });
    remember({ name: 'hashed-b', type: 'decision', observations: ['o'], tags: [`project:${OTHER_ID}`] });
    remember({ name: 'plain-x', type: 'decision', observations: ['o'], tags: [`project:${PLAIN}`] });
    const found = await row();
    expect(found?.status).toBe('warn');
    expect(`${found?.summary} ${found?.fix}`).not.toContain(PLAIN);
    expect(found?.summary).toMatch(/^1 active memory in 1 project is /);
  });

  it('a tag it cannot read is a warning of its own, and the database row still passes', async () => {
    remember({ name: 'blob-holder', type: 'decision', observations: ['o'] });
    getDatabase().prepare("INSERT INTO tags (entity_id, tag) SELECT id, CAST('project:x' AS BLOB) FROM entities WHERE name = 'blob-holder'").run();
    const result = await doctor();
    expect(result.checks.find((check) => check.id === 'database')?.status).toBe('pass');
    const found = result.checks.find((check) => check.id === 'project-identity-split');
    expect(found?.status).toBe('warn');
    expect(found?.summary).toContain('The project tag check could not run');
  });

  it('is silent for a plain project with no id of the same name, and for a graph with no split', async () => {
    remember({ name: 'plain-only', type: 'decision', observations: ['o'], tags: ['project:standalone'] });
    remember({ name: 'hashed-only', type: 'decision', observations: ['o'], tags: [`project:${ID}`] });
    expect(findProjectIdentitySplits(getDatabase())).toHaveLength(0);
    expect(await row()).toBeUndefined();
  });
});
