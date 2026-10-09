import { useRef, useEffect } from 'preact/hooks';
import { t } from '../lib/i18n';
import { resolveTokens } from '../lib/tokens';

interface TimelineEntry {
  date: string;
  created: number;
  recalled: number;
}

interface MemoryTimelineProps {
  data: TimelineEntry[];
}

const PAD_TOP = 8;
const PAD_RIGHT = 24;
const PAD_BOTTOM = 28;
const PAD_LEFT = 24;
const CANVAS_HEIGHT = 120;
export const TIMELINE_AXIS_FONT_SIZE = 14;
const AXIS_LABEL_GAP = 8;

// The bars are the `--life` token at 30% opacity — applied as an alpha on the
// token, not as a hand-rolled rgba() fill (DESIGN.md: a fill uses a token, and
// a canvas draw call never carries a palette literal). Shared by the bars and
// the DOM legend swatch so they stay identical.
const BAR_ALPHA = 0.3;
const LINE_WIDTH = 1.5;
// The line, label colour and font are palette tokens; canvas cannot read
// var(), so they are resolved from the live stylesheet inside drawTimeline.

const DAY_MS = 24 * 60 * 60 * 1000;
/** A span longer than this is not a "last 30 days" series any more; it is
 *  drawn as received rather than expanded into hundreds of empty bars. */
const MAX_DENSE_DAYS = 120;

/**
 * The server sends only the days that HAD activity, so consecutive entries can
 * be weeks apart. Drawn by index, a gap vanished and the "every 7 bars" labels
 * stopped meaning 7 days. Fill the missing days with zeros so one bar is one
 * day. Data that cannot be read as consecutive dates is returned untouched.
 */
export function densifyByDay(data: TimelineEntry[]): TimelineEntry[] {
  if (data.length < 2) return data;
  const days = data.map((d) => Date.parse(`${d.date}T00:00:00Z`));
  if (days.some((ms) => !Number.isFinite(ms))) return data;
  const first = days[0];
  const last = days[days.length - 1];
  if (last <= first || (last - first) / DAY_MS > MAX_DENSE_DAYS) return data;
  if (days.some((ms, i) => i > 0 && ms <= days[i - 1])) return data;
  const byDay = new Map(days.map((ms, i) => [ms, data[i]]));
  const out: TimelineEntry[] = [];
  for (let ms = first; ms <= last; ms += DAY_MS) {
    out.push(byDay.get(ms) ?? { date: new Date(ms).toISOString().slice(0, 10), created: 0, recalled: 0 });
  }
  return out;
}

