import { t, getLocale } from '../lib/i18n';

interface LoopMetric {
  reusedThisWeek: number;
  trend: Array<{ date: string; count: number }>;
  computedFrom: 'recall_hits' | 'last_accessed_at_approximation';
}

interface Props {
  metric: LoopMetric;
  /** The clock the "last 7 days" windows are read against; a prop so a test
   *  can pin it. */
  now?: Date;
}

const SPARK_W = 220;
const SPARK_H = 36;
const SPARK_PAD = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC midnight of a `YYYY-MM-DD` day, or null when the string is not one. */
function dayMs(date: string): number | null {
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The server's trend only holds the days that HAVE activity (`GROUP BY day`),
 * so the array is sparse. Position by the date, not by the index: a gap of
 * three weeks between two points has to look like three weeks, or the chart
 * labelled "last 30 days" draws a different shape from the days it shows.
 * Falls back to even spacing when a date cannot be read or there is no span.
 */
function xPositions(trend: LoopMetric['trend']): number[] {
  const days = trend.map((p) => dayMs(p.date));
  const first = days[0];
  const last = days[days.length - 1];
  const inner = SPARK_W - SPARK_PAD * 2;
  if (first === null || last === null || last <= first || days.some((d) => d === null)) {
    return trend.map((_, i) => SPARK_PAD + (i * inner) / (trend.length - 1));
  }
  return days.map((d) => SPARK_PAD + (((d as number) - first) / (last - first)) * inner);
}

/**
 * Render a 30-day-window sparkline. Falls back to a single horizontal
 * baseline when there is no data so the layout doesn't shift.
 */
function Sparkline({ trend }: { trend: LoopMetric['trend'] }) {
  if (!trend || trend.length === 0) {
    return (
      <svg width={SPARK_W} height={SPARK_H} style={{ display: 'block' }}>
        <line x1={0} y1={SPARK_H / 2} x2={SPARK_W} y2={SPARK_H / 2} stroke="rgba(255,255,255,0.06)" stroke-width={1} />
      </svg>
    );
  }
  // Single-point case: a one-day-old install has trend.length === 1, which
  // would degenerate into a zero-width path under the regular branch. Plot
  // the single point centred so it reads as "data exists, just not enough
  // for a curve yet" rather than an empty box.
  if (trend.length === 1) {
    const x = SPARK_W / 2;
    const y = SPARK_H / 2;
    return (
      <svg width={SPARK_W} height={SPARK_H} style={{ display: 'block' }}>
        <line x1={SPARK_PAD} y1={SPARK_H - SPARK_PAD} x2={SPARK_W - SPARK_PAD} y2={SPARK_H - SPARK_PAD} stroke="rgba(255,255,255,0.06)" stroke-width={1} />
        <circle cx={x} cy={y} r={3} fill="var(--life)" />
      </svg>
    );
  }
  const maxCount = Math.max(1, ...trend.map((p) => p.count));
  const xs = xPositions(trend);
  const ys = trend.map((p) => SPARK_H - SPARK_PAD - (p.count / maxCount) * (SPARK_H - SPARK_PAD * 2));
  const points = trend.map((_, i) => `${xs[i].toFixed(1)},${ys[i].toFixed(1)}`);

  // Area path: line down to baseline + back to start
  const linePath = `M${points[0]} L${points.slice(1).join(' L')}`;
  const areaPath = `${linePath} L${xs[xs.length - 1].toFixed(1)},${SPARK_H - SPARK_PAD} L${xs[0].toFixed(1)},${SPARK_H - SPARK_PAD} Z`;

  return (
    <svg width={SPARK_W} height={SPARK_H} style={{ display: 'block' }}>
      <path d={areaPath} fill="rgba(143, 242, 92, 0.12)" />
      <path d={linePath} fill="none" stroke="var(--life)" stroke-width={1.5} stroke-linejoin="round" stroke-linecap="round" />
      <circle cx={xs[xs.length - 1].toFixed(1)} cy={ys[ys.length - 1].toFixed(1)} r={2.5} fill="var(--life)" />
    </svg>
  );
}

export function MemoryLoopCard({ metric, now = new Date() }: Props) {
  const { reusedThisWeek, trend, computedFrom } = metric;
  const isApprox = computedFrom === 'last_accessed_at_approximation';

  // Change vs the prior 7 days for the small trend pill. The windows are
  // CALENDAR days counted back from today — `trend.slice(-7)` meant "the last
  // 7 days that had activity", which across a quiet fortnight compared the
  // wrong weeks and printed a percentage the main number contradicted.
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const sumDays = (fromAgo: number, toAgo: number) => trend.reduce((sum, p) => {
    const ms = dayMs(p.date);
    if (ms === null) return sum;
    const ago = (today - ms) / DAY_MS;
    return ago >= fromAgo && ago <= toAgo ? sum + p.count : sum;
  }, 0);
  const last7 = sumDays(0, 6);
  const prior7 = sumDays(7, 13);
  const delta = prior7 > 0 ? Math.round(((last7 - prior7) / prior7) * 100) : null;

  return (
    <div
      class="card"
      style={{
        display: 'flex',
        gap: 24,
        alignItems: 'center',
        flexWrap: 'wrap',
        padding: '20px 24px',
        background: 'var(--life-soft)', /* flattened: a decorative gradient is ornament (DESIGN.md) */
        border: '1px solid rgba(143, 242, 92, 0.18)',
      }}
    >
      <div style={{ flex: '1 1 200px', minWidth: 200 }}>
        <div
          style={{
            fontSize: 14,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: 'var(--text-2)',
            fontWeight: 600,
            marginBottom: 6,
          }}
        >
          {t('loop.label')}
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <div
            style={{
              fontSize: 84,
              fontWeight: 700,
              lineHeight: 1,
              color: reusedThisWeek > 0 ? 'var(--life)' : 'var(--text-2)',
              fontFamily: 'var(--font-ui)',
              letterSpacing: '-0.03em',
            }}
          >
            {reusedThisWeek > 0 ? reusedThisWeek.toLocaleString(getLocale()) : '—'}
          </div>
          {delta !== null && delta !== 0 && (
            <span
              style={{
                fontSize: 14,
                fontWeight: 600,
                fontFamily: 'var(--mono)',
                color: delta > 0 ? 'var(--success)' : 'var(--danger)',
              }}
            >
              {delta > 0 ? '↑' : '↓'} {Math.abs(delta)}%
            </span>
          )}
        </div>
        <div style={{ fontSize: 14, color: 'var(--text-1)', marginTop: 4 }}>
          {reusedThisWeek > 0 ? t('loop.subtitleHas') : t('loop.subtitleNone')}
        </div>
        {isApprox && (
          <div style={{ fontSize: 14, color: 'var(--text-3)', marginTop: 6, fontStyle: 'italic' }}>
            {t('loop.approxNote')}
          </div>
        )}
      </div>

      <div style={{ flex: '0 0 auto', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
        <Sparkline trend={trend} />
        <div style={{ fontSize: 14, color: 'var(--text-3)', fontFamily: 'var(--mono)' }}>
          {t('loop.sparkLabel')}
        </div>
      </div>
    </div>
  );
}
