// #477: an extensionless shim written under TMPDIR took its module type from
// whatever package.json sat above TMPDIR.
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeNodeShim } from '../scripts/lib/node-shim.mjs';

const roots: string[] = [];
function rootWithAncestorType(type: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-shim-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type }));
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('writeNodeShim', () => {
  it('runs a CommonJS shim under an ancestor package.json of type module', () => {
    const shim = writeNodeShim(path.join(rootWithAncestorType('module'), 'bin'), 'npm',
      "#!/usr/bin/env node\nconst fs = require('node:fs');\nprocess.stdout.write(typeof fs.writeFileSync);\n", 'commonjs');
    const r = spawnSync(process.execPath, [shim], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('function');
  });

  it('runs an ES module shim under an ancestor package.json of type commonjs', () => {
    const shim = writeNodeShim(path.join(rootWithAncestorType('commonjs'), 'bin'), 'codex',
      "#!/usr/bin/env node\nimport fs from 'node:fs';\nprocess.stdout.write(typeof fs.writeFileSync);\n", 'module');
    const r = spawnSync(process.execPath, [shim], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('function');
  });

  it('is executable by name, as PATH lookup needs', () => {
    const shim = writeNodeShim(path.join(rootWithAncestorType('module'), 'bin'), 'npm', '#!/usr/bin/env node\n', 'commonjs');
    if (process.platform !== 'win32') expect(fs.statSync(shim).mode & 0o100).toBe(0o100);
  });

  it('refuses an unknown module type rather than writing an ambiguous shim', () => {
    expect(() => writeNodeShim(path.join(rootWithAncestorType('module'), 'bin'), 'npm', '', 'esm' as never)).toThrow(/unknown module type/);
  });
});
