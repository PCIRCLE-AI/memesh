// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { InsightsTab } from '../../dashboard/src/components/InsightsTab';
import { SettingsTab } from '../../dashboard/src/components/SettingsTab';
import { setLocale } from '../../dashboard/src/lib/i18n';

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
  localStorage.clear();
});

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
