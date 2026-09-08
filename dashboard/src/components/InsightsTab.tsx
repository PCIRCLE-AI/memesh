import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { api } from '../lib/api';
import { t } from '../lib/i18n';
import { actionFailureMessage, classifyLoadError, failureMessage } from '../lib/failure';
import { relativeDate } from '../lib/entity-display';
import { PatternCard } from './PatternCard';
import type { JSX } from 'preact';

// Review proposals that an agent or deterministic rule already staged.
// The Dashboard owns no generation path: it lists, expands, accepts, or
// rejects through the existing proposal endpoints.
//
// Two proposal kinds share the same lifecycle and table but render
// differently:
//   - 'digest'           — weekly compaction recap (success-green)
//   - 'pattern_emergent' — emerging concern (amber, see PatternCard)
// The kind is plumbed through from the server in `listProposals`
// (commit added `kind` to ProposalSummary).

type ProposalStatus = 'pending' | 'applied' | 'rejected';

interface ProposalSummary {
  id: number;
  project: string;
  cluster_key: string;
  source_count: number;
  digest_name: string;
  /** null when the proposal has no observations (was the '(empty)' sentinel). */
  digest_observations_preview: string | null;
  // Strict union is the truth for today; the badge renderer below
  // falls back to a neutral gray for any future status (e.g.
  // 'expired' / 'superseded') the server may add without coordinated
  // dashboard release. Kept narrow at the type so callers using this
  // model still get autocomplete for known values.
  status: ProposalStatus;
  created_at: string;
  kind?: string;
  source_kind?: string;
}

// Older persisted proposals may carry validation warnings in the digest
// blob. Keep rendering them without retaining the retired validator runtime.
interface ValidationWarning {
  claim: string;
  reason: string;
}

interface TranscriptSourceEvidence {
  sessionId: string;
  source: { host: 'claude-code'; scope: 'mcp-workspace-root' };
  workspaceHash: string;
  coverage: {
    truncated: boolean;
    total_turns: number;
    included_turns: number;
  };
  sources: Array<{ role: 'user' | 'assistant'; text: string }>;
  trust: 'untrusted';
}

function isTranscriptSourceEvidence(value: unknown): value is TranscriptSourceEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<TranscriptSourceEvidence>;
  return candidate.source?.host === 'claude-code'
    && candidate.source.scope === 'mcp-workspace-root'
    && typeof candidate.sessionId === 'string'
    && /^[a-f0-9]{64}$/.test(candidate.workspaceHash ?? '')
    && candidate.trust === 'untrusted'
    && typeof candidate.coverage?.truncated === 'boolean'
    && Number.isSafeInteger(candidate.coverage.total_turns)
    && candidate.coverage.total_turns >= 0
    && Number.isSafeInteger(candidate.coverage.included_turns)
    && candidate.coverage.included_turns >= 0
    && candidate.coverage.included_turns <= candidate.coverage.total_turns
    && Array.isArray(candidate.sources)
    && candidate.sources.length === candidate.coverage.included_turns
    && candidate.sources.every(source => source
      && (source.role === 'user' || source.role === 'assistant')
      && typeof source.text === 'string');
}

interface ProposalDetail {
  id: number;
  project: string;
  cluster_key: string;
  proposed_digest: {
    name: string;
    type: string;
    observations: string[];
    tags: string[];
    validation_warnings?: ValidationWarning[];
  } | null;
  source_ids: number[] | { sessionId: string } | TranscriptSourceEvidence;
  status: ProposalStatus;
  reason: string | null;
  created_at: string;
  reviewed_at: string | null;
  kind?: string;
  source_kind?: string;
}

// Proposal timestamps arrive in SQLite's 'YYYY-MM-DD HH:MM:SS' UTC form,
// which Date() refuses without the T/Z normalisation. The relative-time
// wording itself is entity-display's relativeDate — the shared, localised
// formatter — not a hand-rolled English 's/m/h/d ago' ladder.
// (src/core/doctor.ts's hoursSince() solves the same not-quite-ISO pitfall
// on the server side; they live in different bundles, so this stays a
// cross-reference rather than a shared helper until a third consumer
// appears.)
function formatRelative(iso: string): string {
  if (!iso) return '';
  return relativeDate(iso.includes(' ') ? iso.replace(' ', 'T') + 'Z' : iso);
}

