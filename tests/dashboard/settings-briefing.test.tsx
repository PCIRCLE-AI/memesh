// @vitest-environment happy-dom
//
// The Settings tab's briefing-level control (#360). Its rules mirror the
// autoUpdate select next to it: never show a setting the server did not
// confirm, never present an unreadable or unrecognised stored value as a real
// level, and only say "Saved." after a read-back agrees.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, waitFor, within } from '@testing-library/preact';
import { SettingsTab } from '../../dashboard/src/components/SettingsTab';
import { setLocale } from '../../dashboard/src/lib/i18n';
import { BRIEFING_LEVELS } from '../../src/core/briefing-level';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface Server {
  posts: unknown[];
}

/** A tiny fake of GET/POST /v1/config that stores what it is told to store. */
function fakeServer(initial: Record<string, unknown>, opts: { failPost?: boolean; ignorePost?: boolean } = {}): Server {
  const state: { config: Record<string, unknown> } = { config: { ...initial } };
  const server: Server = { posts: [] };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes('/v1/config')) return jsonResponse({ success: true, data: {} });
    if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
      server.posts.push(JSON.parse(String(init?.body)));
      if (opts.failPost) return jsonResponse({ success: false, error: 'save failed' }, 500);
      if (!opts.ignorePost) state.config = { ...state.config, ...JSON.parse(String(init?.body)) };
      return jsonResponse({ success: true, data: { config: state.config } });
    }
    return jsonResponse({ success: true, data: { config: state.config } });
  });
  return server;
}

function briefingSelect(container: HTMLElement): HTMLSelectElement {
  return within(container).getByLabelText('Session start briefing') as HTMLSelectElement;
}

