// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/preact';
import { MemoryLoopCard } from '../../dashboard/src/components/MemoryLoopCard';

const baseTrend = [
  { date: '2026-04-15', count: 2 },
  { date: '2026-04-22', count: 5 },
  { date: '2026-04-29', count: 8 },
];

describe('MemoryLoopCard — SPEC-2 acceptance criteria', () => {
  it('renders the hero number when reusedThisWeek > 0', () => {
    const { container } = render(
      <MemoryLoopCard metric={{ reusedThisWeek: 12, trend: baseTrend, computedFrom: 'recall_hits' }} />
    );
    // JS \b is between \w / non-\w only, so 12 sandwiched against letters
    // has no word boundary. Just assert the substring is present.
    expect(container.textContent).toContain('12');
  });

  it('shows the em-dash placeholder for the zero-state (AC: zero state guides the user)', () => {
    const { container } = render(
      <MemoryLoopCard metric={{ reusedThisWeek: 0, trend: [], computedFrom: 'recall_hits' }} />
    );
    expect(container.textContent).toContain('—');
    expect(container.textContent).not.toMatch(/^0$/);
  });

  it('surfaces the approximation note when computedFrom is the fallback (AC2)', () => {
    const { container } = render(
      <MemoryLoopCard metric={{ reusedThisWeek: 5, trend: baseTrend, computedFrom: 'last_accessed_at_approximation' }} />
    );
    // Match either the en or zh-TW phrasing
    const approxRegex = /Approximation|近似值/;
    expect(container.textContent).toMatch(approxRegex);
  });

  it('omits the approx note when computedFrom is the precise mode', () => {
    const { container } = render(
      <MemoryLoopCard metric={{ reusedThisWeek: 5, trend: baseTrend, computedFrom: 'recall_hits' }} />
    );
    expect(container.textContent).not.toMatch(/Approximation|近似值/);
  });

  it('renders an SVG sparkline with one circle marker for the most-recent point', () => {
    const { container } = render(
      <MemoryLoopCard metric={{ reusedThisWeek: 5, trend: baseTrend, computedFrom: 'recall_hits' }} />
    );
    const svgs = container.querySelectorAll('svg');
    expect(svgs.length).toBeGreaterThan(0);
    const circles = container.querySelectorAll('circle');
    expect(circles.length).toBe(1);
  });

  it('handles empty trend without crashing', () => {
    const { container } = render(
      <MemoryLoopCard metric={{ reusedThisWeek: 0, trend: [], computedFrom: 'recall_hits' }} />
    );
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('renders a centred dot for a single-point trend (degenerate case)', () => {
    // A one-day-old install has trend.length === 1; the regular path
    // would draw a zero-width polygon and look broken. The single-point
    // branch should plot one dot at SPARK_W/2.
    const { container } = render(
      <MemoryLoopCard
        metric={{ reusedThisWeek: 4, trend: [{ date: '2026-05-08', count: 4 }], computedFrom: 'recall_hits' }}
      />
    );
    const circles = container.querySelectorAll('circle');
    expect(circles.length).toBe(1);
    // Centre of SPARK_W = 220 → cx ≈ 110
    const cx = Number(circles[0].getAttribute('cx'));
    expect(cx).toBeGreaterThan(80);
    expect(cx).toBeLessThan(140);
  });
});

describe('MemoryLoopCard reads a sparse trend by calendar, not by array position', () => {
  const now = new Date('2026-10-05T12:00:00Z');
  const day = (date: string, count: number) => ({ date, count });

  it('shows no percentage when the previous calendar week is empty', () => {
    // The server only sends days WITH activity. Six quiet weeks sit between
    // these two clusters; "the last 7 array entries" compared them anyway and
    // printed ↑140% while the calendar says last week had nothing.
    const trend = [
      ...['09-06', '09-07', '09-08', '09-09', '09-10', '09-11', '09-12'].map((d) => day(`2026-${d}`, 1)),
      ...['10-01', '10-02', '10-03', '10-04', '10-05'].map((d) => day(`2026-${d}`, 2)),
    ];
    const { container } = render(
      <MemoryLoopCard now={now} metric={{ reusedThisWeek: 10, trend, computedFrom: 'recall_hits' }} />,
    );
    expect(container.textContent).not.toMatch(/[↑↓]/);
  });

  it('compares the last 7 calendar days with the 7 before them', () => {
    const trend = [
      day('2026-09-23', 2), day('2026-09-25', 2), day('2026-09-27', 2), // prior week: 6
      day('2026-09-30', 4), day('2026-10-02', 4), day('2026-10-04', 4), // last week: 12
    ];
    const { container } = render(
      <MemoryLoopCard now={now} metric={{ reusedThisWeek: 12, trend, computedFrom: 'recall_hits' }} />,
    );
    expect(container.textContent).toContain('↑ 100%');
  });

  it('spaces sparkline points by date, so a three-week gap looks like one', () => {
    const trend = [day('2026-10-01', 1), day('2026-10-02', 1), day('2026-10-31', 1)];
    const { container } = render(
      <MemoryLoopCard now={now} metric={{ reusedThisWeek: 1, trend, computedFrom: 'recall_hits' }} />,
    );
    const line = container.querySelector('path[stroke-linecap]')!;
    const xs = [...line.getAttribute('d')!.matchAll(/[ML]([\d.]+),/g)].map((m) => Number(m[1]));
    expect(xs).toHaveLength(3);
    // 1 day of 30 across the 216px inner width ≈ 7px after the left pad of 2.
    expect(xs[1] - xs[0]).toBeLessThan(10);
    expect(xs[2] - xs[1]).toBeGreaterThan(200);
  });

  it('writes SVG attributes in their real (kebab-case) names', () => {
    // Preact's core copies a camelCase prop onto the element as-is, and the
    // browser ignores `strokeWidth`: the stroke silently fell back to 1px.
    const { container } = render(
      <MemoryLoopCard now={now} metric={{ reusedThisWeek: 1, trend: baseTrend, computedFrom: 'recall_hits' }} />,
    );
    const line = container.querySelector('path[stroke-linecap]')!;
    expect(line.getAttribute('stroke-width')).toBe('1.5');
    expect(line.getAttribute('strokeWidth')).toBeNull();
  });
});
