import { type Entity } from '../lib/api';
import { t } from '../lib/i18n';
import { classifyLesson, displayTitle } from '../lib/entity-display';

/**
 * The structured renderers a lesson's content deserves, extracted from the
 * retired LessonsTab so the merged Memories surface keeps them. They render
 * the BODY of an expanded row only — the row itself (MemoryRow) already
 * carries title, type, project and access metadata, so none of that is
 * repeated here.
 */

/* ---------- structured-failure parser (Type A) ---------- */

interface StructuredBlock {
  error: string;
  rootCause: string;
  fix: string;
  prevention: string;
  /** Lines the parser does not recognise (a `Context:` line, say). Kept and
   *  shown as plain lines — dropping them would be a silent loss of content. */
  extra: string[];
}

/** Parse a failure-driven lesson into 1+ structured blocks. Each block has
 *  Error / Root cause / Fix / Prevention. Larger lessons often contain
 *  multiple blocks back-to-back; we split on the next "Error:" boundary. */
export function parseStructuredBlocks(observations: string[]): StructuredBlock[] {
  const blocks: StructuredBlock[] = [];
  let current: StructuredBlock | null = null;
  // Lines seen before the first recognised one; they join the first block.
  const leading: string[] = [];
  const fresh = (error = ''): StructuredBlock => ({ error, rootCause: '', fix: '', prevention: '', extra: [...leading.splice(0)] });
  // A field that appears twice keeps both: `Solution 1:` and `Solution 2:` are
  // two fixes, and the second used to overwrite the first.
  const append = (existing: string, value: string) => (existing ? `${existing}\n${value}` : value);

  for (const raw of observations) {
    const obs = raw.trim();
    if (obs.startsWith('Error:')) {
      if (current) blocks.push(current);
      current = fresh(obs.slice('Error:'.length).trim());
    } else if (obs.startsWith('Root cause:')) {
      current ??= fresh();
      current.rootCause = append(current.rootCause, obs.slice('Root cause:'.length).trim());
    } else if (obs.startsWith('Fix:') || obs.startsWith('Solution')) {
      current ??= fresh();
      current.fix = append(current.fix, obs.replace(/^(Fix|Solution\s*\d*):/i, '').trim());
    } else if (obs.startsWith('Prevention:')) {
      current ??= fresh();
      current.prevention = append(current.prevention, obs.slice('Prevention:'.length).trim());
    } else if (obs) {
      if (current) current.extra.push(obs);
      else leading.push(obs);
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

/* ---------- plan-completion parser (Type B) ---------- */

interface PlanRecord {
  planName: string;
  stepCount: number;
  steps: string;
  commits: string[];
}

function parsePlan(entity: Entity): PlanRecord {
  const obs = entity.observations ?? [];
  const planMatch = obs[0]?.match(/^Plan "(.+?)" completed \((\d+) steps?\)/);
  const stepsLine = obs.find((o) => o.startsWith('Steps:'))?.slice('Steps:'.length).trim() ?? '';
  const commitsLine = obs.find((o) => o.startsWith('Commits:'))?.slice('Commits:'.length).trim() ?? '';
  return {
    planName: planMatch?.[1] ?? displayTitle(entity),
    stepCount: planMatch ? parseInt(planMatch[2], 10) : 0,
    steps: stepsLine,
    commits: commitsLine ? commitsLine.split(',').map((c) => c.trim()).filter(Boolean) : [],
  };
}

/* ---------- severity ---------- */

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'var(--danger)',
  major: 'var(--warning)',
  minor: 'var(--info)',
};

// The -soft fill that pairs with each colour (DESIGN.md pair rule). A hex alpha
// suffix glued onto `var(--danger)` ("var(--danger)18") is not a colour, so the
// old badge background silently did not render.
const SEVERITY_SOFT: Record<string, string> = {
  critical: 'var(--danger-soft)',
  major: 'var(--warning-soft)',
  minor: 'var(--info-soft)',
};

function severityOf(entity: Entity): 'critical' | 'major' | 'minor' | null {
  const tags = entity.tags ?? [];
  if (tags.includes('severity:critical')) return 'critical';
  if (tags.includes('severity:major')) return 'major';
  if (tags.includes('severity:minor')) return 'minor';
  return null;
}

/** Row-level severity badge for lesson rows; renders nothing when the
 *  entity carries no severity tag. */
export function SeverityBadge({ entity }: { entity: Entity }) {
  const severity = severityOf(entity);
  if (!severity) return null;
  return (
    <span class="badge" style={{ background: SEVERITY_SOFT[severity], color: SEVERITY_COLORS[severity] }}>
      {t(`lessons.severity.${severity}`)}
    </span>
  );
}

/* ---------- expanded-row body ---------- */

function Field({ label, color, text }: { label: string; color: string; text: string }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 14, fontWeight: 600, color, marginBottom: 2, fontFamily: 'var(--font-ui)' }}>{label}</div>
      <div style={{ fontSize: 14, lineHeight: 1.55, whiteSpace: 'pre-line' }}>{text}</div>
    </div>
  );
}

