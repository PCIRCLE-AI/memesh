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

interface FakeOptions { failPost?: boolean; ignorePost?: boolean; holdPost?: boolean }

interface Server {
  posts: unknown[];
  /** Mutable: a test can flip failPost / holdPost between saves. */
  opts: FakeOptions;
  /** Lets a held POST (holdPost) finish. */
  release: () => void;
}

/** A tiny fake of GET/POST /v1/config that stores what it is told to store. */
function fakeServer(initial: Record<string, unknown>, opts: FakeOptions = {}): Server {
  const state: { config: Record<string, unknown> } = { config: { ...initial } };
  const server: Server = { posts: [], opts, release: () => {} };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes('/v1/config')) return jsonResponse({ success: true, data: {} });
    if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
      server.posts.push(JSON.parse(String(init?.body)));
      if (opts.holdPost) await new Promise<void>((resolve) => { server.release = resolve; });
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

/** Every id a select's aria-describedby names must exist in the DOM, in every state. */
function expectDescribedByResolves(root: HTMLElement): void {
  const selects = Array.from(root.querySelectorAll('select[aria-describedby]'));
  expect(selects.length).toBeGreaterThan(0);
  for (const select of selects) {
    for (const id of (select.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)) {
      expect(root.querySelector(`#${id}`), `#${id} named by aria-describedby must exist`).not.toBeNull();
    }
  }
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

  it('names each level and explains the setting', async () => {
    fakeServer({});
    const { container } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    const select = briefingSelect(container as HTMLElement);
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      'Minimal — memories from this project only (default)',
      'Standard — adds the current task state and a memory index',
      'Full — adds global memory, other projects and work-package notices',
    ]);
    const hint = container.querySelector('#settings-briefing-hint') as HTMLElement;
    expect(hint.textContent).toContain('the briefing tool returns');
    expect(hint.textContent).toContain('on their next call');
    expect(hint.textContent).toContain('MEMESH_BRIEFING overrides this setting');
    expect(select.getAttribute('aria-describedby')).toBe('settings-briefing-hint');
    expect(select.getAttribute('aria-invalid')).toBeNull();
    expectDescribedByResolves(container as HTMLElement);
  });

  it.each([['an unknown word', 'bogus'], ['a level in the wrong case', 'Standard'], ['a number', 42], ['null', null]])(
    'never presents %s as a level, and lets the user replace it',
    async (_label, stored) => {
      const server = fakeServer({ briefing: stored });
      const { container } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
      const select = briefingSelect(container as HTMLElement);
      await waitFor(() => expect(select.disabled).toBe(false));
      expect(select.value).toBe('');
      expect(select.selectedOptions[0].textContent).toBe('Saved value not recognised — Minimal is used. Pick a level to replace it.');
      expect(select.options[0].disabled).toBe(true);
      expect(select.getAttribute('aria-invalid')).toBe('true');
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

  it('shows each save outcome under the control it belongs to', async () => {
    fakeServer({});
    const { container } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    const root = container as HTMLElement;
    const briefing = briefingSelect(root);
    const autoUpdate = within(root).getByLabelText('Auto-update policy') as HTMLSelectElement;
    const messageOf = (id: string) => root.querySelector(`#${id}`)?.textContent ?? null;
    await waitFor(() => expect(briefing.disabled).toBe(false));

    expectDescribedByResolves(root);
    fireEvent.change(briefing, { target: { value: 'standard' } });
    await waitFor(() => expect(messageOf('settings-briefing-message')).toBe('Saved.'));
    expect(messageOf('settings-autoupdate-message')).toBeNull();
    expect(briefing.getAttribute('aria-describedby')).toBe('settings-briefing-hint settings-briefing-message');
    expectDescribedByResolves(root);

    fireEvent.change(autoUpdate, { target: { value: 'patch' } });
    await waitFor(() => expect(messageOf('settings-autoupdate-message')).toBe('Saved.'));
    expect(messageOf('settings-briefing-message')).toBeNull();
    expect(autoUpdate.getAttribute('aria-describedby')).toBe('settings-autoupdate-hint settings-autoupdate-message');
    expect(briefing.getAttribute('aria-describedby')).toBe('settings-briefing-hint');
    expectDescribedByResolves(root);
  });

  it('announces a success politely and leaves both controls valid', async () => {
    fakeServer({});
    const { container } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    const root = container as HTMLElement;
    const briefing = briefingSelect(root);
    const autoUpdate = within(root).getByLabelText('Auto-update policy') as HTMLSelectElement;
    await waitFor(() => expect(briefing.disabled).toBe(false));
    fireEvent.change(autoUpdate, { target: { value: 'patch' } });
    await waitFor(() => expect(root.querySelector('#settings-autoupdate-message')?.textContent).toBe('Saved.'));
    expect(root.querySelector('#settings-autoupdate-message')?.getAttribute('role')).toBe('status');
    expect(within(root).queryByRole('alert')).toBeNull();
    expect(autoUpdate.getAttribute('aria-invalid')).toBeNull();
    expect(briefing.getAttribute('aria-invalid')).toBeNull();
    expectDescribedByResolves(root);
  });

  it('files a failed auto-update save under the auto-update control, not the briefing one', async () => {
    fakeServer({ briefing: 'standard' }, { failPost: true });
    const { container } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    const root = container as HTMLElement;
    const briefing = briefingSelect(root);
    const autoUpdate = within(root).getByLabelText('Auto-update policy') as HTMLSelectElement;
    await waitFor(() => expect(autoUpdate.disabled).toBe(false));
    fireEvent.change(autoUpdate, { target: { value: 'patch' } });
    const alert = await waitFor(() => within(root).getByRole('alert'));
    expect(alert.id).toBe('settings-autoupdate-message');
    expect(alert.textContent).toContain('save failed');
    expect(autoUpdate.getAttribute('aria-invalid')).toBe('true');
    expect(briefing.getAttribute('aria-invalid')).toBeNull();
    expectDescribedByResolves(root);
  });

  it('announces a failed save under the control that failed and marks only that control invalid', async () => {
    fakeServer({ briefing: 'standard' }, { failPost: true });
    const { container } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    const root = container as HTMLElement;
    const briefing = briefingSelect(root);
    const autoUpdate = within(root).getByLabelText('Auto-update policy') as HTMLSelectElement;
    await waitFor(() => expect(briefing.value).toBe('standard'));
    fireEvent.change(briefing, { target: { value: 'full' } });
    const alert = await waitFor(() => within(root).getByRole('alert'));
    expect(alert.id).toBe('settings-briefing-message');
    expect(alert.textContent).toContain('save failed');
    expect(briefing.getAttribute('aria-invalid')).toBe('true');
    expect(autoUpdate.getAttribute('aria-invalid')).toBeNull();
  });

  it('disables both selects while a save is in flight and clears the previous outcome when a new save starts', async () => {
    const server = fakeServer({ briefing: 'standard' }, { failPost: true });
    const { container } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    const root = container as HTMLElement;
    const briefing = briefingSelect(root);
    const autoUpdate = within(root).getByLabelText('Auto-update policy') as HTMLSelectElement;
    await waitFor(() => expect(briefing.value).toBe('standard'));

    fireEvent.change(briefing, { target: { value: 'full' } });
    await waitFor(() => expect(within(root).getByRole('alert').textContent).toContain('save failed'));

    server.opts.failPost = false;
    server.opts.holdPost = true;
    fireEvent.change(briefing, { target: { value: 'full' } });
    await waitFor(() => expect(briefing.disabled).toBe(true));
    expect(autoUpdate.disabled).toBe(true);
    expect(within(root).queryByRole('alert')).toBeNull();
    expect(root.querySelector('#settings-briefing-message')).toBeNull();

    server.opts.holdPost = false;
    server.release();
    await waitFor(() => expect(root.querySelector('#settings-briefing-message')?.textContent).toBe('Saved.'));
    expect(briefing.disabled).toBe(false);
    expect(autoUpdate.disabled).toBe(false);
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
