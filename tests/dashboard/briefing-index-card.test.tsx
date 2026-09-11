// @vitest-environment happy-dom
// #323 — the Project tab shows the durable-memory index an agent receives.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/preact';
import { BriefingIndexCard, ProjectTab } from '../../dashboard/src/components/ProjectTab';
import { t } from '../../dashboard/src/lib/i18n';
import type { BriefingIndexData } from '../../dashboard/src/lib/api';

function response(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function index(overrides: Partial<BriefingIndexData> = {}): BriefingIndexData {
  return {
    project: 'alpha',
    staleDays: 180,
    lines: [
      'Index of durable memories for "alpha" (newest first):',
      '- [decision] Keep the index capped [mem:7]',
      '- [lesson_learned] Revert the fix and confirm red [mem:3]',
      '(index cost: 2 lines, 150 bytes ≈ 38 tokens; cap 40 lines / 3072 bytes)',
    ],
    shown: 2, more: 0, older: 0, truncated: false, bytes: 150, tokens: 38, ids: [7, 3],
    ...overrides,
  };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Project tab: the durable-memory index (#323)', () => {
  it('lists the memory lines the agent receives, with their handles, and the cost', () => {
    const { container } = render(<BriefingIndexCard error="" data={index()} />);
    const items = [...container.querySelectorAll('li')].map((li) => li.textContent);
    expect(items).toHaveLength(2);
    expect(items).toEqual(['[decision] Keep the index capped [mem:7]', '[lesson_learned] Revert the fix and confirm red [mem:3]']);
    expect(container.textContent).toContain(t('project.index.title'));
    expect(container.textContent).toContain(t('project.index.cost', { tokens: 38, bytes: 150 }));
    expect(container.textContent).not.toContain(t('project.index.empty'));
  });

  it('shows the overflow and staleness lines so the cap is visible', () => {
    const { container } = render(<BriefingIndexCard error="" data={index({ more: 12, older: 4, truncated: true })} />);
    expect(container.textContent).toContain(t('project.index.more', { n: '12+', project: 'alpha' }));
    expect(container.textContent).toContain(t('project.index.older', { n: '4+', days: 180 }));
  });

  it('an empty project says so honestly', () => {
    const { container } = render(<BriefingIndexCard error="" data={index({ lines: ['Index…', '- No durable memories… yet.', '(index cost: 0 lines…)'], shown: 0, ids: [] })} />);
    expect(container.textContent).toContain(t('project.index.empty'));
    expect(container.querySelectorAll('li')).toHaveLength(0);
  });

  it('a failed fetch is a failure, never "no durable memories"', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/v1/entities')) return response([]);
      if (url === '/v1/projects') return response([{ name: 'alpha', count: 1, types: ['decision'], source: 'tag' }]);
      if (url.startsWith('/v1/task-state')) return response({ project: 'alpha', state: {} });
      if (url.startsWith('/v1/briefing-index')) return new Response(JSON.stringify({ success: false, error: 'boom' }), { status: 500, headers: { 'content-type': 'application/json' } });
      return response({});
    });
    const { container } = render(<ProjectTab health={{ status: 'ok', version: 't', entity_count: 1 }} />);
    await waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent ?? '').not.toBe(''));
    expect(container.textContent).not.toContain(t('project.index.empty'));
  });

  it('ProjectTab fetches /v1/briefing-index for the selected project', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/v1/entities')) return response([]);
      if (url === '/v1/projects') return response([{ name: 'alpha', count: 1, types: ['decision'], source: 'tag' }]);
      if (url.startsWith('/v1/task-state')) return response({ project: 'alpha', state: {} });
      if (url.startsWith('/v1/briefing-index?project=alpha')) return response(index());
      return response({});
    });
    const { container } = render(<ProjectTab health={{ status: 'ok', version: 't', entity_count: 1 }} />);
    await waitFor(() => expect(container.textContent).toContain('Keep the index capped [mem:7]'));
  });
});
