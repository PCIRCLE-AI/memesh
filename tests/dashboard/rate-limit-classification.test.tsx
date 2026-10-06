// @vitest-environment happy-dom
//
// The regression PR #131 fixed: a 429 from the rate limiter was reaching the
// load paths as a generic error and being mislabelled "the dashboard and
// server are out of sync — run doctor". The fix is a dedicated RateLimitError
// (thrown by api() on any 429, envelope or bare string) that classifyLoadError
// maps to its own 'ratelimited' kind. These lock BOTH halves so the mislabel
// cannot silently come back.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/preact';
import { AnalyticsTab } from '../../dashboard/src/components/AnalyticsTab';
import { api, RateLimitError } from '../../dashboard/src/lib/api';
import { classifyLoadError, failureMessage } from '../../dashboard/src/lib/failure';
import { t } from '../../dashboard/src/lib/i18n';

afterEach(() => vi.restoreAllMocks());

function response(status: number, body: string, contentType?: string): Response {
  return new Response(body, {
    status,
    headers: contentType ? { 'content-type': contentType } : undefined,
  });
}

describe('429 rate-limit classification (dashboard)', () => {
  it('api() throws RateLimitError on a 429 carrying the JSON envelope', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      response(
        429,
        JSON.stringify({ success: false, errorCode: 'rate.limited', error: 'Too many requests' }),
        'application/json',
      ),
    );
    await expect(api('GET', '/v1/proposals')).rejects.toBeInstanceOf(RateLimitError);
  });

  it('api() throws RateLimitError on a 429 with a BARE string body (default limiter)', async () => {
    // express-rate-limit's default body is a bare string, not an envelope; the
    // 429 branch fires before any body parse, so this must still be a RateLimitError.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(429, 'Too many requests, please try again later.'));
    await expect(api('GET', '/v1/proposals')).rejects.toBeInstanceOf(RateLimitError);
  });

  it('classifyLoadError maps RateLimitError to "ratelimited", NOT "unreadable"', () => {
    // Break-test: delete the `if (err instanceof RateLimitError)` line in
    // failure.ts and this flips to 'unreadable' — the exact mislabel bug.
    expect(classifyLoadError(new RateLimitError(t('httpError.rate.limited')))).toBe('ratelimited');
    expect(classifyLoadError(new RateLimitError(t('httpError.rate.limited')))).not.toBe('unreadable');
  });

  it('the ratelimited message is the slow-down text, not the version-skew text', () => {
    const msg = failureMessage('ratelimited');
    expect(msg).toBe(t('httpError.rate.limited'));
    expect(msg).not.toBe(failureMessage('unreadable')); // must not read as "out of sync"
  });
});

// The consumer half: a 429 reaching AnalyticsTab used to be folded into
// "unreadable" by its own guard (it only asked "unreachable or not"), so the
// page told a user who was simply rate-limited to reload and run doctor.
describe('AnalyticsTab keeps the 429 diagnosis', () => {
  const okJson = (data: unknown) =>
    response(200, JSON.stringify({ success: true, data }), 'application/json');
  const PATTERNS = {
    workSchedule: { hourDistribution: [], dayDistribution: [] },
    focusAreas: [],
    workflow: { commitsPerSession: 1, totalSessions: 1, totalCommits: 1 },
    strengths: [],
    learningAreas: [],
  };

  it('says "too many requests" when the server rate-limits every endpoint', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response(429, 'Too many requests'));
    const { container } = render(<AnalyticsTab />);
    await waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    const text = container.querySelector('[role="alert"]')!.textContent ?? '';
    expect(text).toBe(t('httpError.rate.limited'));
    expect(text).not.toBe(failureMessage('unreadable'));
  });

  it('a rate limit on one endpoint beats an unreadable payload from another', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/stats')) return response(429, 'Too many requests');
      if (url.includes('/v1/patterns')) return okJson(PATTERNS);
      return okJson({}); // analytics: reachable but unreadable
    });
    const { container } = render(<AnalyticsTab />);
    await waitFor(() => expect(container.textContent).toContain(t('httpError.rate.limited')));
    expect(container.textContent).not.toContain(failureMessage('unreadable'));
  });

  it('still shows the patterns that did load when stats and analytics failed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/patterns')) return okJson(PATTERNS);
      return response(500, JSON.stringify({ success: false, errorCode: 'server.internal', error: 'x' }), 'application/json');
    });
    const { container } = render(<AnalyticsTab />);
    await waitFor(() => expect(container.textContent).toContain(t('patterns.workSchedule')));
  });
});

// A reload must not blank a page that has something on it, and a spinner that
// is all there is must have a name a screen reader can say.
describe('AnalyticsTab loading state', () => {
  const okJson = (data: unknown) =>
    response(200, JSON.stringify({ success: true, data }), 'application/json');
  const PATTERNS = {
    workSchedule: { hourDistribution: [], dayDistribution: [] },
    focusAreas: [],
    workflow: { commitsPerSession: 1, totalSessions: 1, totalCommits: 1 },
    strengths: [],
    learningAreas: [],
  };

  it('names the spinner it shows while nothing has loaded', () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => {}));
    const { container } = render(<AnalyticsTab />);
    const spinner = container.querySelector('.loading');
    expect(spinner?.getAttribute('role')).toBe('status');
    expect(spinner?.getAttribute('aria-label')).toBe(t('common.loading'));
  });

  it('keeps the patterns on screen while a reload runs and stats/analytics are still missing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let hold = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      if (hold) await gate;
      if (String(input).includes('/v1/patterns')) return okJson(PATTERNS);
      return response(500, JSON.stringify({ success: false, errorCode: 'server.internal', error: 'x' }), 'application/json');
    });
    const view = render(<AnalyticsTab dataRevision={0} />);
    await waitFor(() => expect(view.container.textContent).toContain(t('patterns.workSchedule')));

    hold = true;
    view.rerender(<AnalyticsTab dataRevision={1} />);
    await waitFor(() => expect(view.container.querySelector('.loading')).not.toBeNull());
    // Before: the whole page was replaced by the spinner until the reload settled.
    expect(view.container.textContent).toContain(t('patterns.workSchedule'));
    release();
  });
});
