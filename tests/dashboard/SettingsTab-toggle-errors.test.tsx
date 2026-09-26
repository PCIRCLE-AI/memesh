// @vitest-environment happy-dom
//
// The Behaviour toggle (autoUpdate select) used to swallow
// a failed POST in an empty catch, so the control snapped back with no signal —
// the user thought the setting saved. Guard that a failed write is surfaced.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, waitFor, within } from '@testing-library/preact';
import { SettingsTab } from '../../dashboard/src/components/SettingsTab';
import { setLocale } from '../../dashboard/src/lib/i18n';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Route fetch: GET /v1/config loads a config; POST /v1/config fails. */
function mockFetch(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST' && url.includes('/v1/config')) {
      return jsonResponse({ success: false, error: 'save failed' });
    }
    if (url.includes('/v1/config')) {
      return jsonResponse({
        success: true,
        data: {
          config: { autoUpdate: 'off' },
          capabilities: { searchLevel: 0 },
        },
      });
    }
    // update-status and anything else the tab loads on mount.
    return jsonResponse({ success: true, data: {} });
  });
}

describe('SettingsTab behaviour toggles surface POST failures', () => {
  afterEach(() => { vi.restoreAllMocks(); setLocale('en'); });

  it('preserves the off default when a valid config omits the update policy', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => jsonResponse({
      success: true, data: String(input).includes('/v1/config') ? { config: {} } : {},
    }));
    const { container } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    const policy = within(container as HTMLElement).getByLabelText('Auto-update policy') as HTMLSelectElement;
    await waitFor(() => expect(policy.disabled).toBe(false));
    expect(policy.value).toBe('off');
    expect(policy.selectedOptions[0].textContent).toBe('Off — manual only');
    expect(within(container as HTMLElement).queryByRole('alert')).toBeNull();
  });

  // #431 — an out-of-range stored sessionLimit must not disable the rest of
  // this card; there is no sessionLimit control here yet, so the contract
  // is just that the extra field is inert.
  it('renders normally when the stored config carries an out-of-range sessionLimit (#431)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => String(input).includes('/v1/config')
      ? jsonResponse({
        success: true,
        data: { config: { autoUpdate: 'minor', briefing: 'standard', sessionLimit: 500 } },
      })
      : jsonResponse({ success: true, data: {} }));
    const { container } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    const policy = within(container as HTMLElement).getByLabelText('Auto-update policy') as HTMLSelectElement;
    const briefing = within(container as HTMLElement).getByLabelText('Session start briefing') as HTMLSelectElement;
    await waitFor(() => expect(policy.disabled).toBe(false));
    expect(policy.value).toBe('minor');
    expect(briefing.disabled).toBe(false);
    expect(briefing.value).toBe('standard');
    expect(within(container as HTMLElement).queryByRole('alert')).toBeNull();
  });

  it('keeps the read failure localized and announced after changing language', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => String(input).includes('/v1/config')
      ? new Response(JSON.stringify({ success: false, error: 'fixture read failure' }), { status: 500 })
      : jsonResponse({ success: true, data: {} }));
    const view = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    await waitFor(() => expect(within(view.container as HTMLElement).getByRole('alert').textContent).toContain('Could not read settings'));
    setLocale('zh-TW');
    view.rerender(<SettingsTab locale="zh-TW" onLocaleChange={() => {}} />);
    expect(within(view.container as HTMLElement).getByRole('alert').textContent).toContain('無法讀取設定。請重新載入頁面再試一次。');
  });

  it.each(['http-error', 'invalid-shape'])('never presents an unreadable setting as off (%s)', async (failure) => {
    let recovered = false;
    const methods: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (!String(input).includes('/v1/config')) return jsonResponse({ success: true, data: {} });
      methods.push(init?.method ?? 'GET');
      if (recovered) return jsonResponse({ success: true, data: { config: { autoUpdate: 'minor' } } });
      return failure === 'invalid-shape'
        ? jsonResponse({ success: true, data: {} })
        : new Response(JSON.stringify({ success: false, error: 'fixture read failure', code: 'server.internal' }), { status: 500 });
    });
    const first = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    const policy = within(first.container as HTMLElement).getByLabelText('Auto-update policy') as HTMLSelectElement;
    await waitFor(() => expect(within(first.container as HTMLElement).getByRole('alert').textContent).toContain('Could not read settings. Reload the page to try again.'));
    expect(policy.disabled).toBe(true);
    expect(policy.value).toBe('');
    expect(policy.selectedOptions[0].textContent).toBe('unknown');
    first.unmount();
    recovered = true;
    const second = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    const reloaded = within(second.container as HTMLElement).getByLabelText('Auto-update policy') as HTMLSelectElement;
    await waitFor(() => expect(reloaded.value).toBe('minor'));
    expect(reloaded.disabled).toBe(false);
    expect(within(second.container as HTMLElement).queryByRole('alert')).toBeNull();
    expect(methods.every((method) => method === 'GET')).toBe(true);
  });

  it('does not guess a policy while the settings request is still loading', async () => {
    let resolveConfig!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolveConfig = resolve; });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => String(input).includes('/v1/config')
      ? pending : jsonResponse({ success: true, data: {} }));
    const { container } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    const policy = within(container as HTMLElement).getByLabelText('Auto-update policy') as HTMLSelectElement;
    expect(policy.disabled).toBe(true);
    expect(policy.value).toBe('');
    expect(policy.selectedOptions[0].textContent).toBe('Loading…');
    resolveConfig(jsonResponse({ success: true, data: { config: { autoUpdate: 'minor' } } }));
    await waitFor(() => expect(policy.value).toBe('minor'));
    expect(policy.disabled).toBe(false);
  });

  it.each([false, true])('only shows upgrade instructions when an update exists: %s', async (updateAvailable) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('/v1/update-status')) return jsonResponse({ success: true, data: {
        currentVersion: '4.9.0', latestVersion: updateAvailable ? '4.9.1' : '4.8.5',
        checkSucceeded: true, freshness: 'fresh', updateAvailable,
        installChannel: 'source-checkout', canSelfUpdate: false,
        recommendedCommand: 'test-upgrade-command',
      } });
      return jsonResponse({ success: true, data: { config: { autoUpdate: 'off' }, capabilities: { searchLevel: 0 } } });
    });
    const { container } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    await waitFor(() => expect(container.textContent).toContain('4.9.0'));
    expect(container.textContent?.includes('test-upgrade-command')).toBe(updateAvailable);
  });

  it.each([false, true])('keeps update failure details collapsed and supports recovery (partial=%s)', async (partial) => {
    let recovered = false;
    const requests: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/v1/update-status')) {
        requests.push(url);
        return jsonResponse({ success: true, data: {
          currentVersion: '4.10.1', latestVersion: partial || recovered ? '4.9.4' : null,
          checkSucceeded: partial || recovered, freshness: partial || recovered ? 'fresh' : 'unavailable',
          updateAvailable: false, lastAttemptAt: new Date().toISOString(),
          lastError: recovered ? null : 'npm error ECONNREFUSED diagnostic-fixture',
          installChannel: 'source-checkout', canSelfUpdate: false,
        } });
      }
      return jsonResponse({ success: true, data: { config: { autoUpdate: 'off' }, capabilities: { searchLevel: 0 } } });
    });
    const { container } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    await waitFor(() => expect(container.textContent).toContain('Check your connection and npm registry settings'));
    const details = Array.from(container.querySelectorAll('details')).find((el) => el.textContent?.includes('diagnostic-fixture'));
    expect(details).toBeDefined();
    expect(details?.open).toBe(false);
    expect(details?.querySelector('summary')?.textContent).toBe('Technical details');
    const visibleCopy = container.cloneNode(true) as HTMLElement;
    visibleCopy.querySelectorAll('details').forEach((el) => el.remove());
    expect(visibleCopy.textContent).not.toContain('diagnostic-fixture');
    if (partial) expect(visibleCopy.textContent).toContain('Deprecation status is unknown');
    recovered = true;
    const requestsBeforeRetry = requests.length;
    fireEvent.click(within(container as HTMLElement).getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(container.textContent).not.toContain('diagnostic-fixture'));
    expect(requests.length).toBe(requestsBeforeRetry + 1);
    expect(requests[requests.length - 1]).toBe('/v1/update-status');
    expect(container.textContent).toContain('No newer release available');
    expect(container.textContent).not.toContain('Check your connection and npm registry settings');
  });

  it('shows the error instead of silently swallowing a failed autoUpdate write', async () => {
    mockFetch();
    const { container } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);

    // Wait for config to load — the autoUpdate <select> (the one with a
    // 'patch' option) is only rendered once config resolves.
    const select = await waitFor(() => {
      const sel = Array.from(container.querySelectorAll('select')).find((s) =>
        Array.from(s.options).some((o) => o.value === 'patch'),
      );
      if (!sel) throw new Error('autoUpdate select not rendered yet');
      return sel as HTMLSelectElement;
    });

    fireEvent.change(select, { target: { value: 'patch' } });

    await waitFor(() => {
      expect(container.textContent).toContain('save failed');
    });
  });
});
