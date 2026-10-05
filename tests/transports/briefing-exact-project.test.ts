/**
 * #527 (review r2): `briefing` must look a project up exactly as `learn` and
 * `task_state` stored it — no trimming, no Unicode normalising — or a lesson
 * stored under a decomposed-Unicode or space-padded project never shows in that
 * project's briefing.
 */
import { describe, expect, it } from 'vitest';
import { handleTool } from '../../src/transports/mcp/handlers.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

useTestDatabase('memesh-briefing-exact-');

const text = (r: { content: Array<{ text?: string }> }) => r.content[0]?.text ?? '';

describe('briefing reads the exact project a lesson was stored under', () => {
  it.each(['café', ' padded ', 'plain'])('learn then briefing for %j', async (project) => {
    const learned = await handleTool('learn', { project, error: 'unique lesson', fix: 'unique fix' }, 'codex');
    expect(learned.isError).toBeUndefined();
    const b = await handleTool('briefing', { project }, 'codex');
    expect(b.isError).toBeUndefined();
    const data = JSON.parse(text(b));
    expect(data.project).toBe(project);
    expect(JSON.stringify(data.index)).toContain('unique lesson');
  });

  it('still refuses empty, blank and path-shaped projects', async () => {
    for (const project of ['', '   ', '/Users/x/proj', 'a/b']) {
      expect((await handleTool('briefing', { project }, 'codex')).isError, JSON.stringify(project)).toBe(true);
    }
  });
});
