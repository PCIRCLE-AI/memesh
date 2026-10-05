// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { FeedbackWidget } from '../../dashboard/src/components/FeedbackWidget';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function openAndFill(description: string) {
  const rendered = render(<FeedbackWidget health={null} />);
  fireEvent.click(rendered.container.querySelector('.fb-btn')!);
  const textarea = rendered.container.querySelector('.fb-desc') as HTMLTextAreaElement;
  fireEvent.input(textarea, { target: { value: description } });
  return { ...rendered, textarea };
}

describe('FeedbackWidget GitHub handoff', () => {
  it('preserves the dialog and draft and offers retry plus copy when the popup is blocked', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const draft = 'The full draft must survive a blocked popup.';
    const { container, getByRole, getByText, textarea } = openAndFill(draft);

    fireEvent.click(container.querySelector('.fb-submit')!);

    const alert = await waitFor(() => getByRole('alert'));
    expect(alert.textContent).toMatch(/GitHub/);
    expect(container.querySelector('.fb-panel')).not.toBeNull();
    expect(textarea.value).toBe(draft);
    expect(open).toHaveBeenCalledTimes(1);

    const preparedUrl = open.mock.calls[0]![0] as string;
    const retry = getByText(/再次嘗試開啟 GitHub|Try opening GitHub again/) as HTMLAnchorElement;
    expect(retry.href).toBe(preparedUrl);
    fireEvent.click(getByText(/複製 GitHub 連結|Copy GitHub link/));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(preparedUrl));
    getByText(/已複製連結|Link copied/);
  });

  it('closes and clears only after the browser returns a handoff handle', async () => {
    const opened = { opener: window } as unknown as Window;
    const open = vi.spyOn(window, 'open').mockReturnValue(opened);
    const { container, getByRole } = openAndFill('Open this prepared composer.');
    expect(getByRole('dialog').textContent).toMatch(/GitHub/);

    fireEvent.click(container.querySelector('.fb-submit')!);

    await waitFor(() => expect(container.querySelector('.fb-panel')).toBeNull());
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]![0]).toMatch(/^https:\/\/github\.com\/PCIRCLE-AI\/memesh\/issues\/new\?/);
    expect(opened.opener).toBeNull();

    fireEvent.click(container.querySelector('.fb-btn')!);
    expect((container.querySelector('.fb-desc') as HTMLTextAreaElement).value).toBe('');
    expect(container.textContent).not.toMatch(/issue (created|submitted)|已建立 issue|已送出 issue/i);
  });
});

describe('FeedbackWidget submit edge cases', () => {
  const bodyOf = (url: string) => new URL(url).searchParams.get('body') ?? '';

  it('keeps Open GitHub Issue disabled until there is a description (no silent no-op click)', () => {
    const { container } = openAndFill('');
    const submit = container.querySelector('.fb-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.input(container.querySelector('.fb-desc')!, { target: { value: '   ' } });
    expect(submit.disabled).toBe(true);
    fireEvent.input(container.querySelector('.fb-desc')!, { target: { value: 'something broke' } });
    expect(submit.disabled).toBe(false);
  });

  it('survives a lone surrogate in the description instead of dying on a URIError', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue({ opener: window } as unknown as Window);
    const { container } = openAndFill('before \uD800 after');
    fireEvent.click(container.querySelector('.fb-submit')!);

    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(bodyOf(open.mock.calls[0]![0] as string)).toContain('before � after');
  });

  it('says in the issue that system info was unavailable when the dashboard has no health reading', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue({ opener: window } as unknown as Window);
    const { container } = openAndFill('no health yet');
    fireEvent.click(container.querySelector('.fb-submit')!);

    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(bodyOf(open.mock.calls[0]![0] as string)).toMatch(/System Info[\s\S]*Unavailable/);
  });

  it('says in the issue that the doctor probe failed instead of silently omitting it', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    const open = vi.spyOn(window, 'open').mockReturnValue({ opener: window } as unknown as Window);
    const rendered = render(<FeedbackWidget health={{ status: 'ok', version: '4.10.11', entity_count: 3 }} />);
    fireEvent.click(rendered.container.querySelector('.fb-btn')!);
    fireEvent.input(rendered.container.querySelector('.fb-desc')!, { target: { value: 'doctor is down' } });
    fireEvent.click(rendered.container.querySelector('.fb-submit')!);

    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(bodyOf(open.mock.calls[0]![0] as string)).toContain('Diagnostics unavailable: doctor probe failed.');
  });
});
