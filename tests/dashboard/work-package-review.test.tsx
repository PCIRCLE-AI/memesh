// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { InsightsTab } from '../../dashboard/src/components/InsightsTab';
import { SettingsTab } from '../../dashboard/src/components/SettingsTab';
import { setLocale, t } from '../../dashboard/src/lib/i18n';

function response(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const forbiddenRoutes = ['/v1/config/test', '/v1/reindex', '/v1/telemetry', '/v1/dream/run'];

beforeEach(() => {
  setLocale('en');
  localStorage.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals(); // restoreAllMocks does not undo vi.stubGlobal
  localStorage.clear();
});

// The `confirm` stub the Reject test installs; the last test checks that it did not outlive that test.
const confirmStub = () => true;

describe('FTS settings and staged work-package review', () => {
  it('Settings requests only retained config/update routes and saves only autoUpdate', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });
      if (url === '/v1/config' && method === 'POST') {
        return response({ autoUpdate: 'patch', setupCompleted: true });
      }
      if (url === '/v1/config') {
        return response({ config: { autoUpdate: 'off', setupCompleted: true } });
      }
      if (url.startsWith('/v1/update-status')) {
        return response({
          currentVersion: '4.8.5', latestVersion: '4.8.5', checkedAt: null,
          lastAttemptAt: null, lastSuccessfulCheckAt: null, lastError: null,
          updateAvailable: false, checkSucceeded: true, source: 'fresh', freshness: 'fresh',
          installChannel: 'npm-global', canSelfUpdate: true, recommendedCommand: null,
          currentVersionDeprecated: false, deprecationMessage: null,
        });
      }
      throw new Error(`unexpected route: ${method} ${url}`);
    });

    const view = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    await view.findByText('Auto-update policy');
    const policy = await waitFor(() => {
      const found = Array.from(view.container.querySelectorAll('select')).find((select) =>
        Array.from(select.options).some((option) => option.value === 'patch'));
      if (!found) throw new Error('auto-update policy not rendered');
      return found;
    });
    fireEvent.change(policy, { target: { value: 'patch' } });
    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));

    expect(calls.some((call) => forbiddenRoutes.some((route) => call.url.includes(route)))).toBe(false);
    const post = calls.find((call) => call.method === 'POST');
    expect(JSON.parse(post?.body ?? '{}')).toEqual({ autoUpdate: 'patch' });
  });

  it('keeps a pending transcript work package visible for detail and human accept/reject', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url, method });
      if (url === '/v1/dream/proposals/41') {
        return response({
          id: 41, project: 'memesh', cluster_key: 'transcript:session-1', source_ids: {
            sessionId: 'session-1', source: { host: 'claude-code', scope: 'mcp-workspace-root' }, workspaceHash: 'a'.repeat(64),
            coverage: { truncated: false, total_turns: 1, included_turns: 1 },
            sources: [{ role: 'user', text: 'Use the smaller parser.' }], trust: 'untrusted',
          },
          proposed_digest: { name: 'review-this', type: 'decision', observations: ['Keep the FTS-only design'], tags: ['project:memesh'] },
          status: 'pending', reason: null, created_at: '2026-09-06 01:00:00', reviewed_at: null,
          kind: 'digest', source_kind: 'transcript',
        });
      }
      if (url.startsWith('/v1/dream/proposals?')) {
        return response([{
          id: 41, project: 'memesh', cluster_key: 'transcript:session-1', source_count: 1,
          digest_name: 'review-this', digest_observations_preview: 'Keep the FTS-only design',
          status: 'pending', created_at: '2026-09-06 01:00:00', kind: 'digest', source_kind: 'transcript',
        }]);
      }
      if (url.endsWith('/accept') || url.endsWith('/reject')) return response({ id: 41, status: 'applied' });
      throw new Error(`unexpected route: ${method} ${url}`);
    });

    const view = render(<InsightsTab />);
    await view.findByText('review-this');
    expect(view.container.textContent).toContain('Claude Code transcript');
    expect(view.container.textContent).toContain('The Dashboard reviews proposals that are already staged.');
    expect(view.queryByRole('button', { name: 'Accept' })).toBeNull();
    fireEvent.click(view.getByRole('button', { name: 'View detail' }));
    await view.findByText('Keep the FTS-only design');
    const evidence = view.getByTestId('transcript-source-evidence');
    expect(evidence.textContent).toContain('claude-code');
    expect(evidence.textContent).toContain('session-1');
    expect(evidence.textContent).toContain('Use the smaller parser.');
    expect(view.getByRole('button', { name: 'Accept' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'Reject' })).toBeTruthy();
    expect(calls.some((call) => forbiddenRoutes.some((route) => call.url.includes(route)))).toBe(false);
    expect(calls.some((call) => call.url === '/v1/config')).toBe(false);
  });
});

// ── Review surface: what Accept did, what a card can show, quick double clicks ──

