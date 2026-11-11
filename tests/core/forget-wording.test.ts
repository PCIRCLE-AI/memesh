/**
 * Forgetting one observation deletes it for good; archiving a whole entity is
 * reversible. The skill and the CLI help used to call both "soft
 * (recoverable)", so an agent would forget a fact expecting to get it back.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { forget, recall, remember } from '../../src/core/operations.js';
import { getDatabase } from '../../src/db.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

const handle = useTestDatabase('memesh-forget-wording-');

describe('what the docs say forget does', () => {
  it('an observation-level forget deletes the text: not even an archived-inclusive recall finds it', () => {
    remember({ name: 'wording-demo', type: 'note', observations: ['first obs', 'second obs'] });
    forget({ name: 'wording-demo', observation: 'first obs' });
    forget({ name: 'wording-demo' });
    const rows = getDatabase().prepare("SELECT content FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.name = 'wording-demo'").all() as Array<{ content: string }>;
    expect(rows).toHaveLength(1);
    expect(rows.map((r) => r.content)).toEqual(['second obs']);
    expect(recall({ query: 'wording-demo', include_archived: true }).flatMap((e) => e.observations)).not.toContain('first obs');
  });

  it('the skill does not call removing an observation recoverable', () => {
    const skill = fs.readFileSync('skills/memesh/SKILL.md', 'utf8');
    const forgetSection = skill.slice(skill.indexOf('memesh forget --name "auth-approach" --observation'));
    const sentence = forgetSection.slice(0, forgetSection.indexOf('\n###'));
    expect(sentence).not.toMatch(/recoverable|nothing is permanently removed/i);
    expect(sentence).toMatch(/Removing one observation deletes that text for good/);
  });

  it('`memesh forget --help` says the observation is removed permanently', () => {
    const home = path.join(handle.tmpDir, 'home');
    fs.mkdirSync(home, { recursive: true });
    const result = spawnSync(process.execPath, [path.resolve('dist/transports/cli/cli.js'), 'forget', '--help'], {
      env: { ...process.env, HOME: home, USERPROFILE: home, MEMESH_DB_PATH: handle.dbPath, MEMESH_DIR: handle.tmpDir, MEMESH_SKIP_UPDATE_CHECK: '1' },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toMatch(/recoverable|soft-delete/);
    expect(result.stdout).toMatch(/permanently remove one observation/);
  });
});
