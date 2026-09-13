// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { DoctorBanner } from '../../dashboard/src/components/DoctorBanner';
import { setLocale, t } from '../../dashboard/src/lib/i18n';

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
