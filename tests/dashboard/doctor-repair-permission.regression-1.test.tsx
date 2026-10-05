// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { DoctorBanner } from '../../dashboard/src/components/DoctorBanner';
import { getLocales, setLocale, t } from '../../dashboard/src/lib/i18n';

const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-TW');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setLocale('en');
});

describe('Dashboard doctor repair permission failure', () => {
  it('shows localized recovery guidance, hides raw paths, and re-enables retry', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).includes('/v1/doctor/fix')) {
        return response({
          success: false,
          errorCode: 'operation.permission-denied',
          error: 'EACCES: /Users/fixture/private/config.json',
        }, 500);
      }
      return response({
        success: true,
        data: {
          status: 'PASS_WITH_CONCERNS',
          checks: [{
            id: 'config', label: 'Config', status: 'warn', summary: 'legacy', fix: 'clean',
            fixId: 'config-retired-settings',
          }],
        },
      });
    });

    const view = render(<DoctorBanner />);
    const button = await view.findByRole('button', { name: t('doctorBanner.fix') });
    fireEvent.click(button);

    const expected = t('httpError.operation.permission-denied');
    await waitFor(() => expect(view.container.textContent).toContain(expected));
    expect(view.container.textContent).not.toContain('伺服器發生預期外的錯誤');
    expect(view.container.textContent).not.toContain('/Users/fixture');
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
});

// ── What the banner shows when a repair or a refetch does not go cleanly ─────

const ok = (data: unknown) => response({ success: true, data });
const warnConfig = {
  id: 'config', label: 'Config', status: 'warn', summary: 'legacy', fix: 'clean',
  fixId: 'config-retired-settings',
};

