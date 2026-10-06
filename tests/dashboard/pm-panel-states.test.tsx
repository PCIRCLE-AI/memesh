// @vitest-environment happy-dom
//
// `PmAnalyticsPanel` rendered `null` for three different outcomes: a failed
// request, a request still in flight, and a reply this bundle cannot read.
// All three looked like an absence — the card simply was not there — so the
// user could not tell "still loading" from "the server is down" from "your
// dashboard is older than your server", and there was nothing to click,
// retry or report.
//
// The sibling on the same tab (`AnalyticsTab`) already renders a spinner and
// an `role="alert"` box for exactly these cases. This panel does now too.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/preact';
import { PmAnalyticsPanel } from '../../dashboard/src/components/PmAnalyticsPanel';
import { UserPatterns } from '../../dashboard/src/components/UserPatterns';

const GOOD = {
  velocity: { decisionsPerWeek: 1.5, releasesPerMonth: 2, windowDays: 30 },
  staleness: { stalePlanCount: 0, openDecisionCount: 3 },
  connectedness: { orphanRate: 0.2, totalRelations: 40, activeEntities: 100 },
};

function stubFetch(impl: () => Promise<Response>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(impl);
}

function jsonReply(data: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify({ success: true, data }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

describe('PmAnalyticsPanel tells its three states apart', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the numbers when the payload is good — the anti-vacuity half', async () => {
    // First, because everything below is about failure states and this is
    // the one that says the panel renders at all.
    stubFetch(() => jsonReply(GOOD));
    const { container } = render(<PmAnalyticsPanel />);

    await waitFor(() => {
      expect(container.textContent ?? '').toContain('1.5');
    });
    expect(container.querySelector('[role="alert"]'), 'a good payload showed an error').toBeNull();
  });

  it('shows a spinner while the request is in flight', () => {
    // Never resolves: the panel must show SOMETHING in the meantime.
    stubFetch(() => new Promise<Response>(() => { /* pending forever */ }));
    const { container } = render(<PmAnalyticsPanel />);

    expect(container.querySelector('.loading'), 'nothing rendered while loading').not.toBeNull();
  });

  it('announces a failed request instead of vanishing', async () => {
    stubFetch(() => Promise.reject(new Error('Failed to fetch')));
    const { container } = render(<PmAnalyticsPanel />);

    await waitFor(() => {
      const alert = container.querySelector('[role="alert"]');
      expect(alert, 'a failed request rendered nothing at all').not.toBeNull();
      expect(alert?.textContent ?? '').not.toBe('');
    });
  });

  it('announces a reply it cannot read, which is a different problem', async () => {
    // The request SUCCEEDED. Reporting this as an outage would send the user
    // to check a server that is working; the real cause is version skew
    // between the page and the server, and the remedy is a reload.
    stubFetch(() => jsonReply({ velocity: {}, staleness: {}, connectedness: {} }));
    const { container } = render(<PmAnalyticsPanel />);

    await waitFor(() => {
      const alert = container.querySelector('[role="alert"]');
      expect(alert, 'an unreadable payload rendered nothing at all').not.toBeNull();
      expect(alert?.textContent ?? '', 'the message does not mention reloading')
        .toMatch(/[Rr]eload|重新整理|刷新/);
    });
  });
});

describe('PmAnalyticsPanel layout and labels', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('lets its four figures wrap on a narrow screen instead of a fixed four-column grid', async () => {
    stubFetch(() => jsonReply(GOOD));
    const { container } = render(<PmAnalyticsPanel />);
    await waitFor(() => expect(container.textContent ?? '').toContain('1.5'));
    const grid = [...container.querySelectorAll<HTMLElement>('div')].find((d) => d.style.display === 'grid')!;
    expect(grid.style.gridTemplateColumns).toContain('auto-fit');
  });

  it('gives its refresh spinner an accessible name', async () => {
    let call = 0;
    stubFetch(() => (++call === 1 ? jsonReply(GOOD) : new Promise<Response>(() => { /* refetch pending */ })));
    const view = render(<PmAnalyticsPanel dataRevision={0} />);
    await waitFor(() => expect(view.container.textContent ?? '').toContain('1.5'));
    view.rerender(<PmAnalyticsPanel dataRevision={1} />);
    await waitFor(() => expect(view.container.querySelector('.loading[role="status"]')).not.toBeNull());
    expect(view.container.querySelector('.loading[role="status"]')!.getAttribute('aria-label')).toBeTruthy();
  });

  it('says "not accessed" for stale plans — the server counts last access, not review', async () => {
    stubFetch(() => jsonReply({ ...GOOD, staleness: { stalePlanCount: 2, openDecisionCount: 3 } }));
    const { container } = render(<PmAnalyticsPanel />);
    await waitFor(() => expect(container.textContent ?? '').toContain('2 plan(s) not accessed in 30+ days'));
  });
});

describe('UserPatterns hour heat-map', () => {
  it('gives each hour cell a name a screen reader can read, not only a hover title', () => {
    const { container } = render(<UserPatterns data={{
      workSchedule: { hourDistribution: [{ hour: 9, count: 5 }], dayDistribution: [] },
      focusAreas: [], workflow: { commitsPerSession: 1, totalSessions: 1, totalCommits: 1 },
      strengths: [], learningAreas: [],
    }} />);
    const cell = container.querySelector('[role="img"][aria-label="09:00 — 5"]');
    expect(cell).not.toBeNull();
  });
});
