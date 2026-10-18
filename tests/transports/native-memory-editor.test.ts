import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ElicitRequestFormParams, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { remember } from '../../src/core/operations.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { handleTool } from '../../src/transports/mcp/handlers.js';

describe('Native memory editing through the existing remember tool', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-native-edit-'));
    openDatabase(path.join(dir, 'test.db'));
    remember({ name: 'ui-note', type: 'note', title: 'Original title', observations: ['Original paragraph'], project: 'ui-project' });
  });
  afterEach(() => {
    closeDatabase();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const call = (elicit?: (params: ElicitRequestFormParams) => Promise<ElicitResult>) =>
    handleTool('remember', { name: 'ui-note', interactive: true }, 'codex', undefined,
      { projectBinding: { project: 'ui-project' }, ...(elicit ? { elicit } : {}) });
  const stored = () => new KnowledgeGraph(getDatabase()).getEntity('ui-note');
  const row = () => getDatabase().prepare('SELECT * FROM entities WHERE name = ?').get('ui-note');

  it.each(['cancel', 'decline'] as const)('%s shows the stored memory and writes nothing', async action => {
    const before = row();
    const elicit = vi.fn(async (params: ElicitRequestFormParams): Promise<ElicitResult> => {
      expect(JSON.stringify(params)).toContain('Original paragraph');
      expect(JSON.stringify(params)).toContain('Original title');
      return { action };
    });
    const result = await call(elicit);
    expect(result.isError).not.toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('cancelled') });
    expect(elicit).toHaveBeenCalledOnce();
    expect(row()).toEqual(before);
  });

  it('saves through the shared writer, reads back, keeps history and does not reinforce confidence', async () => {
    const confidence = stored()?.confidence;
    const result = await call(async () => ({ action: 'accept', content: { title: 'Changed title', body: 'Changed paragraph' } }));
    expect(result.isError).not.toBe(true);
    expect(stored()).toMatchObject({ title: 'Changed title', observations: ['Changed paragraph'], confidence });
    expect(stored()?.metadata?.replaced_history).toEqual(expect.arrayContaining([
      expect.objectContaining({ observations: ['Original paragraph'] }),
    ]));
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Changed paragraph') });
  });

  it('reports an unsupported host without writing or falling back to an automatic save', async () => {
    const before = row();
    const result = await call();
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('native_form_unavailable') });
    expect(row()).toEqual(before);
  });

  it('does not overwrite a memory changed while the user was editing', async () => {
    const result = await call(async () => {
      remember({ name: 'ui-note', type: 'note', observations: ['Concurrent update'], project: 'ui-project' });
      return { action: 'accept', content: { title: 'Stale title', body: 'Stale replacement' } };
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('memory_changed') });
    expect(stored()?.observations).toEqual(['Original paragraph', 'Concurrent update']);
  });

  it('refuses another project before displaying its content', async () => {
    const elicit = vi.fn();
    const result = await handleTool('remember', { name: 'ui-note', interactive: true, project: 'other-project' }, 'codex', undefined, { elicit });
    expect(result.isError).toBe(true);
    expect(elicit).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('Original paragraph');
  });

  it('leaves an accepted unchanged form byte-identical', async () => {
    const before = row();
    const result = await call(async () => ({ action: 'accept', content: { title: 'Original title', body: 'Original paragraph' } }));
    expect(result.isError).not.toBe(true);
    expect(row()).toEqual(before);
  });

  it('does not write on invalid form data or transport failure', async () => {
    const before = row();
    expect((await call(async () => ({ action: 'accept', content: { title: 'Bad', body: 42 } }))).isError).toBe(true);
    expect((await call(async () => { throw new Error('Form disconnected'); })).isError).toBe(true);
    expect(row()).toEqual(before);
  });

  it('cannot be given model-written replacement text alongside the human editor request', async () => {
    const before = row();
    const result = await handleTool('remember', { name: 'ui-note', interactive: true, project: 'ui-project', observations: ['Injected replacement'] });
    expect(result.isError).toBe(true);
    expect(row()).toEqual(before);
  });

  it('does not repair or overwrite malformed metadata as a side effect of editing', async () => {
    getDatabase().prepare('UPDATE entities SET metadata = ? WHERE name = ?').run('{broken', 'ui-note');
    const before = row();
    expect((await call(async () => ({ action: 'accept', content: { title: 'New title', body: 'New body' } }))).isError).toBe(true);
    expect(row()).toEqual(before);
  });

  const decisionParagraphs = ['Use PKCE for login.', 'Why: Avoid sharing a client secret; revisit if the client becomes confidential.'];
  const seedDecision = () => remember({ name: 'ui-note', type: 'decision', replace: true,
    title: 'Login decision', observations: decisionParagraphs, project: 'ui-project' });

  it('paragraph form: title-only submission preserves the decision reason without multiline defaults', async () => {
    seedDecision();
    const result = await call(async params => {
      expect(params.message).toContain(decisionParagraphs[1]);
      expect(params.requestedSchema.properties.body.title).toContain('Use PKCE for login.');
      expect(params.requestedSchema.properties.body_1.title).toContain('Why: Avoid sharing a client secret');
      for (const field of Object.values(params.requestedSchema.properties)) expect(field).not.toHaveProperty('default');
      return { action: 'accept', content: { title: 'Clearer title' } };
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(stored()).toMatchObject({ title: 'Clearer title', observations: decisionParagraphs });
  });

  it('paragraph form: accepting all blank fields changes no bytes', async () => {
    seedDecision();
    const before = row();
    expect((await call(async () => ({ action: 'accept', content: {} }))).isError).not.toBe(true);
    expect(row()).toEqual(before);
  });

  it('paragraph form: changing one paragraph preserves the others and their exact boundaries', async () => {
    seedDecision();
    const replacement = 'Updated login guidance.\n\nKeep the code example spacing.';
    expect((await call(async () => ({ action: 'accept', content: { body: replacement } }))).isError).not.toBe(true);
    expect(stored()).toMatchObject({ title: 'Login decision', observations: [replacement, decisionParagraphs[1]] });
  });
});
