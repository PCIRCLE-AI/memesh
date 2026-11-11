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
  // Every name this file binds to node:module, however it is spelled.
  const moduleBindings = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && isLiteral(node.moduleSpecifier)) {
      loads.literal.push(node.moduleSpecifier.text);
      if (/^(?:node:)?module$/.test(node.moduleSpecifier.text)) {
        const clause = node.importClause;
        if (clause?.name) moduleBindings.add(clause.name.text);
        const bindings = clause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) moduleBindings.add(bindings.name.text);
        if (bindings && ts.isNamedImports(bindings)) bindings.elements.forEach((element) => moduleBindings.add(element.name.text));
      }
    }
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && isLiteral(node.moduleSpecifier)) {
      loads.literal.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequireLike = ts.isIdentifier(callee) && /require/i.test(callee.text);
      const root = ts.isPropertyAccessExpression(callee) ? callee.expression : callee;
      const isModuleCall = ts.isIdentifier(root) && moduleBindings.has(root.text);
      const isDlopen = ts.isPropertyAccessExpression(callee) && callee.name.text === 'dlopen';
      const isModuleLoad = ts.isPropertyAccessExpression(callee) && callee.name.text === '_load';
      if (isModuleCall || isDlopen || isModuleLoad) {
        loads.computed.push(node.getText());
      } else if (isImport || isRequireLike) {
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
    ["import { createRequire as cr } from 'node:module'; const r = cr(import.meta.url);", ['node:module'], ['cr(import.meta.url)']],
    ["import * as nm from 'node:module'; nm.createRequire(u);", ['node:module'], ['nm.createRequire(u)']],
    ["import Module from 'module'; Module._load(p);", ['module'], ['Module._load(p)']],
    ["process.dlopen(m, p);", [], ['process.dlopen(m, p)']],
  ])('%s', (text, literal, computed) => {
    expect(loadsIn(text)).toEqual({ literal, computed });
  });
});

describe('native isolation', () => {
  it('no code in src/ names the native package: the loader takes it from the lock', () => {
    const naming = sourceFiles(srcRoot)
      .filter((file) => fs.readFileSync(file, 'utf8').includes('@number0'))
      .map(relative)
      .sort();
    // The two pin files are data npm reads; they are never imported.
    expect(naming).toEqual([
      'src/network/runtime-lock.json',
      'src/network/runtime-package.json',
    ]);
  });

  // The bridge's own entry code: only the bridge child process may load it.
  const bridgeOnly = ['native-loader.ts', 'bridge.ts', 'bridge-serve.ts', 'bridge-join.ts'].map((name) => path.join(networkRoot, name));

  it('the loader is reachable from the bridge', () => {
    expect(reachableFrom(path.join(networkRoot, 'bridge.ts'))).toContain(path.join(networkRoot, 'native-loader.ts'));
  });

  it('no file outside the bridge reaches the native loader or the bridge entry code', () => {
    const outside = sourceFiles(srcRoot).filter((file) => file.endsWith('.ts') && !bridgeOnly.includes(file));
    const crossing = outside.flatMap((file) => [...reachableFrom(file)]
      .filter((reached) => bridgeOnly.includes(reached))
      .map((reached) => `${relative(file)} -> ${relative(reached)}`));
    expect(crossing).toEqual([]);
    // The guard sees the entry points, so it is not passing on an empty list.
    expect(outside).toEqual(expect.arrayContaining(['transports/cli/cli.ts', 'mcp/server.ts', 'transports/http/server.ts', 'host-runtime/router.ts'].map((entry) => path.join(srcRoot, entry))));
  });

  it('outside the network module, exactly these files import it', () => {
    const importers = sourceFiles(srcRoot)
      .filter((file) => file.endsWith('.ts') && !file.startsWith(networkRoot + path.sep))
      .filter((file) => localImports(file).some((target) => target.startsWith(networkRoot + path.sep)))
      .map(relative)
      .sort();
    // The CLI command, the message tool (network addresses, receipts, remote cards), the router (auto-start)
    // and the expiry pass (what the network knew of a message to another machine, for its sender's notice).
    expect(importers).toEqual(['src/core/agent-message-expiry.ts', 'src/host-runtime/router.ts', 'src/transports/agent-messaging.ts', 'src/transports/cli/cli.ts']);
  });

  it('nothing in src/network loads a module whose name is not in the code, except the native loader', () => {
    const computed = networkSources
      .filter((file) => !file.endsWith('native-loader.ts'))
      .flatMap((file) => loadsIn(fs.readFileSync(file, 'utf8')).computed.map((load) => `${relative(file)}: ${load}`));
    expect(computed).toEqual([]);
    expect(loadsIn(fs.readFileSync(path.join(networkRoot, 'native-loader.ts'), 'utf8')).computed.length).toBeGreaterThan(0);
  });
});

