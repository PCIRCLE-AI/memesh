// The boundary that keeps someone who never joined a team untouched, and keeps
// memory out of the network path. Read from the source with the compiler's parser,
// so a new import that crosses it fails here without having to run anything.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const srcRoot = path.join(repoRoot, 'src');
const networkRoot = path.join(srcRoot, 'network');
const SCHEMA_SOURCE = path.join(srcRoot, 'storage/schema.ts');
const NETWORK_SCHEMA_SOURCE = path.join(srcRoot, 'storage/agent-network-schema.ts');
const NATIVE_LOADER_SOURCE = path.join(networkRoot, 'native-loader.ts');
const relative = (file: string): string => path.relative(repoRoot, file).split(path.sep).join('/');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : [full];
  });
}

interface Loads {
  /** Specifier of everything loaded at runtime with a literal string. */
  literal: string[];
  /** Source text of each load whose target cannot be read from the code. */
  computed: string[];
}

function loadsIn(text: string): Loads {
  const source = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true);
  const loads: Loads = { literal: [], computed: [] };
  const isLiteral = (node: ts.Node | undefined): node is ts.StringLiteralLike => node !== undefined && ts.isStringLiteralLike(node);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && isLiteral(node.moduleSpecifier)) {
      loads.literal.push(node.moduleSpecifier.text);
    }
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && isLiteral(node.moduleSpecifier)) {
      loads.literal.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node)) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequireLike = ts.isIdentifier(node.expression) && /require/i.test(node.expression.text);
      if (isImport || isRequireLike) {
        const [argument] = node.arguments;
        if (isLiteral(argument)) loads.literal.push(argument.text);
        else loads.computed.push(node.getText());
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return loads;
}

const localImports = (file: string): string[] => loadsIn(fs.readFileSync(file, 'utf8')).literal
  .filter((specifier) => specifier.startsWith('.'))
  .map((specifier) => path.resolve(path.dirname(file), specifier).replace(/\.js$/, '.ts'));

function reachableFrom(entry: string): Set<string> {
  if (!fs.existsSync(entry)) throw new Error(`no such entry: ${entry}`);
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    if (!fs.existsSync(file)) throw new Error(`import of a missing file: ${file}`);
    seen.add(file);
    stack.push(...localImports(file));
  }
  return seen;
}

const networkSources = sourceFiles(networkRoot).filter((file) => file.endsWith('.ts'));

describe('the parser sees every way of loading a module', () => {
  it.each([
    ["import x from '../db.js';", ['../db.js'], []],
    ["import type { X } from '../db.js';", [], []],
    ["export * from '../db.js';", ['../db.js'], []],
    ["export{a}from'../db.js';", ['../db.js'], []],
    ["const q = 1; export * from '../db.js'", ['../db.js'], []],
    ["await import('../db.js');", ['../db.js'], []],
    ['await import(`../db.js`);', ['../db.js'], []],
    ["await import(/* lazy */ '../db.js');", ['../db.js'], []],
    ["const p = '../db.js'; await import(p);", [], ['import(p)']],
    ["await import('../' + 'db.js');", [], ["import('../' + 'db.js')"]],
    ["createRequire(import.meta.url)(p);", [], ['createRequire(import.meta.url)']],
    ["require(p);", [], ['require(p)']],
  ])('%s', (text, literal, computed) => {
    expect(loadsIn(text)).toEqual({ literal, computed });
  });
});

describe('native isolation', () => {
  it('only the native loader names the native package, in all of src/', () => {
    const naming = sourceFiles(srcRoot)
      .filter((file) => fs.readFileSync(file, 'utf8').includes('@number0'))
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
      const reached = [...reachableFrom(path.join(srcRoot, entry))].filter((file) => file.startsWith(networkRoot + path.sep));
      expect({ entry, reached }).toEqual({ entry, reached: [] });
    }
  });

  it('only the CLI imports the network module from outside it', () => {
    const importers = sourceFiles(srcRoot)
      .filter((file) => file.endsWith('.ts') && !file.startsWith(networkRoot + path.sep))
      .filter((file) => localImports(file).some((target) => target.startsWith(networkRoot + path.sep)))
      .map(relative);
    expect(importers).toEqual(['src/transports/cli/cli.ts']);
  });

  it('nothing in src/network loads a module whose name is not in the code, except the native loader', () => {
    const computed = networkSources
      .filter((file) => !file.endsWith('native-loader.ts'))
      .flatMap((file) => loadsIn(fs.readFileSync(file, 'utf8')).computed.map((load) => `${relative(file)}: ${load}`));
    expect(computed).toEqual([]);
    expect(loadsIn(fs.readFileSync(NATIVE_LOADER_SOURCE, 'utf8')).computed.length).toBeGreaterThan(0);
  });
});