describe('SettingsTab briefing level', () => {
  afterEach(() => { vi.restoreAllMocks(); setLocale('en'); });

  it('offers exactly the core levels, in the core order', async () => {
    fakeServer({});
    const { container } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    const select = briefingSelect(container as HTMLElement);
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(Array.from(select.options).map((o) => o.value)).toEqual([...BRIEFING_LEVELS]);
  });

  it('shows the default (Minimal) when nothing is stored', async () => {
    fakeServer({});
    const { container } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    const select = briefingSelect(container as HTMLElement);
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(select.value).toBe('minimal');
    expect(select.selectedOptions[0].textContent).toBe('Minimal — memories from this project only (default)');
  });

  it.each(['standard', 'full'])('shows the stored level %s', async (level) => {
    fakeServer({ briefing: level });
    const { container } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    const select = briefingSelect(container as HTMLElement);
    await waitFor(() => expect(select.value).toBe(level));
    expect(select.disabled).toBe(false);
  });

  it.each([['an unknown word', 'bogus'], ['a number', 42], ['null', null]])(
    'never presents %s as a level, and lets the user replace it',
    async (_label, stored) => {
      const server = fakeServer({ briefing: stored });
      const { container } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
      const select = briefingSelect(container as HTMLElement);
      await waitFor(() => expect(select.disabled).toBe(false));
      expect(select.value).toBe('');
      expect(select.selectedOptions[0].textContent).toBe('Saved value not recognised — Minimal is used. Pick a level to replace it.');
      fireEvent.change(select, { target: { value: 'full' } });
      await waitFor(() => expect(select.value).toBe('full'));
      expect(server.posts).toEqual([{ briefing: 'full' }]);
    },
  );

  it('does not guess a level while settings are loading', async () => {
    let resolveConfig!: (r: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolveConfig = resolve; });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => String(input).includes('/v1/config')
      ? pending : jsonResponse({ success: true, data: {} }));
    const { container } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    const select = briefingSelect(container as HTMLElement);
    expect(select.disabled).toBe(true);
    expect(select.value).toBe('');
    expect(select.selectedOptions[0].textContent).toBe('Loading…');
    resolveConfig(jsonResponse({ success: true, data: { config: { briefing: 'standard' } } }));
    await waitFor(() => expect(select.value).toBe('standard'));
  });

  it('never presents an unreadable setting as Minimal', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => String(input).includes('/v1/config')
      ? jsonResponse({ success: false, error: 'fixture read failure' }, 500)
      : jsonResponse({ success: true, data: {} }));
    const { container } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    const select = briefingSelect(container as HTMLElement);
    await waitFor(() => expect(within(container as HTMLElement).getByRole('alert').textContent).toContain('Could not read settings'));
    expect(select.disabled).toBe(true);
    expect(select.value).toBe('');
    expect(select.selectedOptions[0].textContent).toBe('unknown');
  });

  it('writes only the briefing key, re-reads it, and then says Saved', async () => {
    const server = fakeServer({ autoUpdate: 'minor' });
    const { container } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    const select = briefingSelect(container as HTMLElement);
    await waitFor(() => expect(select.disabled).toBe(false));
    fireEvent.change(select, { target: { value: 'standard' } });
    await waitFor(() => expect(container.textContent).toContain('Saved.'));
    expect(server.posts).toEqual([{ briefing: 'standard' }]);
    expect(select.value).toBe('standard');
    const autoUpdate = within(container as HTMLElement).getByLabelText('Auto-update policy') as HTMLSelectElement;
    expect(autoUpdate.value).toBe('minor');
  });

  it('still writes only the autoUpdate key from the autoUpdate select', async () => {
    const server = fakeServer({ briefing: 'full' });
    const { container } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    const autoUpdate = within(container as HTMLElement).getByLabelText('Auto-update policy') as HTMLSelectElement;
    await waitFor(() => expect(autoUpdate.disabled).toBe(false));
    fireEvent.change(autoUpdate, { target: { value: 'patch' } });
    await waitFor(() => expect(container.textContent).toContain('Saved.'));
    expect(server.posts).toEqual([{ autoUpdate: 'patch' }]);
    expect(briefingSelect(container as HTMLElement).value).toBe('full');
  });

  it('does not say Saved when the auto-update read-back disagrees either', async () => {
    fakeServer({ autoUpdate: 'off' }, { ignorePost: true });
    const { container } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    const autoUpdate = within(container as HTMLElement).getByLabelText('Auto-update policy') as HTMLSelectElement;
    await waitFor(() => expect(autoUpdate.disabled).toBe(false));
    fireEvent.change(autoUpdate, { target: { value: 'patch' } });
    await waitFor(() => expect(within(container as HTMLElement).getByRole('alert').textContent).toContain('The server did not return the saved setting'));
    expect(container.textContent).not.toContain('Saved.');
    expect(autoUpdate.value).toBe('off');
  });

  it('surfaces a failed write and keeps showing the stored level', async () => {
    fakeServer({ briefing: 'standard' }, { failPost: true });
    const { container } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    const select = briefingSelect(container as HTMLElement);
    await waitFor(() => expect(select.value).toBe('standard'));
    fireEvent.change(select, { target: { value: 'full' } });
    await waitFor(() => expect(within(container as HTMLElement).getByRole('alert').textContent).toContain('save failed'));
    expect(container.textContent).not.toContain('Saved.');
    expect(select.value).toBe('standard');
  });

  it('does not say Saved when the read-back disagrees with what was written', async () => {
    fakeServer({ briefing: 'standard' }, { ignorePost: true });
    const { container } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    const select = briefingSelect(container as HTMLElement);
    await waitFor(() => expect(select.value).toBe('standard'));
    fireEvent.change(select, { target: { value: 'full' } });
    await waitFor(() => expect(within(container as HTMLElement).getByRole('alert').textContent).toContain('The server did not return the saved setting'));
    expect(container.textContent).not.toContain('Saved.');
    expect(select.value).toBe('standard');
  });

  it('is labelled in the interface language', async () => {
    setLocale('zh-TW');
    fakeServer({});
    const { container } = render(<SettingsTab locale="zh-TW" onLocaleChange={() => {}} />);
    const select = within(container as HTMLElement).getByLabelText('Session 開始時的 briefing 層級') as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(select.selectedOptions[0].textContent).toBe('Minimal — 只含這個專案的記憶（預設）');
  });
});
