// @vitest-environment happy-dom
//
// What the dashboard does with what the server sends back:
//
// 1. Error envelopes carry a stable machine `errorCode` next to the English
//    `error` prose. api() translates KNOWN codes (httpError.*) and falls
//    back to the raw prose for unknown ones; only codes in its terminal set
//    get the "Requires Terminal" label. Miss-detection is the sanctioned
//    `translated === key` check.
// 2. api() tells replies apart by what they are: a cross-origin refusal vs a
//    terminal task, an unreadable 2xx body vs an outage, a timeout (also one
//    that fires while a body is read) vs a server error, fetch's own
//    TypeError vs a bug in the caller, and `timeoutMs` for the one slow call.
//    fetchTaskState rejects a payload it cannot render.
// 3. `digest_observations_preview` is `null` (not the '(empty)' sentinel) when
//    a proposal has no observations, and a stored proposal the server could
//    not parse arrives with no content: the cards say so in a localised
//    sentence — never the sentinel, never a dangling '…', and no Accept.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/preact';
import { api, fetchTaskState, NetworkError, UnreadableResponseError } from '../../dashboard/src/lib/api';
import { actionFailureMessage, classifyLoadError, failureMessage } from '../../dashboard/src/lib/failure';
import { t } from '../../dashboard/src/lib/i18n';
import { PatternCard } from '../../dashboard/src/components/PatternCard';
import { InsightsTab } from '../../dashboard/src/components/InsightsTab';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => vi.restoreAllMocks());

// ── api(): stable errorCode → translated message ────────────────────────────

describe('api() translates known errorCodes', () => {
  it('throws the httpError.<code> translation for a known code, not the raw prose', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ success: false, errorCode: 'route.retired', error: 'raw server English about /v1/dream/run' }),
    );
    const expected = t('httpError.route.retired');
    expect(expected, 'the catalogue must actually contain the key this test relies on').not.toBe('httpError.route.retired');
    await expect(api('POST', '/v1/consolidate', {})).rejects.toThrow(expected);
  });

  it('falls back to the raw error prose for an UNKNOWN code (absence stays visible)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ success: false, errorCode: 'future.not-in-this-bundle', error: 'raw prose survives' }),
    );
    await expect(api('POST', '/v1/whatever', {})).rejects.toThrow('raw prose survives');
  });

  it('still uses the raw error when no errorCode is present (pre-upgrade servers)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ success: false, error: 'plain old message' }),
    );
    await expect(api('POST', '/v1/whatever', {})).rejects.toThrow('plain old message');
  });
});

// ── null preview: PatternCard ────────────────────────────────────────────────

const noop = () => {};
const cardProps = {
  detail: undefined,
  expanded: false,
  inFlight: false,
  onToggleExpand: noop,
  onAccept: noop,
  onReject: noop,
  formatRelative: () => 'now',
  statusBadgeStyle: () => ({}),
  statusLabel: (s: string) => s,
};

function patternProposal(preview: string | null) {
  return {
    id: 7,
    project: 'memesh',
    cluster_key: 'pattern:2026-08-05',
    source_count: 3,
    digest_name: 'a-pattern',
    digest_observations_preview: preview,
    status: 'pending',
    created_at: '2026-08-05 00:00:00',
  };
}

describe('PatternCard renders null preview as a localised empty state', () => {
  it('shows insights.noPreview and no dangling ellipsis when preview is null', () => {
    const { container } = render(<PatternCard proposal={patternProposal(null)} {...cardProps} />);
    expect(container.textContent).toContain(t('insights.noPreview'));
    expect(container.textContent).not.toContain('…');
    expect(container.textContent).not.toContain('(empty)');
  });

  it('shows the preview text with an ellipsis when one exists', () => {
    const { container } = render(<PatternCard proposal={patternProposal('real preview text')} {...cardProps} />);
    expect(container.textContent).toContain('real preview text…');
  });
});

// ── null preview: InsightsTab digest card ────────────────────────────────────

describe('InsightsTab renders a null digest preview as a localised empty state', () => {
  it('shows insights.noPreview for a digest proposal without observations', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/dream/proposals')) {
        return jsonResponse({
          success: true,
          data: [{
            id: 1,
            project: 'memesh',
            cluster_key: '2026-W32',
            source_count: 5,
            digest_name: 'empty-digest',
            digest_observations_preview: null,
            status: 'pending',
            created_at: '2026-08-05 00:00:00',
            kind: 'digest',
          }],
        });
      }
      // /v1/config and anything else the tab loads.
      return jsonResponse({ success: true, data: { config: {} } });
    });

    const { container } = render(<InsightsTab />);
    await waitFor(() => {
      expect(container.textContent).toContain('empty-digest');
    });
    expect(container.textContent).toContain(t('insights.noPreview'));
    expect(container.textContent).not.toContain('(empty)');
  });
});