export function drawTimeline(
  canvas: HTMLCanvasElement,
  entries: TimelineEntry[],
): void {
  // Put the stylesheet-driven width back before measuring, so the canvas can
  // resolve 'width:100%' against its container. Without this, the px width
  // pinned by a previous draw (or a 0px write from when the panel was
  // display:none) would suppress the layout width even after the tab becomes
  // visible. It must be '100%', NOT '': the 100% is an inline style (there is
  // no canvas rule in the stylesheet), so clearing it left the canvas at its
  // intrinsic 2:1 ratio — 240px wide at any container width.
  canvas.style.width = '100%';
  const data = densifyByDay(entries);

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const cssW = rect.width;
  const cssH = CANVAS_HEIGHT;

  const chartW = cssW - PAD_LEFT - PAD_RIGHT;
  const chartH = cssH - PAD_TOP - PAD_BOTTOM;

  if (data.length === 0) {
    // The data went away (a demo reset, an emptied library): wipe the old
    // bars, or the legend says 0 above a chart still drawing the last data.
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  if (chartW <= 0 || chartH <= 0) return;

  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.scale(dpr, dpr);

  // Resolve the tokens this draw needs (empty when no stylesheet, e.g. a test —
  // a visible signal, never a literal fallback). See lib/tokens.ts.
  const tk = resolveTokens(canvas, ['--life', '--text-3', '--font-ui']);
  const lineStroke = tk['--life'];
  const labelColor = tk['--text-3'];
  const labelFont = `${TIMELINE_AXIS_FONT_SIZE}px ${tk['--font-ui']}`;

  const maxCreated = Math.max(1, ...data.map((d) => d.created));
  const maxRecalled = Math.max(1, ...data.map((d) => d.recalled));
  const maxVal = Math.max(maxCreated, maxRecalled);

  const barCount = data.length;
  const gap = 1;
  const barW = Math.max(1, (chartW - gap * (barCount - 1)) / barCount);

  // -- Draw bars (created) --
  ctx.fillStyle = lineStroke;
  ctx.globalAlpha = BAR_ALPHA;
  for (let i = 0; i < barCount; i++) {
    const entry = data[i];
    const barH = (entry.created / maxVal) * chartH;
    const x = PAD_LEFT + i * (barW + gap);
    const y = PAD_TOP + chartH - barH;
    ctx.fillRect(x, y, barW, barH);
  }
  ctx.globalAlpha = 1;

  // -- Draw line (recalled) --
  ctx.beginPath();
  ctx.strokeStyle = lineStroke;
  ctx.lineWidth = LINE_WIDTH;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  for (let i = 0; i < barCount; i++) {
    const entry = data[i];
    const x = PAD_LEFT + i * (barW + gap) + barW / 2;
    const y = PAD_TOP + chartH - (entry.recalled / maxVal) * chartH;
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();

  // -- X-axis labels: one bar per day (see densifyByDay), so every 7th bar is
  // a week apart --
  ctx.fillStyle = labelColor;
  ctx.font = labelFont;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  // Keep date labels legible at narrow responsive widths without losing any
  // data bars. Measuring after setting the real canvas font keeps each tick's
  // width inside the drawable bounds rather than relying on a magic cadence.
  const labelEvery = Math.max(
    7,
    Math.ceil((ctx.measureText('00-00').width + AXIS_LABEL_GAP) / (barW + gap)),
  );

  for (let i = 0; i < barCount; i += labelEvery) {
    const entry = data[i];
    // Format as MM-DD
    const parts = entry.date.split('-');
    const label = parts.length >= 3 ? `${parts[1]}-${parts[2]}` : entry.date;
    const x = PAD_LEFT + i * (barW + gap) + barW / 2;
    const y = PAD_TOP + chartH + 4;
    ctx.fillText(label, x, y);
  }
}

export function MemoryTimeline({ data }: MemoryTimelineProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    drawTimeline(canvas, data);

    // ResizeObserver fires on window resize AND on display:none→block (tab switch),
    // unlike window.resize which misses the tab reveal case.
    const observer = new ResizeObserver(() => drawTimeline(canvas, data));
    observer.observe(canvas);
    // A drawn canvas has a px width; its container can shrink without it resizing.
    if (canvas.parentElement) observer.observe(canvas.parentElement);
    return () => observer.disconnect();
  }, [data]);

  const totalCreated = data.reduce((sum, d) => sum + d.created, 0);
  const totalRecalled = data.reduce((sum, d) => sum + d.recalled, 0);

  return (
    <div class="card">
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 14,
      }}>
        <div class="card-title" style={{ marginBottom: 0 }}>
          {t('timeline.title')}
        </div>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          fontSize: 14,
          color: 'var(--text-2)',
        }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{
              display: 'inline-block',
              width: 10,
              height: 10,
              borderRadius: 'var(--radius-hairline)',
              background: 'var(--life)',
              opacity: BAR_ALPHA,
            }} />
            {t('timeline.created')}
            <span style={{
              fontFamily: 'var(--mono)',
              color: 'var(--text-3)',
              marginLeft: 2,
            }}>
              {totalCreated}
            </span>
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{
              display: 'inline-block',
              width: 10,
              height: 2,
              borderRadius: 'var(--radius-hairline)',
              background: 'var(--life)',
            }} />
            {t('timeline.recalled')}
            <span style={{
              fontFamily: 'var(--mono)',
              color: 'var(--text-3)',
              marginLeft: 2,
            }}>
              {totalRecalled}
            </span>
          </span>
        </div>
      </div>
      <canvas
        ref={canvasRef}
        style={{
          width: '100%',
          height: `${CANVAS_HEIGHT}px`,
          display: 'block',
        }}
      />
    </div>
  );
}
