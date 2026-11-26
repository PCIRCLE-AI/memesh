/**
 * The MCP server tells each client to save by default and use ordinary forget for user-selected memories.
 * A host puts this field into the model's system prompt, so it is the place the default
 * has to be said. The built server is started under a throwaway HOME (with the account-home preload, so it does not
 * register itself as a live host in the maintainer's real ~/.memesh) and asked to initialize.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_CITATION_INSTRUCTION, DEFAULT_SAVE_INSTRUCTION } from '../../src/core/citation-rule.js';

const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) { try { c.kill('SIGKILL'); } catch { /* already gone */ } }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function initializeInstructions(): Promise<unknown> {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-mcp-instr-')));
  dirs.push(home);
  const preload = path.resolve('scripts/lib/account-home-preload.mjs');
  const env = {
    PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home,
    MEMESH_DIR: path.join(home, '.memesh'), MEMESH_DB_PATH: path.join(home, '.memesh', 'knowledge-graph.db'),
    MEMESH_AUTO_UPDATE: 'off', NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
  };
  const child = spawn(process.execPath, [path.resolve('dist/mcp/server.js')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`no initialize answer in 20 s; stdout so far: ${out.slice(0, 300)}`)), 20_000);
    child.stdout!.on('data', (chunk) => {
      out += String(chunk);
      const line = out.split('\n').find((l) => l.includes('"id":1'));
      if (!line) return;
      clearTimeout(timer);
      resolve(JSON.parse(line).result?.instructions);
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}) before it answered`)); });
    child.stdin!.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'instructions-test', version: '1' } },
    }) + '\n');
  });
}

describe.skipIf(process.platform === 'win32')('the MCP server tells the model how to use memory', () => {
  it('its initialize answer carries the save and citation instructions, word for word', async () => {
    expect(await initializeInstructions()).toBe(`${DEFAULT_SAVE_INSTRUCTION}\n\n${DEFAULT_CITATION_INSTRUCTION}`);
  }, 60_000);

  it('the instruction explains selected-memory forget without conditioning default saving', () => {
    expect(DEFAULT_SAVE_INSTRUCTION).toMatch(/Saving is on by default/);
    expect(DEFAULT_SAVE_INSTRUCTION).toMatch(/remove a specific stored memory/);
    expect(DEFAULT_SAVE_INSTRUCTION).toContain('`recall`');
    expect(DEFAULT_SAVE_INSTRUCTION).toContain('`forget`');
    expect(DEFAULT_SAVE_INSTRUCTION).not.toMatch(/not to save|current_turn|only exception/i);
    expect(DEFAULT_SAVE_INSTRUCTION).toMatch(/preferences/);
    expect(DEFAULT_SAVE_INSTRUCTION, 'names no private-session tool').not.toMatch(/private/i);
    expect(DEFAULT_SAVE_INSTRUCTION).not.toMatch(/\b(worth|important|durable|significant|later session|would need|if (it|you|the))\b/i);
  });

  it('the instruction requires truthful citations for injected memories', () => {
    expect(DEFAULT_CITATION_INSTRUCTION).toContain('`[mem:42]`');
    expect(DEFAULT_CITATION_INSTRUCTION).toMatch(/genuinely informs your work/);
    expect(DEFAULT_CITATION_INSTRUCTION).toMatch(/only read past/);
    expect(DEFAULT_CITATION_INSTRUCTION).toMatch(/never invent an id/);
  });
});
