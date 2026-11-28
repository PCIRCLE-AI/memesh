import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = path.resolve('scripts/check-readme-tool-parity.mjs');
const dirs: string[] = [];
const names = [
  'work_package', 'remember', 'recall', 'forget', 'export', 'import', 'learn',
  'task_state', 'briefing', 'user_patterns', 'improvement', 'message',
];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function write(root: string, file: string, value: string) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value);
}

function contractDigest(contract: string) {
  const semantic = contract.replace(/^\s*\/\/[^\n]*$/gm, '').replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(semantic).digest('hex');
}

function surfaceDigest(sourceDigest: string, surface: string) {
  return createHash('sha256').update(`${sourceDigest}\0${surface.trim()}`).digest('hex');
}

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-mcp-doc-parity-'));
  dirs.push(root);
  const contract = [
    'export const TOOL_DEFINITIONS = [',
    ...names.map(name => `  {\n    name: '${name}',\n    description: \`${name} canonical description\`,\n    inputSchema: { type: 'object' as const },\n  },`),
    '] as const;',
  ].join('\n');
  write(root, 'src/transports/mcp/handlers.ts', contract);
  const sourceDigest = contractDigest(contract);
  const digest = (surface: string) => surfaceDigest(sourceDigest, surface);
  const table = ['| Tool | Description |', '|---|---|', ...names.map(name => `| \`${name}\` | ${name} documentation |`)].join('\n');
  for (const file of ['README.md', 'README.zh-TW.md']) {
    write(root, file, `## All 12 Tools\n\n${table}\n\n---\n`);
  }
  write(root, 'AGENTS.md', `## All 12 MCP tools\n\n${table}\n\n## Next\n`);
  write(root, 'skills/memesh/SKILL.md', `## All 12 MCP tools\n\n${table}\n\n## Next\n`);
  const apiTools = names.map(name => `### ${name}\n\n${name} API description.\n`).join('\n');
  write(root, 'docs/api/API_REFERENCE.md', `## Tools\n\n${apiTools}\n## HTTP\n`);
  const overview = names.map(name => `\`${name}\``).join(', ');
  const handlers = ['| Tool | Schema | Handler |', '|------|--------|---------|', ...names.map(name => `| \`${name}\` | ${name}Schema | delegates |`)].join('\n');
  write(root, 'docs/ARCHITECTURE.md', `## Overview\n\n${overview}\n\n\`\`\`\narchitecture\n\`\`\`\n\n## Modules\n\n### transports/mcp/handlers.ts -- MCP Tool Handlers\n\n${handlers}\n\n### transports/http/server.ts -- HTTP\n`);
  write(root, 'scripts/mcp-doc-contract.json', `${JSON.stringify({
    schema_version: 'mcp-doc-contract/v2',
    source_sha256: sourceDigest,
    surfaces: {
      'README.md': digest(table),
      'README.zh-TW.md': digest(table),
      'AGENTS.md': digest(table),
      'skills/memesh/SKILL.md': digest(table),
      'docs/api/API_REFERENCE.md': digest(apiTools),
      'docs/ARCHITECTURE.md': digest(`${overview}\0${handlers}`),
    },
  }, null, 2)}\n`);
  return root;
}

function run(root: string) {
  return spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
}

function factoryFixture(): string {
  const root = fixture();
  const handlers = path.join(root, 'src/transports/mcp/handlers.ts');
  const source = fs.readFileSync(handlers, 'utf8')
    .replace('export const TOOL_DEFINITIONS', "import { CONVERSATION_MESSAGE_DESCRIPTION, CONVERSATION_MESSAGE_INPUT_SCHEMA } from '../conversation-messaging.js';\nexport const TOOL_DEFINITIONS")
    .replace('description: `message canonical description`,\n    inputSchema: { type: \'object\' as const }', 'description: CONVERSATION_MESSAGE_DESCRIPTION,\n    inputSchema: CONVERSATION_MESSAGE_INPUT_SCHEMA');
  fs.writeFileSync(handlers, source);
  write(root, 'src/transports/conversation-messaging.ts', fs.readFileSync('src/transports/conversation-messaging.ts', 'utf8'));
  // Certify the synthetic fixture once, using the gate's reported values.
  const result = run(root);
  const lockFile = path.join(root, 'scripts/mcp-doc-contract.json');
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  const sourceHash = /set source_sha256 to ([a-f0-9]{64})/.exec(result.stderr)?.[1];
  if (!sourceHash) throw new Error(result.stderr);
  lock.source_sha256 = sourceHash;
  for (const match of result.stderr.matchAll(/ {2}- ([^:\n]+): certified MCP documentation surface is stale[^\n]* hash to ([a-f0-9]{64})/g)) lock.surfaces[match[1]] = match[2];
  fs.writeFileSync(lockFile, JSON.stringify(lock));
  return root;
}

