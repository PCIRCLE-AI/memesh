// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/preact';
import { ProjectTab, TaskStateCard } from '../../dashboard/src/components/ProjectTab';
import { t } from '../../dashboard/src/lib/i18n';

function response(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'content-type': 'application/json' } });
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Project tab: the stated task state (#237)', () => {
  it('a failed task-state fetch is shown as a failure, never as "nothing stated"', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/projects')) return Promise.resolve(response([{ name: 'solo', count: 1 }]));
      if (url.includes('/v1/entities')) return Promise.resolve(response([]));
      if (url.includes('/v1/task-state')) return Promise.resolve(new Response(JSON.stringify({ success: false, error: 'boom' }), { status: 500, headers: { 'content-type': 'application/json' } }));
      return Promise.resolve(response({}));
    }) as typeof fetch);
    const { container } = render(<ProjectTab dataRevision={0} health={{ status: 'ok', version: 't', entity_count: 1 }} />);
    await waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent ?? '').not.toBe(''));
    expect(container.textContent).not.toContain(t('project.taskState.empty'));
  });

  it('renders exactly the fields the owner stated, with provenance, and never invents progress', () => {
    const { container } = render(<TaskStateCard error="" data={{ project: 'p', state: { goal: 'Ship 4.10.0', blocked: 'CI flake', updated_at: new Date().toISOString() } }} />);
    const text = container.textContent ?? '';
    expect(text).toContain(t('project.taskState.title'));
    expect(text).toContain('Ship 4.10.0');
    expect(text).toContain('CI flake');
    expect(text).toContain(t('project.taskState.provenance'));
    // Not stated → not shown; no percentage, no invented "next".
    expect(text).not.toContain(t('project.taskState.next'));
    expect(text).not.toContain(t('project.taskState.done'));
    expect(text).not.toMatch(/%/);
  });

  it('says honestly that nothing was stated, and tells the user how to state it', () => {
    const { container } = render(<TaskStateCard error="" data={{ project: 'p', state: {} }} />);
    expect(container.textContent).toContain(t('project.taskState.empty'));
    expect(container.textContent).toContain('memesh task --goal');
  });

  it('reports a failed fetch as a failure, not as "nothing stated"', () => {
    const { container } = render(<TaskStateCard error="server down" data={null} />);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('server down');
    expect(container.textContent).not.toContain(t('project.taskState.empty'));
  });

  it('ProjectTab fetches /v1/task-state for the selected project', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/v1/entities')) return response([{ id: 1, name: 'e1', type: 'decision', created_at: '2026-09-01T00:00:00.000Z', observations: ['x'], tags: ['project:alpha'], access_count: 0 }]);
      if (url === '/v1/projects') return response([{ name: 'alpha', count: 1, types: ['decision'], source: 'tag' }]);
      if (url.startsWith('/v1/task-state?project=alpha')) return response({ project: 'alpha', state: { goal: 'Alpha goal' } });
      return response({});
    });
    const { container } = render(<ProjectTab health={{ status: 'ok', version: 't', entity_count: 1 }} />);
    await waitFor(() => expect(container.textContent).toContain('Alpha goal'));
    expect(container.textContent).toContain(t('project.taskState.provenance'));
  });
});
