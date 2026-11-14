/**
 * Every Node version CI runs must be one the package claims to support, and the
 * floor it claims must actually be run.
 *
 * `package.json` `engines.node` is a promise to strangers; the CI matrix is the
 * only thing that checks the promise. Nothing held the two together, so they
 * could drift in either direction, and both directions are silent:
 *
 *   - matrix BELOW the floor — CI proves the suite passes on a runtime we tell
 *     users not to use, and `npm install` warns EBADENGINE on the very runtime
 *     that produced the green tick. This was the live state before the floor
 *     moved to 22.5.0: three `node-version: '20'` jobs, one of them the publish
 *     path, which would have run `prepublishOnly` -> `verify:release` (npm pack,
 *     install into a consumer tree, audit) on an unsupported runtime.
 *   - matrix ABOVE the floor — we claim 22.5 and test only 24 and 26, so the
 *     oldest runtime any user is entitled to run is the one runtime nobody runs.
 *
 * Both cases are checked. Checking only the first would pass on a matrix that
 * dropped the floor leg entirely, which is the more likely accident: legs get
 * removed for wall-clock, floors get raised deliberately.
 *
 * The workflows are read as text, not parsed as YAML — this repository has no
 * YAML parser and one test is not a reason to add a dependency. Text matching
 * fails open by nature, so every extraction below asserts it found something
 * before it asserts anything about what it found. A regex that silently matches
 * nothing would leave "all zero legs satisfy the floor" as a green test, which
 * is the same defect as a gate that passes on an empty input.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowDir = path.join(repoRoot, '.github', 'workflows');

/** The major version in a `>=X.Y.Z` engines range. */
function declaredFloor(): { range: string; versions: string[] } {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    engines?: { node?: string };
  };
  const range = pkg.engines?.node;
  expect(range, 'package.json declares no engines.node').toBeTypeOf('string');
  const versions = (range as string).split('||').map((part) => part.trim());
  expect(
    versions.every((part) => /^\^\d+\.\d+\.\d+$/.test(part)),
    `engines.node is "${range}"; expected a union of full caret versions`
  ).toBe(true);
  return { range: range as string, versions: versions.map((version) => version.slice(1)) };
}

/**
 * Every Node version any workflow pins, as `{ file, where, major }`.
 *
 * Two shapes: the build matrix's `node: ['22', '24']` plus its `include:`
 * entries, and the standalone jobs' `node-version: '22'`.
 */
function pinnedNodeVersions(): Array<{ file: string; where: string; version: string }> {
  const found: Array<{ file: string; where: string; version: string }> = [];
  const files = fs.readdirSync(workflowDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  expect(files.length, 'no workflow files found — did .github/workflows move?').toBeGreaterThan(0);

  for (const file of files) {
    const text = fs.readFileSync(path.join(workflowDir, file), 'utf8');

    // `node: ['22', '24']` — the matrix list.
    for (const m of text.matchAll(/^\s*node:\s*\[([^\]]*)\]/gm)) {
      for (const raw of m[1].split(',')) {
        const version = raw.trim().replace(/^['"]|['"]$/g, '');
        if (version === '') continue;
        found.push({ file, where: `matrix node: [… ${version} …]`, version });
      }
    }

    // `node: '26'` — a matrix `include:` entry.
    for (const m of text.matchAll(/^\s*-?\s*node:\s*['"](\d[^'"]*)['"]\s*$/gm)) {
      found.push({ file, where: `matrix include node: '${m[1]}'`, version: m[1] });
    }

    // `node-version: '22'` — a standalone job. Skips `${{ matrix.node }}`.
    for (const m of text.matchAll(/^\s*node-version:\s*['"]?(\d[^'"\s]*)['"]?\s*$/gm)) {
      found.push({ file, where: `node-version: '${m[1]}'`, version: m[1] });
    }
  }
  return found;
}

describe('the CI matrix and engines.node cannot drift apart', () => {
  it('pins no Node version below the floor the package declares', () => {
    const floor = declaredFloor();
    const pins = pinnedNodeVersions();

    // Without this, a regex that matched nothing would make the loop below
    // vacuous and this test would pass on a workflow directory of empty files.
    expect(pins.length, 'no Node version was extracted from any workflow — the patterns stopped matching').toBeGreaterThanOrEqual(5);

    for (const pin of pins) {
      expect(pin.version, `${pin.file} ${pin.where} must pin a complete version`).toMatch(/^\d+\.\d+\.\d+$/);
      const have = pin.version.split('.').map(Number);
      const minimum = floor.versions.map((version) => version.split('.').map(Number)).find((version) => version[0] === have[0]);
      expect(minimum, `${pin.file} ${pin.where} is outside ${floor.range}`).toBeDefined();
      expect(have[1] > minimum![1] || (have[1] === minimum![1] && have[2] >= minimum![2]), `${pin.file} ${pin.where} is below ${floor.range}`).toBe(true);
    }
  });

  it('actually runs the floor it declares', () => {
    const floor = declaredFloor();
    const pins = pinnedNodeVersions();
    const buildPins = pins.filter((pin) => pin.file === 'ci.yml').map((pin) => pin.version);
    for (const version of floor.versions) expect(buildPins, `CI must run declared floor ${version}`).toContain(version);
    expect(floor.versions).toContain(fs.readFileSync(path.join(repoRoot, '.nvmrc'), 'utf8').trim());
    const workflow = fs.readFileSync(path.join(workflowDir, 'ci.yml'), 'utf8');
    expect(workflow).toMatch(/os:\s*macos-latest\s*\n\s*node:\s*['"]26\.13\.1['"]/);
  });
});