describe('InsightsTab review details', () => {
  const summary = (id: number, name: string) => ({
    id, project: 'memesh', cluster_key: `2026-W3${id}`, source_count: 2, digest_name: name,
    digest_observations_preview: `${name} preview`, status: 'pending', created_at: '2026-09-06 01:00:00', kind: 'digest',
  });
  const detail = (id: number, digest: unknown = { name: `d${id}`, type: 'digest', observations: [`OBS-${id}`], tags: [] }) => ({
    id, project: 'memesh', cluster_key: `2026-W3${id}`, source_ids: [1, 2], proposed_digest: digest,
    status: 'pending', reason: null, created_at: '2026-09-06 01:00:00', reviewed_at: null, kind: 'digest',
  });
  const route = (handlers: { list: unknown[]; detail?: (id: number) => unknown | Promise<unknown>; accept?: unknown }) =>
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const id = /\/v1\/dream\/proposals\/(\d+)(?:\/|$)/.exec(url)?.[1];
      if (method === 'POST' && url.endsWith('/accept')) return response(handlers.accept ?? { sourcesArchived: 0 });
      if (method === 'POST' && url.endsWith('/reject')) return response({});
      if (id && method === 'GET') return response(await handlers.detail!(Number(id)));
      if (url.startsWith('/v1/dream/proposals?')) return response(handlers.list);
      throw new Error(`unexpected route: ${method} ${url}`);
    });

  it('tells the reviewer how many source memories an accepted digest archived (and how many it left)', async () => {
    route({ list: [summary(1, 'digest-one')], detail: detail, accept: { sourcesArchived: 3, sourcesAlreadyCompacted: 1 } });
    const view = render(<InsightsTab />);
    fireEvent.click(await view.findByRole('button', { name: 'View detail' }));
    fireEvent.click(await view.findByRole('button', { name: 'Accept' }));

    await waitFor(() => expect(view.container.textContent).toContain(t('insights.acceptedArchived', { n: 3 })));
    expect(view.container.textContent).toContain(t('insights.acceptedKept', { n: 1 }));
  });

  describe('what the last accept did stops being shown once the reviewer moves on', () => {
    const acceptFirst = async () => {
      route({ list: [summary(1, 'digest-one')], detail: detail, accept: { sourcesArchived: 3 } });
      const view = render(<InsightsTab />);
      fireEvent.click(await view.findByRole('button', { name: 'View detail' }));
      fireEvent.click(await view.findByRole('button', { name: 'Accept' }));
      await waitFor(() => expect(view.container.textContent).toContain(t('insights.acceptedArchived', { n: 3 })));
      return view;
    };

    it('on Refresh', async () => {
      const view = await acceptFirst();
      fireEvent.click(view.getByRole('button', { name: t('insights.refresh') }));
      await waitFor(() => expect(view.container.textContent).not.toContain(t('insights.acceptedArchived', { n: 3 })));
    });

    it('on Reject', async () => {
      vi.stubGlobal('confirm', confirmStub);
      const view = await acceptFirst();
      fireEvent.click(view.getByRole('button', { name: 'Reject' }));
      await waitFor(() => expect(view.container.textContent).not.toContain(t('insights.acceptedArchived', { n: 3 })));
    });

    it('but not when the data-changed reload that the accept itself causes runs', async () => {
      const view = await acceptFirst();
      const calls = () => vi.mocked(globalThis.fetch).mock.calls.length;
      const before = calls();
      view.rerender(<InsightsTab dataRevision={1} />);
      await waitFor(() => expect(calls()).toBeGreaterThan(before)); // the reload ran
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(view.container.textContent).toContain(t('insights.acceptedArchived', { n: 3 }));
    });
  });

  it('offers no Accept for a proposal whose stored content cannot be shown, and says why', async () => {
    route({ list: [summary(1, 'digest-one')], detail: (id) => detail(id, null) });
    const view = render(<InsightsTab />);
    fireEvent.click(await view.findByRole('button', { name: 'View detail' }));

    await view.findByText(t('insights.contentUnreadable'));
    expect(view.queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(view.getByRole('button', { name: 'Reject' })).toBeTruthy();
  });

  it('keeps both details when two cards are expanded before either reply lands', async () => {
    const waiting = new Map<number, (v: unknown) => void>();
    route({
      list: [summary(1, 'digest-one'), summary(2, 'digest-two')],
      detail: (id) => new Promise((resolve) => { waiting.set(id, resolve); }),
    });
    const view = render(<InsightsTab />);
    await view.findByText('digest-two');
    const [first, second] = view.getAllByRole('button', { name: 'View detail' });
    fireEvent.click(first);
    fireEvent.click(second);
    await waitFor(() => expect(waiting.size).toBe(2));

    waiting.get(2)!(detail(2));
    await view.findByText('OBS-2');
    waiting.get(1)!(detail(1));
    await view.findByText('OBS-1');
    // The later reply used to be built from the state of ITS click and erased the other card.
    expect(view.container.textContent).toContain('OBS-2');
    expect(view.getAllByRole('button', { name: 'Collapse' })).toHaveLength(2);
  });

  it('reports "loading" from its very first render, not "loaded, nothing pending"', async () => {
    route({ list: [] });
    const onStateChange = vi.fn();
    render(<InsightsTab onStateChange={onStateChange} />);
    expect(onStateChange.mock.calls[0]![0].loading).toBe(true);
    await waitFor(() => expect(onStateChange.mock.calls[onStateChange.mock.calls.length - 1]![0].loading).toBe(false));
  });

  it('draws its filter row with the shared Chip: tokens only, no hand-rolled green fill', async () => {
    route({ list: [] });
    const view = render(<InsightsTab />);
    const group = await view.findByRole('group');
    const pressed = group.querySelector('button[aria-pressed="true"]') as HTMLElement;
    expect(pressed.getAttribute('style')).toContain('var(--life-soft)');
    expect(group.innerHTML).not.toMatch(/rgba\(143/);
  });

  // Keep this last: it checks that the Reject test's stub is gone.
  it('starts without the confirm stub of the test before it', () => {
    expect(globalThis.confirm).not.toBe(confirmStub);
  });
});