// ── api(): which errors are which ───────────────────────────────────────────

describe('api() labels and classifies replies by what they actually are', () => {
  it('does not call a cross-origin refusal "Requires Terminal" — its action is in the browser', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: false, errorCode: 'auth.cross-origin', error: 'x' }), { status: 403, headers: { 'content-type': 'application/json' } }),
    );
    const err = await api('GET', '/v1/health').catch((e: Error) => e);
    expect((err as Error).message).toBe(t('httpError.auth.cross-origin'));
    expect((err as Error).message).not.toContain(t('handoff.terminal'));
  });

  it('keeps the Terminal label where the primary action IS a command', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: false, errorCode: 'auth.not-configured', error: 'x' }), { status: 500, headers: { 'content-type': 'application/json' } }),
    );
    const err = await api('GET', '/v1/health').catch((e: Error) => e);
    expect((err as Error).message.startsWith(`${t('handoff.terminal')}: `)).toBe(true);
  });

  it('does not call an UNKNOWN code a Terminal task just because its prose quotes a `memesh` command', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: false, errorCode: 'future.not-in-this-bundle', error: 'Reload, and if it stays, run `memesh doctor`.' }), { status: 500, headers: { 'content-type': 'application/json' } }),
    );
    const err = await api('GET', '/v1/health').catch((e: Error) => e);
    expect((err as Error).message).toBe('Reload, and if it stays, run `memesh doctor`.');
  });

  it('a timeout that fires while the body of a 5xx reply is read stays a timeout, not "server error 500"', async () => {
    const aborted = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false, status: 500, json: () => Promise.reject(aborted),
    } as unknown as Response);
    const err = await api('GET', '/v1/health').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as Error).message).toBe(t('errors.timeout'));
  });

  it('only fetch\'s own TypeError is a NetworkError: a body that cannot be serialised is a bug, not "unreachable"', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const err = await api('POST', '/v1/remember', circular).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(err).not.toBeInstanceOf(NetworkError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a TypeError thrown by fetch itself is a NetworkError', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    const err = await api('GET', '/v1/health').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
  });

  it('a 200 whose body is JSON null is an unreadable reply — the server answered, so not "unreachable"', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(null));
    const err = await api('GET', '/v1/health').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnreadableResponseError);
    expect(err).not.toBeInstanceOf(NetworkError);
    expect(classifyLoadError(err)).toBe('unreadable');
  });

  it('a 200 with an HTML body reads as the unreadable sentence, not the JSON parser\'s prose', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<!doctype html><title>proxy</title>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    const err = await api('POST', '/v1/demo/seed').catch((e: unknown) => e);
    expect(actionFailureMessage(err)).toBe(failureMessage('unreadable'));
    expect(actionFailureMessage(err)).not.toMatch(/Unexpected token|JSON/);
  });

  it('timeoutMs lets one slow call outlive the default 10 s abort', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise<Response>((resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        setTimeout(() => resolve(jsonResponse({ success: true, data: { done: true } })), 15_000);
      }));
      const slow = api('POST', '/v1/doctor/fix', { id: 'x' }, { timeoutMs: 130_000 });
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(slow).resolves.toEqual({ done: true });

      // The default is unchanged: the same 15 s reply is cut off at 10 s.
      const normal = api('GET', '/v1/health');
      const assertion = expect(normal).rejects.toBeInstanceOf(NetworkError);
      await vi.advanceTimersByTimeAsync(10_001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('fetchTaskState rejects a payload whose state is null (typeof null is "object")', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ success: true, data: { project: 'p', state: null } }));
    await expect(fetchTaskState('p')).rejects.toThrow('unreadable task-state payload');
  });
});

describe('proposal previews: a blank first observation is "no summary", not a lone ellipsis', () => {
  it('PatternCard shows insights.noPreview for an empty-string preview', () => {
    const { container } = render(<PatternCard proposal={patternProposal('')} {...cardProps} />);
    expect(container.textContent).toContain(t('insights.noPreview'));
    expect(container.textContent).not.toContain('…');
  });
});

describe('PatternCard with stored content the server could not parse', () => {
  it('explains the empty detail and offers Reject but no Accept', () => {
    const { container, getByRole, queryByRole } = render(
      <PatternCard
        proposal={patternProposal('real preview text')}
        {...cardProps}
        expanded
        detail={{ proposed_digest: null, source_ids: [1] }}
      />,
    );
    expect(container.textContent).toContain(t('insights.contentUnreadable'));
    expect(queryByRole('button', { name: t('insights.accept') })).toBeNull();
    expect(getByRole('button', { name: t('insights.reject') })).toBeTruthy();
  });
});