describe('memory stays out of the network path', () => {
  // The agent messaging modules are allowed (a network message is stored and read
  // through them); no memory module is on this list.
  it('everything src/network can reach outside itself is exactly this list', () => {
    const reached = new Set(networkSources.flatMap((file) => [...reachableFrom(file)]));
    const outside = [...reached].filter((file) => !file.startsWith(networkRoot + path.sep)).map(relative).sort();
    expect(outside).toEqual([
      'src/core/agent-message-inbox.ts',
      'src/core/agent-message-storage.ts',
      // The retention constant (reached through the courier and agent-messaging): no imports, no SQL.
      'src/core/agent-message-ttl.ts',
      'src/core/agent-messaging.ts',
      'src/core/agent-router.ts',
      'src/core/agent-scope-id.ts',
      'src/core/file-mode.ts',
      'src/core/paths.ts',
      'src/core/semver.ts',
      'src/core/time-utils.ts',
      // Reached only for jsonStringLiteral, through the inbox: it has no imports and no SQL.
      'src/core/work-topology.ts',
      'src/storage/agent-network-schema.ts',
      'src/storage/sqlite.ts',
    ]);
  });

  it('the only npm package it can load is commander, for the CLI command', () => {
    const external = new Set(networkSources.flatMap((file) => loadsIn(fs.readFileSync(file, 'utf8')).literal)
      .filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('node:')));
    expect([...external].sort()).toEqual(['commander']);
  });

  /** Code without its comments: prose like "the CREATE TABLE any release adds" names no table. */
  const code = (text: string): string => ts.createPrinter({ removeComments: true }).printFile(ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true));
  const tablesIn = (sql: string): string[] => [...sql.matchAll(/CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?!IF\s+NOT\s+EXISTS)["'`[]?(\w+)/gi)].map((match) => match[1]);
  // Everywhere a table is created, not only SCHEMA_SQL: src/db.ts and others make their own.
  const memoryTables = [...new Set([
    ...tablesIn(code(fs.readFileSync(path.join(srcRoot, 'storage/schema.ts'), 'utf8'))),
    ...sourceFiles(srcRoot).filter((file) => file.endsWith('.ts') && !file.startsWith(networkRoot + path.sep)).flatMap((file) => tablesIn(code(fs.readFileSync(file, 'utf8')))),
  ])].filter((name) => !name.startsWith('agent_'));
  const touchesMemoryTable = (text: string): string[] => memoryTables.filter((table) =>
    new RegExp(`\\b(?:FROM|INTO|UPDATE|JOIN|TABLE)\\s+(?:[\\w"'\`\\[\\]]+\\.)?["'\`[]?${table}\\b`, 'i').test(text));
  /** SQL handed to prepare() that is built at runtime: a table name there cannot be read from the code. */
  const computedSql = (text: string): string[] => {
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'prepare') {
        const [argument] = node.arguments;
        if (!argument || !ts.isStringLiteralLike(argument)) found.push(node.getText());
      }
      ts.forEachChild(node, visit);
    };
    visit(ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true));
    return found;
  };

  it('knows the memory tables', () => {
    expect(memoryTables).toEqual(expect.arrayContaining(['entities', 'observations', 'relations', 'tags']));
    // Every table that is not agent_*; prose in comments names none.
    expect(memoryTables.length).toBeGreaterThanOrEqual(10);
    expect(memoryTables).toEqual(expect.arrayContaining(['dream_proposals', 'entities_fts', 'memesh_metadata']));
    expect(memoryTables).not.toEqual(expect.arrayContaining(['any']));
    // `CREATE TABLE IF NOT EXISTS x` names x, not IF; every table the network schema creates is agent_*.
    expect(memoryTables).not.toContain('IF');
    expect(tablesIn('CREATE TABLE IF NOT EXISTS x (a)')).toEqual(['x']);
    const networkTables = tablesIn(code(fs.readFileSync(path.join(srcRoot, 'storage/agent-network-schema.ts'), 'utf8')));
    expect(networkTables.length).toBeGreaterThan(3);
    expect(networkTables.every((name) => name.startsWith('agent_'))).toBe(true);
    for (const sql of ['SELECT name FROM entities', 'SELECT name FROM "entities"', 'SELECT name FROM main.entities', 'select * from main."entities"', 'SELECT * FROM `entities`', 'SELECT * FROM [entities]']) {
      expect(touchesMemoryTable(sql)).toEqual(['entities']);
    }
    expect(touchesMemoryTable('SELECT 1 FROM agent_network_config')).toEqual([]);
    expect(touchesMemoryTable('SELECT 1 FROM agent_messages')).toEqual([]);
    expect(computedSql('const t = "entities"; db.prepare(`SELECT name FROM ${t}`);').length).toBe(1);
    expect(computedSql("db.prepare('SELECT 1');").length).toBe(0);
  });

  // Everything the network code can run, including the messaging modules it reaches.
  const reachedSources = [...new Set(networkSources.flatMap((file) => [...reachableFrom(file)]))];

  it('no SQL that src/network can reach touches a table outside the agent_* messaging and network tables', () => {
    expect(reachedSources).toContain(path.join(srcRoot, 'core/agent-messaging.ts'));
    const hits = reachedSources.flatMap((file) => touchesMemoryTable(code(fs.readFileSync(file, 'utf8'))).map((table) => `${relative(file)}: ${table}`)).sort();
    // The router class keeps its version hold in memesh_metadata. The bridge reaches
    // that file only for the notifier and never builds a router; no memory table is here.
    // sqlite.ts is reached through the bridge's own store (store.ts opens a MemeshDatabase). Its only
    // such table is memesh_fts5_probe, created once in a throwaway :memory: database to ask whether
    // this Node has FTS5; it is never the user's database and holds no user data.
    expect(hits).toEqual(['src/core/agent-router.ts: memesh_metadata', 'src/storage/sqlite.ts: memesh_fts5_probe']);
  });

  it('every SQL statement in src/network can be read from the code', () => {
    const computed = networkSources.flatMap((file) => computedSql(fs.readFileSync(file, 'utf8')).map((call) => `${relative(file)}: ${call}`));
    expect(computed).toEqual([]);
  });

  it('the schema the bridge opens with names only network tables', () => {
    const text = fs.readFileSync(path.join(srcRoot, 'storage/agent-network-schema.ts'), 'utf8');
    expect(tablesIn(text)).toEqual(['agent_network_config', 'agent_network_invites', 'agent_network_outbox', 'agent_network_presence', 'agent_network_peers']);
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
