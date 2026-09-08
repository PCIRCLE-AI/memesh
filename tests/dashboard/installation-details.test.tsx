// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { InstallationDetails } from '../../dashboard/src/components/InstallationDetails';
import { DoctorBanner } from '../../dashboard/src/components/DoctorBanner';
import { getLocales, setLocale, t } from '../../dashboard/src/lib/i18n';

afterEach(() => { cleanup(); vi.restoreAllMocks(); setLocale('en'); localStorage.clear(); });
const versions = {
  id: 'shell-cli', status: 'pass', informational: true, code: 'shell-cli.versions',
  summary: 'Installed versions: this interface 4.9.0; terminal 4.8.5.',
  params: { current: '4.9.0', terminal: '4.8.5', shellPath: '/fixture/bin/memesh', packageRoot: '/fixture/candidate' },
};
function respond(data: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ success: true, data }), { headers: { 'content-type': 'application/json' } }));
}

describe('optional installation version details', () => {
  it('does not interrupt the homepage for version skew', async () => {
    const fetch = respond({ status: 'PASS', checks: [versions] });
    const { container } = render(<DoctorBanner />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it.each(getLocales())('shows localized information on demand in $code, with paths collapsed', async ({ code }) => {
    setLocale(code);
    const fetch = respond({ status: 'PASS', checks: [versions] });
    const { container, getByRole } = render(<InstallationDetails />);
    expect(fetch).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('4.9.0');
    fireEvent.click(getByRole('button', { name: t('settings.installationDetails') }));
    await waitFor(() => expect(container.textContent).toContain('4.9.0'));
    expect(container.textContent).toContain(t('doctor.msg.shell-cli.versions.summary', versions.params));
    if (code !== 'en') expect(container.textContent).not.toContain('Installed versions: this interface');
    const detail = container.querySelector('details');
    expect(detail?.open).toBe(false);
    expect(detail?.textContent).toContain('/fixture/candidate');
    expect(container.textContent).not.toContain('npm install');
    expect(container.textContent).not.toContain('share the same DB');
    expect(container.textContent).not.toContain('settings.installationDetails');
  });

  it.each([{}, { checks: [] }, { checks: [{}] }, { checks: [{ code: 'shell-cli.versions', params: {} }] }])('handles missing or incomplete version data honestly', async data => {
    respond(data);
    const { getByRole, container } = render(<InstallationDetails />);
    fireEvent.click(getByRole('button'));
    await waitFor(() => expect(container.textContent).toContain(t('settings.installationDetailsUnavailable')));
    expect(container.textContent).not.toContain('undefined');
    expect(container.querySelector('details')).toBeNull();
  });

  it('shows unavailable state on request failure and retries when reopened', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const { getByRole, container } = render(<InstallationDetails />);
    fireEvent.click(getByRole('button'));
    await waitFor(() => expect(container.textContent).toContain(t('settings.installationDetailsUnavailable')));
    fireEvent.click(getByRole('button'));
    fetch.mockResolvedValue(new Response(JSON.stringify({ success: true, data: { checks: [versions] } }), { headers: { 'content-type': 'application/json' } }));
    fireEvent.click(getByRole('button'));
    await waitFor(() => expect(container.textContent).toContain('4.9.0'));
  });
});