describe('memory stays out of the network path', () => {
  it('everything src/network can reach outside itself is exactly this list', () => {
    const reached = new Set(networkSources.flatMap((file) => [...reachableFrom(file)]));
    const outside = [...reached].filter((file) => !file.startsWith(networkRoot + path.sep)).map(relative).sort();
    expect(outside).toEqual([
      'src/core/file-mode.ts',
      'src/core/paths.ts',
      'src/storage/agent-network-schema.ts',
      'src/storage/sqlite.ts',
    ]);
  });

  it('the only npm package it can load is commander, for the CLI command', () => {
    const external = new Set(networkSources.flatMap((file) => loadsIn(fs.readFileSync(file, 'utf8')).literal)
      .filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('node:')));
    expect([...external].sort()).toEqual(['commander']);
  });

  const tablesIn = (sql: string): string[] => [...sql.matchAll(/CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi)].map((match) => match[1]);
  const memoryTables = tablesIn(fs.readFileSync(SCHEMA_SOURCE, 'utf8')).filter((name) => !name.startsWith('agent_network_'));
  const touchesMemoryTable = (text: string): string[] => memoryTables.filter((table) =>
    new RegExp(`\\b(?:FROM|INTO|UPDATE|JOIN|TABLE)\\s+${table}\\b`, 'i').test(text));

  it('knows the memory tables', () => {
    expect(memoryTables).toEqual(expect.arrayContaining(['entities', 'observations', 'relations', 'tags']));
    expect(memoryTables.length).toBeGreaterThan(10);
    expect(touchesMemoryTable("db.prepare('SELECT name FROM entities').all()")).toEqual(['entities']);
  });

  it('no SQL in src/network touches a table outside agent_network_*', () => {
    const hits = networkSources.flatMap((file) => touchesMemoryTable(fs.readFileSync(file, 'utf8')).map((table) => `${relative(file)}: ${table}`));
    expect(hits).toEqual([]);
  });

  it('the schema the bridge opens with names only network tables', () => {
    const text = fs.readFileSync(NETWORK_SCHEMA_SOURCE, 'utf8');
    expect(tablesIn(text)).toEqual(['agent_network_config', 'agent_network_invites']);
    expect(loadsIn(text)).toEqual({ literal: [], computed: [] });
  });
});

describe('what the bundles really contain', () => {
  let out: string;
  const bundle = async (entry: string, external: 'bundle' | 'external' = 'bundle'): Promise<string> => {
    const outfile = path.join(out, `${entry.replace(/\W/g, '-')}.mjs`);
    await build({
      entryPoints: [path.join(srcRoot, entry)], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22.13', logLevel: 'silent', packages: external,
    });
    return fs.readFileSync(outfile, 'utf8');
  };

  beforeAll(() => { out = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-network-bundles-')); });
  afterAll(() => fs.rmSync(out, { recursive: true, force: true }));

  it('the bridge carries no memory table text, and does carry the network tables', async () => {
    const text = await bundle('network/bridge.ts');
    expect(text).toContain('agent_network_config');
    for (const table of ['entities', 'observations', 'relations', 'memesh_metadata']) {
      expect(new RegExp(`(?:TABLE(?: IF NOT EXISTS)?|FROM|INTO|UPDATE|JOIN)\\s+${table}\\b`).test(text)).toBe(false);
    }
  });

  it.each(['transports/cli/cli.ts', 'mcp/server.ts', 'transports/http/server.ts', 'host-runtime/router.ts'])('%s does not carry the native package', async (entry) => {
    const text = await bundle(entry, 'external');
    expect(text.length).toBeGreaterThan(1000);
    expect(text).not.toContain('@number0');
    expect(text).not.toContain('native-loader');
  });
});