describe('DoctorBanner repair and refetch behaviour', () => {
  beforeEach(() => {
    setLocale('en');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('waits longer than the server\'s 120 s repair budget before giving up on the fix call', async () => {
    const timers = vi.spyOn(globalThis, 'setTimeout');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).includes('/v1/doctor/fix')) return new Promise<Response>(() => { /* still repairing */ });
      return ok({ status: 'PASS_WITH_CONCERNS', checks: [warnConfig] });
    });
    const view = render(<DoctorBanner />);
    fireEvent.click(await view.findByRole('button', { name: t('doctorBanner.fix') }));

    await waitFor(() => expect(timers.mock.calls.some(([, ms]) => typeof ms === 'number' && ms >= 120_000)).toBe(true));
  });

  // The server answers a repair that ran its first Codex command and could not
  // start the second with this code; the banner must hand the user the command
  // in their language, not the generic "unexpected error" it showed before.
  it.each(getLocales().map(({ code }) => code))('tells the user the command to finish an incomplete repair, in %s', async (locale) => {
    setLocale(locale);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).includes('/v1/doctor/fix')) {
        return response({
          success: false,
          errorCode: 'doctor.repair-incomplete',
          error: 'The Codex marketplace upgrade ran, but the budget ran out. Finish by hand: codex plugin add memesh@pcircle-memesh',
        }, 500);
      }
      return ok({ status: 'PASS_WITH_CONCERNS', checks: [{ ...warnConfig, fixId: 'plugin-cache-refresh' }] });
    });
    const view = render(<DoctorBanner />);
    fireEvent.click(await view.findByRole('button', { name: t('doctorBanner.fix') }));

    await waitFor(() => expect(view.container.textContent).toContain('codex plugin add memesh@pcircle-memesh'));
    // The primary action is a Terminal command, so the message carries the "Requires Terminal" label.
    expect(view.container.textContent).toContain(`${t('handoff.terminal')}: ${t('httpError.doctor.repair-incomplete')}`);
    expect(view.container.textContent).not.toContain(t('httpError.server.internal'));
  });

  it('turns a dead server during a repair into the classified sentence, not "Failed to fetch"', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).includes('/v1/doctor/fix')) throw new TypeError('Failed to fetch');
      return ok({ status: 'PASS_WITH_CONCERNS', checks: [warnConfig] });
    });
    const view = render(<DoctorBanner />);
    fireEvent.click(await view.findByRole('button', { name: t('doctorBanner.fix') }));

    await waitFor(() => expect(view.container.textContent).toContain('Could not reach the memesh server'));
    expect(view.container.textContent).not.toContain('Failed to fetch');
  });

  it('lists a failed check before the warnings, so it is not folded into "and N more"', async () => {
    const warn = (n: number) => ({ id: `w${n}`, label: `Warn${n}`, status: 'warn', summary: 's', fix: 'Run `memesh install-hooks`.' });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ok({
      status: 'FAIL',
      checks: [warn(1), warn(2), warn(3), warn(4), { id: 'f1', label: 'Failing', status: 'fail', summary: 's', fix: 'fix it' }],
    }));
    const view = render(<DoctorBanner />);
    await waitFor(() => expect(view.container.textContent).toContain('Failing'));
    expect(view.container.textContent).not.toContain('Warn3');
  });

  it('says so when the help link cannot be copied', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ok({
      status: 'FAIL', checks: [{ id: 'database', label: 'Database', status: 'fail', summary: 's', fix: 'fix it' }],
    }));
    const view = render(<DoctorBanner />);
    fireEvent.click(await view.findByRole('button', { name: t('doctorBanner.getHelp') }));
    fireEvent.click(await view.findByRole('button', { name: t('feedback.copyLink') }));

    await waitFor(() => expect(view.container.textContent).toContain(t('feedback.copyFailed')));
  });

  it('drops the "popup blocked" block once GitHub does open', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValueOnce(null).mockReturnValue({ opener: window } as unknown as Window);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ok({
      status: 'FAIL', checks: [{ id: 'database', label: 'Database', status: 'fail', summary: 's', fix: 'fix it' }],
    }));
    const view = render(<DoctorBanner />);
    const help = await view.findByRole('button', { name: t('doctorBanner.getHelp') });
    fireEvent.click(help);
    await view.findByText(t('feedback.popupBlocked'));

    fireEvent.click(help);
    await waitFor(() => expect(view.container.textContent).not.toContain(t('feedback.popupBlocked')));
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('does not keep saying "Fixed" when the next doctor run still reports the same problem', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).includes('/v1/doctor/fix')) return ok({});
      return ok({ status: 'PASS_WITH_CONCERNS', checks: [warnConfig] });
    });
    const view = render(<DoctorBanner />);
    fireEvent.click(await view.findByRole('button', { name: t('doctorBanner.fix') }));

    // The repair dispatches memesh:data-changed; the refetch still lists the check.
    await waitFor(() => expect(view.container.textContent).toContain(t('doctorBanner.fix')));
    expect(view.container.textContent).not.toContain(t('doctorBanner.fixDone'));
  });

  it('keeps the banner when a later refresh is unreadable or fails (no silent flip to "all clear")', async () => {
    let call = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      call++;
      if (call === 1) return ok({ status: 'FAIL', checks: [{ id: 'database', label: 'Database', status: 'fail', summary: 'DB broken', fix: 'fix it' }] });
      if (call === 2) return ok({ not: 'a doctor result' });
      throw new TypeError('Failed to fetch');
    });
    const view = render(<DoctorBanner />);
    await view.findByText(/DB broken/);

    window.dispatchEvent(new Event('memesh:data-changed'));
    await waitFor(() => expect(call).toBe(2));
    window.dispatchEvent(new Event('memesh:data-changed'));
    await waitFor(() => expect(call).toBe(3));
    await new Promise((r) => setTimeout(r, 0));
    expect(view.container.textContent).toContain('DB broken');
  });

  it('the newest doctor answer wins when an older request lands last', async () => {
    const resolvers: Array<(r: Response) => void> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((resolve) => { resolvers.push(resolve); }));
    const view = render(<DoctorBanner />);
    await waitFor(() => expect(resolvers).toHaveLength(1));
    window.dispatchEvent(new Event('memesh:data-changed'));
    await waitFor(() => expect(resolvers).toHaveLength(2));

    resolvers[1](ok({ status: 'FAIL', checks: [{ id: 'database', label: 'Database', status: 'fail', summary: 'newest answer', fix: 'fix it' }] }));
    await view.findByText(/newest answer/);
    resolvers[0](ok({ status: 'PASS', checks: [] }));
    await new Promise((r) => setTimeout(r, 0));
    expect(view.container.textContent).toContain('newest answer');
  });
});
