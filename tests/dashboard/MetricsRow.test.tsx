// @vitest-environment happy-dom
//
// Home's metrics row, and the one rule it exists to keep: an instrument that
// has not run says so, in words. A tile that prints 0 from an absence claims
// a measurement nobody made — the same defect `retrieval.degraded` removed
// from recall, on the first screen a user reads.
//
// `buildTiles` is tested directly, not through the component, because the
// distinction under test is a VALUE distinction (null vs a number) and a
// component-level assertion cannot tell "rendered the not-measured tile"
// from "rendered a zero that happens to read the same".
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/preact';
import { MetricsRow, buildTiles, isMetricsRenderable } from '../../dashboard/src/components/MetricsRow';
import { HomeTab } from '../../dashboard/src/components/HomeTab';
import { t } from '../../dashboard/src/lib/i18n';
import type { AnalyticsData } from '../../dashboard/src/lib/api';

afterEach(() => { vi.restoreAllMocks(); });

const factor = { score: 1, weight: 30, detail: '' };

function analytics(over: Partial<AnalyticsData> = {}): AnalyticsData {
  return {
    healthScore: 72,
    healthFactors: { activity: factor, quality: factor, freshness: factor, lessons: factor },
    loopMetric: { reusedThisWeek: 3, trend: [], computedFrom: 'last_accessed_at_approximation' },
    criticalLessons: { critical: 5, severityTagged: 12, total: 29 },
    citationCompliance: null,
    timeline: [],
    ageMatrix: [],
    knowledgeRadar: [],
    ...over,
  };
}

function tile(data: AnalyticsData, key: string) {
  const found = buildTiles(data, 'en').find((x) => x.key === key);
  if (!found) throw new Error(`no ${key} tile`);
  return found;
}

describe('MetricsRow — not measured is never zero', () => {
  it('citation compliance with no counters has a null value, not 0%', () => {
    const t0 = tile(analytics({ citationCompliance: null }), 'citation');
    expect(t0.value, 'an instrument that never ran reported a measurement').toBeNull();
    expect(t0.note).toBe(t('metrics.citationNotMeasured'));
  });

  it('citation compliance measured at zero is a different answer from not measured', () => {
    const t0 = tile(analytics({ citationCompliance: { cited: 0, total: 7 } }), 'citation');
    expect(t0.value, 'a real 0% must render as a number, not as "not measured"').toBe('0%');
    expect(t0.note).toContain('7');
  });

  it('critical lessons carry the denominator that keeps the count honest', () => {
    // 5 of 12 classified, out of 29 lessons — printing "5" alone rounds the
    // 17 nobody has classified up into evidence that they are not critical.
    const t0 = tile(analytics(), 'critical');
    expect(t0.value).toBe('5');
    expect(t0.note).toContain('12');
    expect(t0.note).toContain('29');
  });

  it('lessons that exist but were never classified read as not measured', () => {
    const t0 = tile(analytics({ criticalLessons: { critical: 0, severityTagged: 0, total: 17 } }), 'critical');
    expect(t0.value, '"none classified" was reported as "zero critical"').toBeNull();
    expect(t0.note).toContain('17');
  });

  it('an empty library says there are no lessons, not that none are critical', () => {
    const t0 = tile(analytics({ criticalLessons: { critical: 0, severityTagged: 0, total: 0 } }), 'critical');
    expect(t0.value).toBeNull();
    expect(t0.note).toBe(t('metrics.criticalNoLessons'));
  });

  it('the reuse tile keeps its approximation caveat', () => {
    // The numbers come from last_accessed_at, and the note is the only thing
    // saying so on this screen.
    expect(tile(analytics(), 'loop').note).toBe(t('metrics.reusedNote'));
  });
});

