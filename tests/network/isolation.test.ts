// The boundary that keeps someone who never joined a team untouched, and keeps
// memory out of the network path. Read from the source, so a new import that
// crosses it fails here without having to run anything.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const srcRoot = path.join(repoRoot, 'src');
const networkRoot = path.join(srcRoot, 'network');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : [full];
  });
}

/** Runtime imports only: `import type` is erased and loads nothing. */
function localImports(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  const imports: string[] = [];
  for (const match of text.matchAll(/^\s*(?:import|export)\s+(?!type\s)(?:[^'"`;]*?\sfrom\s+)?['"](\.{1,2}\/[^'"]+)['"]/gm)) {
    imports.push(path.resolve(path.dirname(file), match[1]).replace(/\.js$/, '.ts'));
  }
  for (const match of text.matchAll(/\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
    imports.push(path.resolve(path.dirname(file), match[1]).replace(/\.js$/, '.ts'));
  }
  return imports;
}

function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);
    stack.push(...localImports(file));
  }
  return seen;
}

const relative = (file: string): string => path.relative(repoRoot, file).split(path.sep).join('/');

describe('native isolation', () => {
  it('only the native loader names the native package, in all of src/', () => {
    const naming = sourceFiles(srcRoot)
      .filter((file) => fs.readFileSync(file, 'utf8').includes('@number0/iroh'))
      .map(relative)
      .sort();
    // The two pin files are data npm reads; they are never imported.
    expect(naming).toEqual([
      'src/network/native-loader.ts',
      'src/network/runtime-lock.json',
      'src/network/runtime-package.json',
    ]);
  });

  it('the loader is reachable from the bridge and not from the CLI command', () => {
    const loader = path.join(networkRoot, 'native-loader.ts');
    expect(reachableFrom(path.join(networkRoot, 'bridge.ts'))).toContain(loader);
    expect(reachableFrom(path.join(srcRoot, 'transports/cli/cli.ts'))).not.toContain(loader);
  });

  it('the entry points other than the CLI do not reach the network module at all', () => {
    for (const entry of ['mcp/server.ts', 'transports/http/server.ts', 'host-runtime/router.ts']) {
      const reached = [...reachableFrom(path.join(srcRoot, entry))].filter((file) => file.startsWith(networkRoot));
      expect({ entry, reached }).toEqual({ entry, reached: [] });
    }
  });

  it('only the CLI imports the network module from outside it', () => {
    const importers = sourceFiles(srcRoot)
      .filter((file) => file.endsWith('.ts') && !file.startsWith(networkRoot))
      .filter((file) => localImports(file).some((target) => target.startsWith(networkRoot + path.sep)))
      .map(relative);
    expect(importers).toEqual(['src/transports/cli/cli.ts']);
  });
});

describe('memory stays out of the network path', () => {
  const MEMORY_MODULE = /(^|\/)(knowledge-graph|entities|observations|recall[^/]*|briefing[^/]*|db)\.ts$/;

  it('nothing in src/network imports a memory module, directly or through another file', () => {
    for (const file of sourceFiles(networkRoot).filter((name) => name.endsWith('.ts'))) {
      const reached = [...reachableFrom(file)].map(relative).filter((name) => MEMORY_MODULE.test(name));
      expect({ file: relative(file), reached }).toEqual({ file: relative(file), reached: [] });
    }
  });

  it('the walker sees an import that crosses the line', () => {
    // A walker that finds nothing would pass the test above forever.
    expect([...reachableFrom(path.join(srcRoot, 'transports/cli/cli.ts'))].map(relative)).toContain('src/db.ts');
  });
});