function FailureBody({ entity }: { entity: Entity }) {
  const blocks = parseStructuredBlocks(entity.observations ?? []);
  if (blocks.length === 0) {
    return <div style={{ fontSize: 14, color: 'var(--text-3)', fontStyle: 'italic' }}>{t('lessons.unstructured')}</div>;
  }
  return (
    <>
      {blocks.map((b, i) => (
        <div key={i} style={{ marginTop: i > 0 ? 12 : 0, paddingTop: i > 0 ? 12 : 0, borderTop: i > 0 ? '1px dashed var(--border-subtle)' : 'none' }}>
          {b.error && <Field label={t('lessons.error')} color="var(--danger)" text={b.error} />}
          {b.rootCause && <Field label={t('lessons.rootCause')} color="var(--warning)" text={b.rootCause} />}
          {b.fix && <Field label={t('lessons.fix')} color="var(--success)" text={b.fix} />}
          {b.prevention && <Field label={t('lessons.prevention')} color="var(--info)" text={b.prevention} />}
          {b.extra.map((line, j) => <div key={j} style={{ fontSize: 14, lineHeight: 1.55, color: 'var(--text-2)', marginBottom: 4 }}>{line}</div>)}
        </div>
      ))}
    </>
  );
}

function PlanBody({ entity }: { entity: Entity }) {
  const plan = parsePlan(entity);
  return (
    <div>
      <div style={{ fontSize: 14, color: 'var(--text-3)', marginBottom: 6, fontFamily: 'var(--font-ui)' }}>
        <span style={{ fontFamily: 'var(--mono)' }}>{plan.stepCount}</span> {t('lessons.stepsLabel')} · {t('lessons.commitsCount', { count: plan.commits.length })}
      </div>
      {plan.steps && (
        <div style={{ fontSize: 14, color: 'var(--text-1)', lineHeight: 1.55 }}>{plan.steps}</div>
      )}
      {plan.commits.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 14, color: 'var(--text-3)', fontFamily: 'var(--mono)' }}>
          {plan.commits.slice(0, 6).join(' · ')}
          {plan.commits.length > 6 && <span> · +{plan.commits.length - 6}</span>}
        </div>
      )}
    </div>
  );
}

function ObservationsBody({ entity }: { entity: Entity }) {
  const obs = entity.observations ?? [];
  if (obs.length === 0) {
    return <div style={{ fontSize: 14, color: 'var(--text-3)', fontStyle: 'italic' }}>{t('lessons.unstructured')}</div>;
  }
  return (
    <ul style={{ fontSize: 14, lineHeight: 1.6, margin: 0, paddingLeft: 18, color: 'var(--text-1)' }}>
      {obs.slice(0, 8).map((o, i) => (
        <li key={i} style={{ marginBottom: 3 }}>{o}</li>
      ))}
      {obs.length > 8 && (
        <li style={{ color: 'var(--text-3)', listStyle: 'none' }}>{t('lessons.moreItems', { count: obs.length - 8 })}</li>
      )}
    </ul>
  );
}

/** Secondary, exact identity for export/debugging. The readable headline owns
 * the primary row; these storage values stay one deliberate expansion away. */
export function EntityTechnicalDetails({ entity }: { entity: Entity }) {
  return (
    <details style={{ marginTop: 10, fontSize: 14, color: 'var(--text-3)' }}>
      <summary style={{ cursor: 'pointer' }}>{t('memory.technicalDetails')}</summary>
      <dl style={{ display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', gap: '4px 10px', margin: '8px 0 0' }}>
        <dt>{t('memory.canonicalName')}</dt>
        <dd style={{ margin: 0, fontFamily: 'var(--mono)', overflowWrap: 'anywhere' }}>{entity.name}</dd>
        <dt>{t('memory.rawType')}</dt>
        <dd style={{ margin: 0, fontFamily: 'var(--mono)', overflowWrap: 'anywhere' }}>{entity.type}</dd>
      </dl>
    </details>
  );
}

/** The expanded body for ANY memory row. Lessons get their structured
 *  shapes (failure fields / plan record); everything else gets its
 *  observations — the universal detail view the dashboard never had.
 *  Memory content, so it speaks in the memory voice. */
export function ExpandedBody({ entity }: { entity: Entity }) {
  const kind = classifyLesson(entity);
  return (
    <div style={{ padding: '10px 0 4px 40px', fontFamily: 'var(--font-memory)' }}>
      {kind === 'failure' ? <FailureBody entity={entity} />
        : kind === 'plan-completion' ? <PlanBody entity={entity} />
        : <ObservationsBody entity={entity} />}
      <EntityTechnicalDetails entity={entity} />
    </div>
  );
}
