// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/preact';
import { App } from '../../dashboard/src/App';
import { t } from '../../dashboard/src/lib/i18n';

function response(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(globalThis, 'fetch').mockImplementation(((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/v1/health')) return Promise.resolve(response({ status: 'ok', version: 't', entity_count: 0 }));
    if (url.includes('/v1/projects') || url.includes('/v1/entities')) return Promise.resolve(response([]));
    return Promise.resolve(response({}));
  }) as typeof fetch);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); window.history.replaceState({}, '', '/'); });

async function selectedTab(container: Element): Promise<string | null> {
  await waitFor(() => expect(container.querySelector('[role="tab"][aria-selected="true"]')).not.toBeNull());
  return container.querySelector('[role="tab"][aria-selected="true"]')!.id;
}

describe('the removed Graph tab (#237) lands on Project', () => {
  it('for a bookmarked ?tab=Graph deep link', async () => {
    window.history.replaceState({}, '', '/?tab=Graph');
    const { container } = render(<App />);
    expect(await selectedTab(container)).toBe('tab-Project');
  });

  it('for a remembered tab preference', async () => {
    localStorage.setItem('memesh.tab', 'Graph');
    const { container } = render(<App />);
    expect(await selectedTab(container)).toBe('tab-Project');
  });
});

describe('App shell edges', () => {
  it('?tab=constructor is not a tab: it lands on Home, not on an Object.prototype function', async () => {
    window.history.replaceState({}, '', '/?tab=constructor');
    const { container } = render(<App />);
    expect(await selectedTab(container)).toBe('tab-Home');
  });

  it('a 401 from any request while a token is stored tells the user the token was rejected', async () => {
    localStorage.setItem('memesh_token', 'expired-token');
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector('[role="tab"]')).not.toBeNull());

    window.dispatchEvent(new Event('memesh:auth-required'));

    await waitFor(() => expect(container.textContent).toContain(t('auth.invalid')));
  });

  it('a failed health refetch is the classified sentence, never the browser\'s "Failed to fetch"', async () => {
    let healthDown = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/health')) {
        if (healthDown) return Promise.reject(new TypeError('Failed to fetch'));
        return Promise.resolve(response({ status: 'ok', version: 'vtest', entity_count: 3 }));
      }
      return Promise.resolve(response([]));
    }) as typeof fetch);
    const { container } = render(<App />);
    await waitFor(() => expect(container.textContent).toContain('vtest'));

    healthDown = true;
    window.dispatchEvent(new Event('memesh:data-changed'));

    await waitFor(() => expect(container.querySelector('.error-box[role="alert"]')).not.toBeNull());
    const text = container.querySelector('.error-box[role="alert"]')!.textContent ?? '';
    expect(text).toContain('Could not reach the memesh server');
    expect(text).not.toContain('Failed to fetch');
  });
});