describe('MetricsRow — a server without these groups is skew, not zeroes', () => {
  it('rejects a payload missing the groups it reads, rather than throwing mid-render', () => {
    // A server one release behind omits these entirely, and reading
    // `.severityTagged` off undefined throws during render — a white screen,
    // because this app ships no error boundary.
    expect(isMetricsRenderable(analytics())).toBe(true);
    const { criticalLessons, ...withoutLessons } = analytics();
    expect(criticalLessons).toBeDefined();
    expect(isMetricsRenderable(withoutLessons)).toBe(false);
    expect(isMetricsRenderable({})).toBe(false);
    expect(isMetricsRenderable(null)).toBe(false);
    // null citationCompliance is its NOT-MEASURED state, not a bad shape.
    expect(isMetricsRenderable(analytics({ citationCompliance: null }))).toBe(true);
  });
});

describe('MetricsRow — a failed fetch is not four zeroes', () => {
  it('renders four tiles when the payload is good', async () => {
    // The positive half of the test below. Without it, "zero tiles on
    // failure" is satisfied by a component that renders nothing ever.
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({ success: true, data: analytics() }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
    ) as ReturnType<typeof fetch>);

    const { container } = render(<MetricsRow />);
    await waitFor(() => {
      expect(container.querySelectorAll('.stat-val')).toHaveLength(4);
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('renders the classified failure instead of a row of measurements', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')));

    const { container } = render(<MetricsRow />);
    await waitFor(() => {
      expect(container.querySelector('[role="alert"]'), 'a dead analytics call rendered as data').not.toBeNull();
    });
    expect(container.querySelectorAll('.stat-val')).toHaveLength(0);
  });
});

describe('MetricsRow — two more places an absence must not print as a number', () => {
  it('an empty library is "not measured" for the health tile, not a health of 0', () => {
    const empty = buildTiles(analytics({ healthScore: 0 }), 'en', true).find((x) => x.key === 'health')!;
    expect(empty.value, 'a fresh install was told its memory scores 0').toBeNull();
    // With memories the number is real, zero included.
    expect(buildTiles(analytics({ healthScore: 0 }), 'en', false).find((x) => x.key === 'health')!.value).toBe('0');
  });

  it('a citation counter pair of 0 of 0 is not measured (it would print NaN%)', () => {
    const t0 = tile(analytics({ citationCompliance: { cited: 0, total: 0 } }), 'citation');
    expect(t0.value).toBeNull();
    expect(t0.note).toBe(t('metrics.citationNotMeasured'));
  });
});

// `buildTiles` above proves the rule; these prove it is wired — that the
// component hands the flag down and Home computes it from the entity count.
// Remove either and the row prints "health 0" on a fresh install.
describe('MetricsRow — an empty library reaches the health tile', () => {
  const stubAnalytics = (data: AnalyticsData) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const body = String(input).startsWith('/v1/analytics') ? data : {};
      return new Response(JSON.stringify({ success: true, data: body }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  };
  const healthTileValue = (container: Element) => {
    const tile = [...container.querySelectorAll('.stat')].find((x) => x.querySelector('.stat-lbl')?.textContent === t('metrics.health'));
    return tile?.querySelector('.stat-val')?.textContent;
  };

  it('<MetricsRow libraryEmpty> says "not measured" for health', async () => {
    stubAnalytics(analytics({ healthScore: 0 }));
    const { container } = render(<MetricsRow libraryEmpty />);
    await waitFor(() => expect(container.querySelectorAll('.stat-val')).toHaveLength(4));
    expect(healthTileValue(container)).toBe(t('metrics.notMeasured'));
  });

  it('Home passes the flag: entity_count 0 reads "not measured", a library with memories reads its 0', async () => {
    stubAnalytics(analytics({ healthScore: 0 }));
    const empty = render(<HomeTab health={{ status: 'ok', version: 't', entity_count: 0 }} />);
    await waitFor(() => expect(healthTileValue(empty.container)).toBe(t('metrics.notMeasured')));
    empty.unmount();

    const filled = render(<HomeTab health={{ status: 'ok', version: 't', entity_count: 4 }} />);
    await waitFor(() => expect(healthTileValue(filled.container)).toBe('0'));
  });
});