describe('MCP agent-facing documentation parity gate', () => {
  it('resolves the explicitly imported message factory', () => {
    const result = run(factoryFixture());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('PASS (12 tools');
  });

  it.each([
    ['description', 'Contact a registered conversation.', 'Contact a different conversation.'],
    ['schema', "z.literal('discover')", "z.literal('other')"],
  ])('makes documentation certification stale when the factory %s changes', (_label, before, after) => {
    const root = factoryFixture();
    const file = path.join(root, 'src/transports/conversation-messaging.ts');
    const original = fs.readFileSync(file, 'utf8');
    expect(original).toContain(before);
    fs.writeFileSync(file, original.replace(before, after));
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('canonical MCP source digest is stale');
    expect(result.stderr).toContain('README.md: certified MCP documentation surface is stale');
    const lockFile = path.join(root, 'scripts/mcp-doc-contract.json');
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    lock.source_sha256 = /set source_sha256 to ([a-f0-9]{64})/.exec(result.stderr)?.[1];
    fs.writeFileSync(lockFile, JSON.stringify(lock));
    expect(run(root).stderr).toContain('README.md: certified MCP documentation surface is stale');
  });

  it.each([
    ['unknown description', 'src/transports/mcp/handlers.ts', 'description: CONVERSATION_MESSAGE_DESCRIPTION', 'description: UNKNOWN_DESCRIPTION'],
    ['wrong input', 'src/transports/mcp/handlers.ts', 'inputSchema: CONVERSATION_MESSAGE_INPUT_SCHEMA', 'inputSchema: OTHER_SCHEMA'],
    ['wrong module', 'src/transports/mcp/handlers.ts', "from '../conversation-messaging.js'", "from '../other.js'"],
    ['type-only factory clause', 'src/transports/mcp/handlers.ts', 'import { CONVERSATION_MESSAGE_DESCRIPTION', 'import type { CONVERSATION_MESSAGE_DESCRIPTION'],
    ['type-only factory description', 'src/transports/mcp/handlers.ts', 'import { CONVERSATION_MESSAGE_DESCRIPTION', 'import { type CONVERSATION_MESSAGE_DESCRIPTION'],
    ['type-only factory schema', 'src/transports/mcp/handlers.ts', ', CONVERSATION_MESSAGE_INPUT_SCHEMA }', ', type CONVERSATION_MESSAGE_INPUT_SCHEMA }'],
    ['type-only zod clause', 'src/transports/conversation-messaging.ts', "import { z } from 'zod'", "import type { z } from 'zod'"],
    ['type-only zod binding', 'src/transports/conversation-messaging.ts', "import { z } from 'zod'", "import { type z } from 'zod'"],
    ['unknown schema identifier', 'src/transports/conversation-messaging.ts', 'message_id: messageId', 'message_id: unknownId'],
    ['dynamic description', 'src/transports/conversation-messaging.ts', "'Contact a registered conversation.", "unknownValue + 'Contact a registered conversation."],
  ])('fails closed for %s', (_label, relative, before, after) => {
    const root = factoryFixture();
    const file = path.join(root, relative);
    const original = fs.readFileSync(file, 'utf8');
    expect(original).toContain(before);
    fs.writeFileSync(file, original.replace(before, after));
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/parseable definitions|invalid message factory wiring|cannot statically resolve message factory/);
  });
  it('accepts one described row or API section for every canonical tool', () => {
    expect(names).toHaveLength(12);
    const result = run(fixture());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('PASS (12 tools across 6 agent-facing documents');
  });

  it.each([
    ['README translation row', 'README.zh-TW.md', (text: string) => text.replace(/^\| `message` .*\n/m, ''), 'README.zh-TW.md'],
    ['skill row', 'skills/memesh/SKILL.md', (text: string) => text.replace(/^\| `improvement` .*\n/m, ''), 'skills/memesh/SKILL.md'],
    ['API section', 'docs/api/API_REFERENCE.md', (text: string) => text.replace(/### message\n\nmessage API description\.\n/m, ''), '### message'],
    ['architecture inventory', 'docs/ARCHITECTURE.md', (text: string) => text.replace('`briefing`, ', ''), 'overview omits MCP tool briefing'],
    ['architecture handler row', 'docs/ARCHITECTURE.md', (text: string) => text.replace('| `user_patterns` |', '| `user_pattern` |'), 'MCP Tool Handlers table omits user_patterns'],
  ])('rejects a missing %s', (_label, file, mutate, expected) => {
    const root = fixture();
    const target = path.join(root, file);
    fs.writeFileSync(target, mutate(fs.readFileSync(target, 'utf8')));
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(expected);
  });

  it.each(['README.md', 'README.zh-TW.md', 'AGENTS.md', 'skills/memesh/SKILL.md'])('rejects a heading in %s that declares a different number of tools than the registry holds', (file) => {
    const root = fixture();
    const target = path.join(root, file);
    fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace(/## All 12 /, '## All 11 '));
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('declares 11 tools');
    expect(result.stderr).toContain('contains 12');
  });

  it('forces explicit documentation review when a canonical description or schema changes', () => {
    const root = fixture();
    const target = path.join(root, 'src/transports/mcp/handlers.ts');
    fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace('remember canonical description', 'changed canonical description'));
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('canonical MCP source digest is stale');
  });

  it('rejects refreshing only the source digest without recertifying every documentation surface', () => {
    const root = fixture();
    const sourceFile = path.join(root, 'src/transports/mcp/handlers.ts');
    const changed = fs.readFileSync(sourceFile, 'utf8').replace('remember canonical description', 'changed canonical description');
    fs.writeFileSync(sourceFile, changed);
    const lockFile = path.join(root, 'scripts/mcp-doc-contract.json');
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    lock.source_sha256 = contractDigest(changed);
    fs.writeFileSync(lockFile, JSON.stringify(lock));
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('README.md: certified MCP documentation surface is stale for the current source contract');
  });

  it('does not require recertification for a source comment-only change', () => {
    const root = fixture();
    const sourceFile = path.join(root, 'src/transports/mcp/handlers.ts');
    fs.writeFileSync(sourceFile, fs.readFileSync(sourceFile, 'utf8').replace('[\n', '[\n  // formatting note\n'));
    const result = run(root);
    expect(result.status, result.stderr).toBe(0);
  });

  it('rejects a false non-empty tool description even when the old marker remains', () => {
    const root = fixture();
    const target = path.join(root, 'README.md');
    fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace('remember documentation', 'Deletes every memory immediately'));
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('README.md: certified MCP documentation surface is stale');
  });
});
