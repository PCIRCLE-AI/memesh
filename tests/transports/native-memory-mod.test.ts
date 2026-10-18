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

  it.each([
    ['terminal', 'cancel', false], ['terminal', 'accept', false],
    ['desktop', 'cancel', false], ['desktop', 'accept', false], ['desktop', 'accept', true],
  ] as const)('%s view → edit → %s (title only: %s) reads the actual result', async (surface, action, titleOnly) => {
    const original = titleOnly ? ['Original paragraph', 'Why: Keep the second paragraph.'] : ['Original paragraph'];
    if (titleOnly) remember({ name: 'ui-note', type: 'decision', replace: true, observations: original, project: 'ui-project' });
    const modulePath = pathToFileURL(path.resolve('hooks/native-memory.js')).href;
    const { register } = await import(modulePath);
    const result: ElicitResult = action === 'cancel' ? { action } : { action, content: { title: 'Saved title', body: 'Saved paragraph' } };
    let submit!: () => void;
    const formPending = new Promise<void>(resolve => { submit = resolve; });
    const elicit = vi.fn(async () => { await formPending; return result; });
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
        return handleTool(tool, args, 'claude-code', undefined, { projectBinding: { project: 'ui-project' }, elicit });
      }) },
    };
    type Element = { type: string; key?: string; children?: (Element | string)[]; onPress?: () => Promise<void> | void; onInput?: (value: string) => void };
    // The pane nests rows and button groups in Boxes, so look a key up anywhere in the tree.
    const find = (node: Element | string, key: string): Element | undefined => typeof node === 'string' ? undefined
      : node.key === key ? node : node.children?.map(child => find(child, key)).find(Boolean);
    const handlers: Record<string, (a: typeof api, e: Record<string, unknown>, next: () => Promise<unknown>) => Promise<Element>> = {};
    register((name: string, ...args: unknown[]) => { handlers[name] = args.at(-1) as typeof handlers[string]; });
    const next = async () => ({});
    await handlers['session.start'](api, {}, next);
    expect(api.command.register).toHaveBeenCalledWith(expect.objectContaining({ name: 'memesh-memories' }));
    await handlers['command.run'](api, { args: 'ui-note' }, next);
    const render = () => handlers['ui.render'](api, { requestId: 'memesh-memory', surface }, next);
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
    const beforeEdit = getDatabase().prepare('SELECT * FROM entities WHERE name = ?').get('ui-note');
    const edit = find(tree, 'memesh-edit')!;
    expect(edit.onPress!()).toBeUndefined(); // Returns at once: the form outlives a host press hook's 10s budget.
    if (surface === 'desktop') {
      await vi.waitFor(async () => { tree = await render(); expect(find(tree, 'memesh-title')).toBeDefined(); });
      find(tree, 'memesh-title')!.onInput!('Saved title');
      if (!titleOnly) find(tree, 'memesh-paragraph-0')!.onInput!('Saved paragraph');
      if (action === 'cancel') await find(tree, 'memesh-cancel')!.onPress!();
      else {
        const save = find(tree, 'memesh-save')!;
        save.onPress!();
        save.onPress!(); // A second click while saving must not submit twice.
      }
      expect(elicit).not.toHaveBeenCalled();
    } else {
      tree = await render();
      const back = find(tree, 'memesh-back')!;
      await back.onPress!(); // Native buttons have no disabled property; navigation must respect busy itself.
      submit();
    }
    await vi.waitFor(async () => { tree = await render(); expect(JSON.stringify(tree)).not.toContain('Working…'); });
    // The form took the keys; the pane asks for them back, or the next key lands in the prompt.
    expect(api.ui.open).toHaveBeenCalledTimes(surface === 'desktop' ? 1 : 2);
    expect(api.ui.open).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'memesh-memory', focus: true }));
    const memory = new KnowledgeGraph(getDatabase()).getEntity('ui-note');
    if (action === 'cancel') {
      expect(getDatabase().prepare('SELECT * FROM entities WHERE name = ?').get('ui-note')).toEqual(beforeEdit);
      expect(memory?.observations).toEqual(original);
      expect(JSON.stringify(tree)).toContain(surface === 'desktop' ? 'Cancelled. Your edits were not saved.' : 'Cancelled. Nothing was changed.');
      if (surface === 'desktop') expect(api.mcp.call.mock.calls.filter(([, , args]) => (args.editor as { action?: string } | undefined)?.action === 'save')).toHaveLength(0);
    } else {
      expect(memory).toMatchObject({ title: 'Saved title', observations: titleOnly ? original : ['Saved paragraph'] });
      expect(JSON.stringify(tree)).toContain(titleOnly ? original[1] : 'Saved paragraph');
      expect(JSON.stringify(tree)).toContain('✓ Saved.');
      if (surface === 'desktop') expect(api.mcp.call.mock.calls.filter(([, , args]) => (args.editor as { action?: string } | undefined)?.action === 'save')).toHaveLength(1);
    }
  });
});
