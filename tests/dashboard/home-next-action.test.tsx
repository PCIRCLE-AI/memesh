// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { HomeTab, chooseNextAction } from '../../dashboard/src/components/HomeTab';
import { setLocale } from '../../dashboard/src/lib/i18n';

function response(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function stubHome(options: { proposals?: unknown[] } = {}) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/v1/dream/proposals')) return response(options.proposals ?? []);
    if (url.startsWith('/v1/stats')) return response({ totalEntities: 1, totalObservations: 1, totalRelations: 0, totalTags: 0, typeDistribution: [], tagDistribution: [], statusDistribution: [] });
    if (url.startsWith('/v1/citations')) return response({ total: 0, verified: 0, rate: null });
    return response({});
  });
}

beforeEach(() => {
  localStorage.clear();
  setLocale('en');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('issue #234 — one truthful next-best action', () => {
  it('uses a deterministic priority for retained states', () => {
    const ready = { pendingCount: 0, loading: false, failed: false };
    expect(chooseNextAction(0, ready)).toBe('empty');
    expect(chooseNextAction(4, { ...ready, pendingCount: 3 })).toBe('insights');
    expect(chooseNextAction(4, ready)).toBe('healthy');
  });

  it('routes an empty library to the existing Memories workflow without claiming completion', () => {
    stubHome();
    const onNavigate = vi.fn();
    const view = render(<HomeTab health={{ status: 'ok', version: '4.8.1', entity_count: 0 }} onNavigate={onNavigate} />);

    expect(view.getAllByRole('heading', { level: 2 })[0].textContent).toBe('Add your first memory');
    expect(view.container.textContent).toContain('Why:');
    expect(view.container.textContent).toContain('Expected result:');
    expect(view.container.textContent).not.toMatch(/completed|succeeded/i);
    fireEvent.click(view.getByRole('button', { name: 'Open Memories' }));
    expect(onNavigate).toHaveBeenCalledWith('Memories');
  });

  it('focuses the existing review surface for pending suggestions', async () => {
    stubHome({ proposals: [{ id: 1, status: 'pending', project: 'p', cluster_key: 'c', source_count: 2, digest_name: 'Review me', digest_observations_preview: 'preview', created_at: '2026-08-29 00:00:00' }] });
    const view = render(<HomeTab health={{ status: 'ok', version: '4.8.1', entity_count: 4 }} />);

    const action = await view.findByRole('button', { name: 'Review suggestions' });
    fireEvent.click(action);
    expect(document.activeElement?.id).toBe('home-insights');
  });

  it('shows an honest no-action state when no proposals need review', async () => {
    stubHome();
    const view = render(<HomeTab health={{ status: 'ok', version: '4.8.1', entity_count: 4 }} />);
    await waitFor(() => expect(view.getAllByRole('heading', { level: 2 })[0].textContent).toBe('No action needed right now'));
    expect(view.queryByRole('button', { name: /Open|Review/ })).toBeNull();
  });

  it('reports unavailable after proposal failure and loading while data is pending', () => {
    const ready = { pendingCount: 0, loading: false, failed: false };
    expect(chooseNextAction(4, { ...ready, failed: true })).toBe('unavailable');
    expect(chooseNextAction(4, { ...ready, loading: true })).toBe('loading');
    expect(chooseNextAction(null, ready)).toBe('loading');
    expect(chooseNextAction(4, { ...ready, loading: true, failed: true })).toBe('unavailable');
  });

  it('renders the unavailable state with a retry when proposal loading fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/v1/dream/proposals')) return new Response('<html>Bad Gateway</html>', { status: 502 });
      if (url.startsWith('/v1/stats')) return response({ totalEntities: 4, totalObservations: 4, totalRelations: 0, totalTags: 0, typeDistribution: [], tagDistribution: [], statusDistribution: [] });
      if (url.startsWith('/v1/citations')) return response({ total: 0, verified: 0, rate: null });
      return response({});
    });
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });

    const view = render(<HomeTab health={{ status: 'ok', version: '4.8.1', entity_count: 4 }} />);
    await waitFor(() => expect(view.getAllByRole('heading', { level: 2 })[0].textContent).toBe('Current recommendation is unavailable'));
    expect(view.container.textContent).not.toContain('No action needed right now');
    fireEvent.click(view.getByRole('button', { name: 'Retry status checks' }));
    expect(reload).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