// Defensive status -> badge color mapping. The server side
// (dreamer.ts:listProposals) declares `status: string`, so a future
// status value (e.g. 'expired', 'superseded') would silently
// mis-render with the previous strict-union switch. Unknown values
// fall back to a neutral var(--text-3) gray instead of inheriting an
// existing color.
function statusBadgeStyle(status: string): JSX.CSSProperties {
  switch (status) {
    case 'pending':
      return { background: 'var(--warning-soft)', color: 'var(--warning)' };
    case 'applied':
      return { background: 'rgba(143,242,92,0.12)', color: 'var(--life)' };
    case 'rejected':
      return { background: 'var(--danger-soft)', color: 'var(--danger)' };
    default:
      return { background: 'var(--neutral-soft)', color: 'var(--text-3)' };
  }
}

// Localised label with a graceful fallback to the raw status string
// when the i18n catalogue doesn't have a key for it (same future-
// status concern as the badge color).
function statusLabel(status: string): string {
  const key = `insights.status.${status}`;
  const label = t(key);
  // t() returns the raw key when no translation exists — surface the
  // server-provided status string in that case rather than the key
  // path itself.
  return label === key ? status : label;
}

export function InsightsTab({
  dataRevision = 0,
  onStateChange,
}: {
  dataRevision?: number;
  onStateChange?: (state: { pendingCount: number; loading: boolean; failed: boolean }) => void;
}) {
  // Fetch ALL proposals once and filter client-side. The hero stat
  // row needs cross-status counts, so a server-side filter would
  // require a second round-trip per render. The proposal list is
  // small (single-digit to low double-digit per project per week)
  // so client-side filtering is cheap.
  const [allProposals, setAllProposals] = useState<ProposalSummary[]>([]);
  const [filter, setFilter] = useState<'pending' | 'applied' | 'rejected' | 'all'>('pending');
  const [expanded, setExpanded] = useState<Map<number, ProposalDetail>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [proposalLoadFailed, setProposalLoadFailed] = useState(false);
  // Set-based in-flight tracking. The earlier scalar `busyId` had a
  // race: clicking accept on A then accept on B before A's
  // `await refresh()` resolved would let B's `setBusyId(B)` overwrite
  // A's busy state, then A's `finally { setBusyId(null) }` would
  // clear B's state mid-flight. With a Set we add on click and
  // remove in the matching finally, so two concurrent ops can each
  // own their own button-disabled state.
  const [inFlight, setInFlight] = useState<Set<number>>(new Set());
  const refreshGen = useRef(0);

  const refresh = useCallback(async () => {
    const gen = ++refreshGen.current;
    setLoading(true);
    setError('');
    setProposalLoadFailed(false);
    try {
      // api() already unwraps to json.data, so the response IS the
      // proposal array. The earlier `Array.isArray(data) ? data : ...`
      // unwrap was dead code (unreachable) and confused readers.
      const data = await api<ProposalSummary[]>('GET', `/v1/dream/proposals?status=all`);
      // `?? []` only replaces null/undefined; `{}` passed through and
      // `allProposals.filter` threw "filter is not a function". And a
      // payload that is not the array must not read as "no insights yet" —
      // that is a false empty from a response nobody could parse.
      if (gen !== refreshGen.current) return;
      if (!Array.isArray(data)) {
        console.warn('[memesh dashboard] /v1/dream/proposals answered, but with a shape this bundle cannot render — stale bundle or version skew, not an outage:', data);
        setProposalLoadFailed(true);
        setError(failureMessage('unreadable'));
      } else {
        setAllProposals(data);
      }
    } catch (e) {
      if (gen !== refreshGen.current) return;
      console.warn('[memesh dashboard] /v1/dream/proposals failed to load:', e);
      setProposalLoadFailed(true);
      setError(failureMessage(classifyLoadError(e)));
    } finally {
      if (gen === refreshGen.current) setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh, dataRevision]);

  const proposals = filter === 'all' ? allProposals : allProposals.filter(p => p.status === filter);

  const expand = useCallback(async (id: number) => {
    if (expanded.has(id)) {
      const next = new Map(expanded);
      next.delete(id);
      setExpanded(next);
      return;
    }
    try {
      const detail = await api<ProposalDetail>('GET', `/v1/dream/proposals/${id}`);
      const next = new Map(expanded);
      next.set(id, detail);
      setExpanded(next);
    } catch (e) {
      setError(actionFailureMessage(e));
    }
  }, [expanded]);

  const markBusy = (id: number) => {
    setInFlight(prev => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };
  const clearBusy = (id: number) => {
    setInFlight(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const accept = useCallback(async (id: number) => {
    markBusy(id);
    try {
      await api('POST', `/v1/dream/proposals/${id}/accept`);
      window.dispatchEvent(new Event('memesh:data-changed'));
    } catch (e) {
      setError(actionFailureMessage(e));
    } finally {
      clearBusy(id);
    }
  }, []);

  // Rejection is one click and permanent, so it remains confirmed. Acceptance
  // is exposed only after the complete proposal detail has loaded below: a
  // truncated card preview is not the human-review boundary.
  const reject = useCallback(async (id: number) => {
    if (!confirm(t('insights.rejectConfirm'))) return;
    markBusy(id);
    try {
      await api('POST', `/v1/dream/proposals/${id}/reject`, { reason: 'rejected via dashboard' });
      window.dispatchEvent(new Event('memesh:data-changed'));
    } catch (e) {
      setError(actionFailureMessage(e));
    } finally {
      clearBusy(id);
    }
  }, []);

  const pendingCount = allProposals.filter(p => p.status === 'pending').length;
  const appliedCount = allProposals.filter(p => p.status === 'applied').length;
  const rejectedCount = allProposals.filter(p => p.status === 'rejected').length;

  useEffect(() => {
    onStateChange?.({ pendingCount, loading, failed: proposalLoadFailed });
  }, [loading, onStateChange, pendingCount, proposalLoadFailed]);

  return (
    <div id="home-insights" tabIndex={-1} style={{ display: 'flex', flexDirection: 'column', gap: 16, scrollMarginTop: 12 }}>
      {/* Hero — what memesh did for you */}
      <div class="card" style={{ padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{t('insights.reviewTitle')}</h2>
          <span style={{ color: 'var(--text-2)', fontSize: 14 }}>{t('insights.reviewSubtitle')}</span>
        </div>
        <p style={{ margin: '8px 0 0', color: 'var(--text-2)', fontSize: 14, lineHeight: 1.5 }}>
          {t('insights.reviewBoundary')}
        </p>
        <div style={{ marginTop: 10, display: 'flex', gap: 16, flexWrap: 'wrap', color: 'var(--text-2)', fontSize: 14 }}>
          <span><strong style={{ color: 'var(--life)', fontFamily: 'var(--mono)' }}>{pendingCount}</strong> {t('insights.statPending')}</span>
          <span><strong style={{ fontFamily: 'var(--mono)' }}>{appliedCount}</strong> {t('insights.statApplied')}</span>
          <span><strong style={{ fontFamily: 'var(--mono)' }}>{rejectedCount}</strong> {t('insights.statRejected')}</span>
        </div>
      </div>

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} role="group" aria-label={t('insights.title')}>
        {(['pending', 'applied', 'rejected', 'all'] as const).map(f => {
          const active = filter === f;
          return (
            <button
              key={f}
              class={`tag`}
              aria-pressed={active}
              style={{
                padding: '4px 10px',
                borderRadius: 'var(--radius-xs)',
                cursor: 'pointer',
                border: '1px solid ' + (active ? 'var(--life)' : 'var(--border)'),
                background: active ? 'rgba(143,242,92,0.12)' : 'transparent',
                color: active ? 'var(--life)' : 'var(--text-2)',
              }}
              onClick={() => setFilter(f)}
            >
              {t(`insights.filter.${f}`)}
            </button>
          );
        })}
        <button class="btn btn-ghost" onClick={refresh} style={{ marginLeft: 'auto' }}>{t('insights.refresh')}</button>
      </div>

      {error && <div class="card" role="alert" style={{ padding: 12, color: 'var(--danger)' }}>{error}</div>}
      {loading && <div style={{ color: 'var(--text-3)', fontSize: 14 }}>{t('insights.loading')}</div>}
      {!loading && proposals.length === 0 && (
        <div class="card" style={{ padding: 16, textAlign: 'center', color: 'var(--text-2)' }}>
          {filter !== 'pending' ? t('insights.emptyOther') : t('insights.emptyPending')}
        </div>
      )}

      {proposals.map(p => {
        const detail = expanded.get(p.id);
        const isExpanded = expanded.has(p.id);
        const isPending = p.status === 'pending';
        const isBusy = inFlight.has(p.id);

        // Pattern proposals get a distinct visual surface — same
        // lifecycle, different signal class. Anything other than the
        // explicit pattern_emergent kind is rendered as a digest.
        if (p.kind === 'pattern_emergent') {
          return (
            <PatternCard
              key={p.id}
              proposal={p}
              detail={detail}
              expanded={isExpanded}
              inFlight={isBusy}
              onToggleExpand={expand}
              onAccept={accept}
              onReject={reject}
              formatRelative={formatRelative}
              statusBadgeStyle={statusBadgeStyle}
              statusLabel={statusLabel}
            />
          );
        }

        // digest_observations_preview is null when the digest has no
        // observations (the server used to send the literal '(empty)'
        // sentinel, which every consumer had to string-compare). Render a
        // localised empty state instead — never a dangling ellipsis.
        const preview = p.digest_observations_preview;

        return (
          <div key={p.id} class="card" style={{ padding: 14 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 60%', minWidth: 240 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span class="badge badge-type" style={{ textTransform: 'none', fontFamily: 'var(--mono)' }}>#{p.id}</span>
                  <span style={{ fontWeight: 600 }}>{p.digest_name}</span>
                  <span class="tag" style={{ fontSize: 14 }}>{p.project}</span>
                  <span class="tag" style={{ fontSize: 14 }}>{p.cluster_key}</span>
                  {p.kind === 'digest' && p.source_kind && (
                    <span class="tag" style={{ fontSize: 14 }}>
                      {p.source_kind === 'transcript' ? t('insights.source.transcript') : t('insights.source.calendar')}
                    </span>
                  )}
                  {p.kind === 'product_improvement' && (
                    <code class="tag" style={{ fontSize: 14 }}>product_improvement</code>
                  )}
                  <span class="tag" style={{ fontSize: 14, color: 'var(--text-2)' }}>{p.source_count} {t('insights.sources')}</span>
                  <span class="tag" style={{ fontSize: 14, ...statusBadgeStyle(p.status) }}>
                    {statusLabel(p.status)}
                  </span>
                </div>
                <div style={{ marginTop: 6, color: 'var(--text-2)', fontSize: 14, lineHeight: 1.5 }}>
                  {preview !== null
                    ? <>{preview}…</>
                    : <span style={{ fontStyle: 'italic', color: 'var(--text-3)' }}>{t('insights.noPreview')}</span>}
                </div>
                <div style={{ marginTop: 4, color: 'var(--text-3)', fontSize: 14 }}>
                  {formatRelative(p.created_at)}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap' }}>
                <button
                  class="btn btn-ghost"
                  onClick={() => expand(p.id)}
                  disabled={isBusy}
                  aria-expanded={isExpanded}
                >
                  {isExpanded ? t('insights.collapse') : t('insights.viewDetail')}
                </button>
                {isPending && isExpanded && detail && (
                  <>
                    <button class="btn btn-primary" onClick={() => accept(p.id)} disabled={isBusy}>
                      {isBusy ? t('insights.applying') : t('insights.accept')}
                    </button>
                    <button class="btn btn-ghost" onClick={() => reject(p.id)} disabled={isBusy} style={{ color: 'var(--danger)' }}>
                      {t('insights.reject')}
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Relation proposals (the conflict judge) carry a judge payload
                in proposed_digest, not a digest — routing them through the
                digest renderer below threw on .observations.map and left the
                one review surface unable to show WHY the judge flagged the
                pair. The reviewer needs the rationale, severity, excerpts,
                and (for supersedes) which side survives. */}
            {detail && detail.proposed_digest && p.kind === 'relation' && (() => {
              const rel = detail.proposed_digest as unknown as {
                verdict?: string; relation_type?: string; severity?: string;
                a?: { name?: string }; b?: { name?: string }; direction?: string;
                rationale?: string; recommended_action?: string;
                excerpts?: { a?: string; b?: string }; cosine_distance?: number;
              };
              const [fromN, toN] = rel.relation_type === 'supersedes' && rel.direction === 'b_supersedes_a'
                ? [rel.b?.name, rel.a?.name] : [rel.a?.name, rel.b?.name];
              return (
                <div style={{ marginTop: 12, padding: 12, background: 'var(--bg-1)', borderRadius: 'var(--radius-xs)', fontSize: 14 }}>
                  <div style={{ marginBottom: 8, color: 'var(--text-3)', fontSize: 14 }}>{t('insights.reviewSource')}</div>
                  <div style={{ marginBottom: 8 }}>
                    <strong>{rel.verdict}</strong>
                    {rel.severity && <span class="tag" style={{ marginLeft: 8, fontSize: 14 }}>{rel.severity}</span>}
                  </div>
                  <div style={{ marginBottom: 8, fontFamily: 'var(--mono)', fontSize: 14 }}>
                    {fromN} —{rel.relation_type}→ {toN}
                  </div>
                  {rel.rationale && (
                    <div style={{ marginBottom: 8, lineHeight: 1.5 }}>{rel.rationale}</div>
                  )}
                  {rel.recommended_action && (
                    <div style={{ marginBottom: 8, color: 'var(--text-2)', lineHeight: 1.5 }}>→ {rel.recommended_action}</div>
                  )}
                  {(rel.excerpts?.a || rel.excerpts?.b) && (
                    <div style={{ marginBottom: 4, color: 'var(--text-2)', fontSize: 14 }}>
                      <div><code>A</code> {rel.a?.name}: “{rel.excerpts?.a}”</div>
                      <div><code>B</code> {rel.b?.name}: “{rel.excerpts?.b}”</div>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Guard proposals (G1) carry a GuardSpec payload — the reviewer
                is approving a regex that will warn on future tool inputs, so
                the card shows the pattern, the message it will speak, and the
                evidence examples the validator executed. */}
            {detail && detail.proposed_digest && p.kind === 'guard' && (() => {
              const g = detail.proposed_digest as unknown as {
                guard?: { tool?: string; pattern?: string; message?: string; should_match?: string[]; should_not_match?: string[] };
                source_lesson?: { name?: string; title?: string | null };
              };
              return (
                <div style={{ marginTop: 12, padding: 12, background: 'var(--bg-1)', borderRadius: 'var(--radius-xs)', fontSize: 14 }}>
                  <div style={{ marginBottom: 8, color: 'var(--text-3)', fontSize: 14 }}>{t('insights.reviewSource')}</div>
                  <div style={{ marginBottom: 8 }}>
                    <span class="tag" style={{ fontSize: 14 }}>{g.guard?.tool}</span>
                    <span style={{ marginLeft: 8, color: 'var(--text-3)', fontSize: 14 }}>{t('guard.sourceLesson')}:</span>{' '}
                    <span style={{ fontSize: 14 }}>{g.source_lesson?.title || g.source_lesson?.name}</span>
                  </div>
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 14, color: 'var(--text-3)', marginBottom: 2 }}>{t('guard.pattern')}</div>
                    <code style={{ fontFamily: 'var(--mono)', fontSize: 14, wordBreak: 'break-all' }}>{g.guard?.pattern}</code>
                  </div>
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 14, color: 'var(--text-3)', marginBottom: 2 }}>{t('guard.message')}</div>
                    <div style={{ lineHeight: 1.5 }}>{g.guard?.message}</div>
                  </div>
                  {(g.guard?.should_match?.length || g.guard?.should_not_match?.length) ? (
                    <div style={{ fontSize: 14, color: 'var(--text-2)' }}>
                      {g.guard?.should_match?.length ? (
                        <div style={{ marginBottom: 4 }}>
                          <span style={{ color: 'var(--text-3)', fontSize: 14 }}>{t('guard.shouldMatch')}:</span>{' '}
                          {g.guard.should_match.map((ex, i) => <code key={i} style={{ fontFamily: 'var(--mono)', fontSize: 14, marginRight: 8 }}>{ex}</code>)}
                        </div>
                      ) : null}
                      {g.guard?.should_not_match?.length ? (
                        <div>
                          <span style={{ color: 'var(--text-3)', fontSize: 14 }}>{t('guard.shouldNotMatch')}:</span>{' '}
                          {g.guard.should_not_match.map((ex, i) => <code key={i} style={{ fontFamily: 'var(--mono)', fontSize: 14, marginRight: 8 }}>{ex}</code>)}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })()}

            {detail && detail.proposed_digest && p.kind !== 'relation' && p.kind !== 'guard' && (
              <div style={{ marginTop: 12, padding: 12, background: 'var(--bg-1)', borderRadius: 'var(--radius-xs)', fontSize: 14 }}>
                {p.kind === 'product_improvement'
                  ? <div style={{ marginBottom: 8, color: 'var(--text-3)', fontSize: 14 }}><code>product_improvement</code></div>
                  : (
                    <div style={{ marginBottom: 8, color: 'var(--text-3)', fontSize: 14 }}>
                      {detail.source_kind === 'transcript' ? t('insights.source.transcript') : t('insights.source.calendar')}
                    </div>
                  )}
                {/* Legacy flagged claims render above observations so the
                    reviewer sees their caveats before the digest text. */}
                {Array.isArray(detail.proposed_digest.validation_warnings)
                  && detail.proposed_digest.validation_warnings.length > 0 && (
                  <div
                    style={{
                      marginBottom: 10,
                      padding: 10,
                      borderRadius: 'var(--radius-xs)',
                      borderLeft: '3px solid var(--warning)',
                      background: 'var(--warning-soft)',
                    }}
                  >
                    <div style={{ fontWeight: 600, color: 'var(--warning)', marginBottom: 6 }}>
                      ⚠ {t('insights.validationWarnings')}
                    </div>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {detail.proposed_digest.validation_warnings.map((w, i) => (
                        <li key={i} style={{ marginBottom: 6, lineHeight: 1.5 }}>
                          <div>
                            <span style={{ color: 'var(--text-3)' }}>{t('insights.validationClaim')}: </span>
                            <code style={{ fontSize: 14 }}>{w.claim}</code>
                          </div>
                          <div>
                            <span style={{ color: 'var(--text-3)' }}>{t('insights.validationReason')}: </span>
                            <span>{w.reason}</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div style={{ marginBottom: 8 }}>
                  <strong>{t('insights.observations')}:</strong>
                  <ol style={{ margin: '4px 0 0 18px', padding: 0 }}>
                    {detail.proposed_digest.observations.map((obs, i) => (
                      <li key={i} style={{ marginBottom: 6, lineHeight: 1.5 }}>{obs}</li>
                    ))}
                  </ol>
                </div>
                <div style={{ marginBottom: 4 }}>
                  <strong>{t('insights.tags')}:</strong>{' '}
                  {detail.proposed_digest.tags.map(tag => (
                    <span key={tag} class="tag" style={{ marginLeft: 4, fontSize: 14 }}>{tag}</span>
                  ))}
                </div>
                {Array.isArray(detail.source_ids) && (
                  <div style={{ color: 'var(--text-3)', fontSize: 14, marginTop: 6 }}>
                    {t('insights.sourceIds')}: {t('insights.entitiesCount', { n: detail.source_ids.length })} ({detail.source_ids.slice(0, 8).join(', ')}{detail.source_ids.length > 8 ? '…' : ''})
                  </div>
                )}
                {isTranscriptSourceEvidence(detail.source_ids) && (
                  <div data-testid="transcript-source-evidence" style={{ marginTop: 12, padding: 10, background: 'var(--bg-2)', borderRadius: 'var(--radius)' }}>
                    <div style={{ color: 'var(--text-2)', fontSize: 14, marginBottom: 6 }}>
                      <strong>{t('insights.source.transcript')}</strong>{' '}
                      <code>{detail.source_ids.source.host}</code> · <code>{detail.source_ids.sessionId}</code> ·{' '}
                      {detail.source_ids.coverage.included_turns}/{detail.source_ids.coverage.total_turns} {t('insights.sources')}
                      {detail.source_ids.coverage.truncated ? '…' : ''}
                    </div>
                    <ol style={{ margin: '0 0 0 18px', padding: 0 }}>
                      {detail.source_ids.sources.map((source, index) => (
                        <li key={index} style={{ marginBottom: 6, lineHeight: 1.5 }}>
                          <code style={{ fontSize: 14 }}>{source.role}</code>{' '}{source.text}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
