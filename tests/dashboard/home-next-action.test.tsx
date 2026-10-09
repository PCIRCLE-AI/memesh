// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { HomeTab, chooseNextAction } from '../../dashboard/src/components/HomeTab';
import { App } from '../../dashboard/src/App';
import { InsightsTab } from '../../dashboard/src/components/InsightsTab';
import { getLocales, setLocale, t } from '../../dashboard/src/lib/i18n';

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
    expect(view.queryByText(t('insights.emptyPending'))).toBeNull();
    fireEvent.click(view.getByRole('button', { name: 'Retry status checks' }));
    expect(reload).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

describe('next-action truthfulness', () => {
  it('shows an empty review queue only after a successful refresh (#538)', async () => {
    let fail = true;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => fail
      ? new Response('<html>Bad Gateway</html>', { status: 502 })
      : response([]));
    const view = render(<InsightsTab />);
    await view.findByRole('alert');
    expect(view.queryByText(t('insights.emptyPending'))).toBeNull();
    fail = false;
    fireEvent.click(view.getByRole('button', { name: t('insights.refresh') }));
    await view.findByText(t('insights.emptyPending'));
    expect(view.queryByRole('alert')).toBeNull();
    fail = true;
    fireEvent.click(view.getByRole('button', { name: t('insights.refresh') }));
    await view.findByRole('alert');
    expect(view.queryByText(t('insights.emptyPending'))).toBeNull();
  });

  it('does not recommend no action while the existing setup check reports an actionable failure (#538)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/v1/doctor')) return response({ status: 'FAIL', checks: [{ id: 'hook-wiring', label: 'Setup fixture', status: 'fail', summary: 'Setup is incomplete', fix: 'Run memesh doctor' }] });
      if (url.startsWith('/v1/health')) return response({ status: 'ok', version: '4.10.12', entity_count: 4 });
      if (url.startsWith('/v1/dream/proposals')) return response([]);
      if (url.startsWith('/v1/stats')) return response({ totalEntities: 4, totalObservations: 4, totalRelations: 0, totalTags: 0, typeDistribution: [], tagDistribution: [], statusDistribution: [] });
      if (url.startsWith('/v1/citations')) return response({ total: 0, verified: 0, rate: null });
      return response({});
    });
    const view = render(<App />);
    await view.findByText(/Setup is incomplete/);
    // Wait for the review queue too: the original contradiction arrives
    // only after both independent requests have completed.
    await view.findByText(t('insights.emptyPending'));
    await waitFor(() => expect(view.queryByRole('heading', { name: t('home.nextAction.loading.title') })).toBeNull());
    expect(view.queryByRole('heading', { name: 'No action needed right now' })).toBeNull();
    expect(view.getByRole('heading', { name: t('home.nextAction.setup.title') })).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: t('doctorBanner.dismiss') }));
    expect(view.getByRole('heading', { name: t('home.nextAction.setup.title') })).toBeTruthy();
  });

  it('prioritizes setup states without suppressing a ready library workflow', () => {
    const ready = { pendingCount: 3, loading: false, failed: false };
    expect(chooseNextAction(0, ready, false, 'attention')).toBe('setup');
    expect(chooseNextAction(4, ready, false, 'loading')).toBe('loading');
    expect(chooseNextAction(4, ready, false, 'unavailable')).toBe('unavailable');
    expect(chooseNextAction(4, ready, false, 'ready')).toBe('insights');
    expect(chooseNextAction(0, ready, false, 'ready')).toBe('empty');
  });

  it.each([
    { doctor: { status: 'PASS', checks: [] }, expected: 'home.nextAction.healthy.title' },
    { doctor: { status: 'PASS_WITH_CONCERNS', checks: [{ id: 'update', label: 'Update status', summary: 'No cached update', status: 'warn', code: 'update-status.no-cache', fix: 'Check later' }] }, expected: 'home.nextAction.healthy.title' },
    { doctor: {}, expected: 'home.nextAction.unavailable.title' },
    { doctor: { checks: [] }, expected: 'home.nextAction.unavailable.title' },
    { doctor: { status: 'unexpected', checks: [] }, expected: 'home.nextAction.unavailable.title' },
    { doctor: { status: 'PASS', checks: [null] }, expected: 'home.nextAction.unavailable.title' },
  ])('uses the existing doctor result ($expected)', async ({ doctor, expected }) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/v1/doctor')) return response(doctor);
      if (url.startsWith('/v1/health')) return response({ status: 'ok', version: '4.10.12', entity_count: 4 });
      if (url.startsWith('/v1/dream/proposals')) return response([]);
      if (url.startsWith('/v1/citations')) return response({ total: 0, verified: 0, rate: null });
      return response({});
    });
    const view = render(<App />);
    await view.findByRole('heading', { name: t(expected) });
  });

  it('does not say it checked a "search index" — no input to the decision reads one', () => {
    // Every locale, each with its own word for "index" (the old texts named it).
    const indexWord = /search index|搜尋索引|搜索索引|検索インデックス|검색 인덱스|índice|\bindex\b|Suchindex|chỉ mục|ดัชนี/i;
    const locales = getLocales();
    expect(locales).toHaveLength(11);
    try {
      for (const { code } of locales) {
        setLocale(code);
        for (const key of ['home.nextAction.loading.why', 'home.nextAction.healthy.why']) {
          expect(t(key), `${code} ${key}`).not.toMatch(indexWord);
        }
      }
    } finally {
      setLocale('en');
    }
  });

  it('a library size that never arrives because /v1/health failed is "unavailable", not "checking" forever', async () => {
    const ready = { pendingCount: 0, loading: false, failed: false };
    expect(chooseNextAction(null, ready, true)).toBe('unavailable');
    expect(chooseNextAction(null, { ...ready, loading: true }, true)).toBe('unavailable');
    expect(chooseNextAction(null, ready, false)).toBe('loading');
    // A health reading that DID arrive wins over a stale failure flag.
    expect(chooseNextAction(4, ready, true)).toBe('healthy');

    stubHome();
    const view = render(<HomeTab health={null} healthFailed />);
    await waitFor(() => expect(view.getAllByRole('heading', { level: 2 })[0].textContent).toBe('Current recommendation is unavailable'));
  });
});
