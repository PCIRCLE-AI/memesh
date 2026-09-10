// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/preact';
import { App } from '../../dashboard/src/App';

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
