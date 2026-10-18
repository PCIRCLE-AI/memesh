import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { remember } from '../../src/core/operations.js';
import { handleTool } from '../../src/transports/mcp/handlers.js';

describe('Claude Mod callbacks with the actual memory core (not native host rendering)', () => {
  let dir: string;
  beforeEach(() => {
    vi.resetModules();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-mod-'));
    openDatabase(path.join(dir, 'test.db'));
    remember({ name: 'ui-note', type: 'note', title: 'Original title', observations: ['Original paragraph'], project: 'ui-project' });
  });
  afterEach(() => { closeDatabase(); fs.rmSync(dir, { recursive: true, force: true }); });

  it.each(['cancel', 'accept'] as const)('view → edit → %s uses the existing MCP path and reads the result', async action => {
    const modulePath = pathToFileURL(path.resolve('hooks/native-memory.js')).href;
    const { register } = await import(modulePath);
    const result: ElicitResult = action === 'cancel' ? { action } : { action, content: { title: 'Saved title', body: 'Saved paragraph' } };
    let submit!: () => void;
    const formPending = new Promise<void>(resolve => { submit = resolve; });
    const element = (type: string) => (props: Record<string, unknown>) => ({ type, ...props });
    const api = {
      command: { register: vi.fn() },
      session: { cwd: async () => '/Users/someone/Developer/ui-project' },
      ui: {
        open: vi.fn(), invalidate: vi.fn(),
        resolve: () => ({ Box: element('Box'), Text: element('Text'), Button: element('Button'), Input: element('Input') }),
      },
      mcp: { call: vi.fn(async (server: string, tool: string, args: Record<string, unknown>) => {
        expect(server).toBe('plugin:memesh:memesh');
        return handleTool(tool, args, 'claude-code', undefined, { projectBinding: { project: 'ui-project' }, elicit: async () => { await formPending; return result; } });
      }) },
    };
    type Element = { type: string; key?: string; children?: (Element | string)[]; onPress?: () => Promise<void> };
    // The pane nests rows and button groups in Boxes, so look a key up anywhere in the tree.
    const find = (node: Element | string, key: string): Element | undefined => typeof node === 'string' ? undefined
      : node.key === key ? node : node.children?.map(child => find(child, key)).find(Boolean);
    const handlers: Record<string, (a: typeof api, e: Record<string, unknown>, next: () => Promise<unknown>) => Promise<Element>> = {};
    register((name: string, ...args: unknown[]) => { handlers[name] = args.at(-1) as typeof handlers[string]; });
    const next = async () => ({});
    await handlers['session.start'](api, {}, next);
    expect(api.command.register).toHaveBeenCalledWith(expect.objectContaining({ name: 'memesh-memories' }));
    await handlers['command.run'](api, { args: 'ui-note' }, next);
    const render = () => handlers['ui.render'](api, { requestId: 'memesh-memory' }, next);
    let tree = await render();
    // The list names the folder and its path; the hashed project id is never shown.
    expect(JSON.stringify(tree)).toContain('~/Developer/ui-project');
    expect(JSON.stringify(tree)).not.toContain('project~');
    const select = find(tree, 'memesh-memory-0')!;
    expect(select).toBeDefined();
    await select.onPress!();
    tree = await render();
    expect(JSON.stringify(tree)).toContain('Original paragraph');
    expect(JSON.stringify(tree)).toContain('ui-project');
    expect(JSON.stringify(tree)).toContain('source not recorded');
    const edit = find(tree, 'memesh-edit')!;
    expect(edit.onPress!()).toBeUndefined(); // Returns at once: the form outlives a host press hook's 10s budget.
    tree = await render();
    const back = find(tree, 'memesh-back')!;
    await back.onPress!(); // Native buttons have no disabled property; navigation must respect busy itself.
    submit();
    await vi.waitFor(async () => { tree = await render(); expect(JSON.stringify(tree)).not.toContain('Working…'); });
    // The form took the keys; the pane asks for them back, or the next key lands in the prompt.
    expect(api.ui.open).toHaveBeenCalledTimes(2);
    expect(api.ui.open).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'memesh-memory', focus: true }));
    const memory = new KnowledgeGraph(getDatabase()).getEntity('ui-note');
    if (action === 'cancel') {
      expect(memory?.observations).toEqual(['Original paragraph']);
      expect(JSON.stringify(tree)).toContain('Cancelled. Nothing was changed.');
    } else {
      expect(memory).toMatchObject({ title: 'Saved title', observations: ['Saved paragraph'] });
      expect(JSON.stringify(tree)).toContain('Saved paragraph');
      expect(JSON.stringify(tree)).toContain('✓ Saved.');
    }
  });
});
