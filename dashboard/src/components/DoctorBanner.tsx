import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../lib/api';
import { actionFailureMessage } from '../lib/failure';
import { t } from '../lib/i18n';
import { githubIssueUrl, openExternalWindow, terminalCommands } from '../lib/external-handoffs';
import { GitHubDestination, TerminalHandoff } from './ExternalHandoff';

const DISMISS_KEY = 'memesh.doctorBanner.dismissedSig';

/** The repair POST is answered only when the server is done: it runs doctor
 *  first (to re-check the row it was asked to repair), then the repair, whose
 *  slowest case (a plugin-cache refresh) has a 120 s budget in total — see
 *  doctor-fixes.ts — and then doctor again for the after-state. The page waits
 *  30 s more than that budget: the extra 30 s covers both doctor runs, before
 *  and after the repair. It is a margin, not a figure measured on a real install. */
const REPAIR_TIMEOUT_MS = 150_000;

interface DoctorCheck {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail';
  summary: string;
  fix?: string;
  code?: string;
  params?: Record<string, string | number>;
  fixId?: 'install-hooks' | 'fts-rebuild' | 'config-retired-settings' | 'plugin-cache-refresh';
}
interface DoctorResult { status: string; checks: DoctorCheck[] }

/**
 * Translate one doctor field by its stable message code, falling back to the
 * raw English the server sent. `t()` returns the key itself on a catalogue
 * miss — that equality IS the miss signal (this is the sanctioned pattern;
 * an or-fallback is not, because a returned key is truthy). The earlier
 * per-check-id localization was reverted for erasing state-specific detail;
 * codes are per-VARIANT and params carry the dynamic parts, so nothing is
 * erased — an untranslated variant simply shows the server's English.
 */
function trField(key: string, fallback: string, params?: Record<string, string | number>): string {
  const translated = t(key, params);
  return translated === key ? fallback : translated;
}
export function trSummary(c: DoctorCheck): string {
  return c.code ? trField(`doctor.msg.${c.code}.summary`, c.summary, c.params) : c.summary;
}
export function trFix(c: DoctorCheck): string | undefined {
  if (!c.fix) return undefined;
  return c.code ? trField(`doctor.msg.${c.code}.fix`, c.fix, c.params) : c.fix;
}
export function trLabel(c: DoctorCheck): string {
  const id = c.id.startsWith('plugin-cache-') ? 'plugin-cache' : c.id;
  return trField(`doctor.label.${id}`, c.label);
}

/**
 * WARN codes that report "nothing is wrong (yet)" rather than a problem —
 * they never earn a banner. The user's words, verbatim: 「既然沒更新就不要
 * 出聲，有更新才通知」— a fresh install nagged "no cached update check yet"
 * on every tab, which reads as *something is wrong* when nothing is.
 * `memesh doctor` (the CLI) still reports every one of these in full; the
 * banner interrupts, so it is reserved for broken things (FAIL) and
 * action-needed things (update available, version withdrawn, search
 * degraded). FAIL status always banners regardless of this list.
 */
const QUIET_WARN_CODES = new Set([
  'update-status.no-cache',        // has not checked yet — not a problem
  'update-status.stale',           // version is current, cache merely old
  'update-status.deprecation-unknown', // lookup failed; retried silently
  // `hook-activity.quiet` used to sit here, and it was the most expensive
  // entry in the list: the single signal that automatic capture might be dead
  // was the one the dashboard refused to show. It was suppressed for a good
  // reason — the old check could not distinguish "no session yet" from "hooks
  // are not running", so it fired on quiet days and reading it as a problem
  // would have been wrong most of the time. The check now measures hook RUNS
  // rather than captured rows, so the ambiguity is gone and the code with it:
  // a quiet day is a PASS, a >24h gap is a WARN that banners (a weekend, or
  // the first sign of a stopped loop), and >72h is a FAIL.
  'hook-activity.not-wired',       // the hook-wiring row already banners this
                                   // condition with its own fix; for MCP-only
                                   // installs (Codex / Gemini) it is not a
                                   // problem at all
  'shell-cli.not-on-path',         // plugin-only installs work fully
  'skills-manifest.missing-dev',   // normal for source checkouts
  'install-channel.unknown',       // nothing is broken
  'mcp-config.placeholder-unresolved', // not a failure of this install — npm
                                   // and source-checkout channels have no
                                   // plugin root to resolve `${CLAUDE_PLUGIN_ROOT}`
                                   // against, so there is nothing broken to act on
  'http-probe.no-server',          // you are LOOKING at the dashboard
  'readme-parity.unreadable',      // contributor-facing
  'readme-parity.drift',           // contributor-facing
]);

/**
 * Only surface concerns that are actually actionable to a user.
 * FAIL always counts (broken install — user has to act). WARN counts only
 * when it is NOT a quiet-by-design code (above) AND doctor attached a real
 * `fix` hint — without that filter, "PASS_WITH_CONCERNS" produced banners
 * like `Install method: … — No action needed`: alarmist title,
 * non-actionable body.
 */
export function isBannerWorthy(c: DoctorCheck): boolean {
  if (c.status === 'fail') return true;
  if (c.status !== 'warn') return false;
  if (c.code && QUIET_WARN_CODES.has(c.code)) return false;
  if (!c.fix) return false;
  const fix = c.fix.trim().toLowerCase();
  if (!fix) return false;
  if (fix === 'no action needed' || fix.startsWith('no action')) return false;
  return true;
}

/**
 * Surfaces doctor WARN/FAIL checks above the tab nav so users
 * who hit a real install/runtime problem (hooks unwired, MCP config
 * missing, database unreadable) actually see it instead of silently wondering
 * why memesh "doesn't work properly". This is the user-visible
 * tip of the "ship-前-verify" gate: doctor finds it → user sees it
 * → one-click "Get help" opens a GitHub issue pre-filled with those
 * diagnostics (it builds the link itself; it does not go through
 * FeedbackWidget).
 *
 * Dismiss semantics: remember the SIGNATURE of dismissed checks
 * (a join of their IDs, statuses and codes), not just "dismissed = true".
 * The banner stays dismissed only while the set of checks is EXACTLY the one
 * the user dismissed: a new check, or one of the dismissed ones clearing, makes
 * the signature differ and brings the banner back.
 */
export function DoctorBanner() {
  const [doctor, setDoctor] = useState<DoctorResult | null>(null);
  const [dismissedSig, setDismissedSig] = useState<string>(() => {
    try { return localStorage.getItem(DISMISS_KEY) ?? ''; } catch { return ''; }
  });
  const [helpUrl, setHelpUrl] = useState('');
  const [helpCopied, setHelpCopied] = useState(false);
  const [helpCopyFailed, setHelpCopyFailed] = useState(false);
  const [repairingId, setRepairingId] = useState<string | null>(null);
  const [repairedId, setRepairedId] = useState<string | null>(null);
  const [repairError, setRepairError] = useState<string | null>(null);
  const fetchGen = useRef(0);

  useEffect(() => {
    let mounted = true;
    const fetch = () => {
      const gen = ++fetchGen.current;
      api<DoctorResult>('GET', '/v1/doctor')
        .then((d) => {
          // A newer fetch was started meanwhile (a data-changed event fired
          // while this one was in flight): its answer wins, not whichever
          // lands last.
          if (!mounted || gen !== fetchGen.current) return;
          // A response without `checks` is not a doctor result. Storing it
          // anyway made `doctor.checks.filter(...)` throw on the next render.
          // It is treated exactly like a failed request: the result we
          // already hold stays, and the skip is logged.
          if (!Array.isArray(d?.checks)) {
            console.warn('[memesh dashboard] /v1/doctor answered, but with a shape this bundle cannot render — keeping the previous result:', d);
            return;
          }
          setDoctor(d);
          // A repair that reported "Fixed" while the next doctor run still lists
          // the same check did not fix it: the button must say so again.
          setRepairedId((cur) => (cur !== null && d.checks.some((c) => c.id === cur && isBannerWorthy(c)) ? null : cur));
        })
        .catch((e: unknown) => {
          // Doctor unavailable. The result we already hold (if any) stays —
          // a transient failure must not make a broken install look fixed —
          // and with none held the banner simply has nothing to show.
          if (mounted && gen === fetchGen.current) console.warn('[memesh dashboard] /v1/doctor failed to load:', e);
        });
    };
    fetch();
    const handler = () => fetch();
    window.addEventListener('memesh:data-changed', handler);
    return () => { mounted = false; window.removeEventListener('memesh:data-changed', handler); };
  }, []);

  if (!doctor) return null;
  if (doctor.status === 'PASS') return null;

  // Only surface concerns that are actually actionable to a user.
  // FAIL always counts (broken install — user has to act). WARN counts
  // ONLY when doctor attached a `fix` hint AND that hint isn't a
  // self-contradicting "no action needed" placeholder. Without this
  // filter, "PASS_WITH_CONCERNS" produced banners like
  // `Install method: Installation method detection — No action needed`
  // — alarmist title + non-actionable body. The CLI / `memesh doctor`
  // still reports every WARN; the dashboard just stops popping a
  // banner for ones the user can't (or shouldn't) act on.
  const concerns = doctor.checks.filter(isBannerWorthy);
  if (concerns.length === 0) return null;
  // The list shows the first three. Failures come first: the title says the
  // setup is incomplete, and the check that FAILED must not be the one folded
  // into "…and N more" behind three warnings (the sort is stable, so each tier
  // keeps doctor's own order).
  const listed = [...concerns].sort((a, b) => Number(b.status === 'fail') - Number(a.status === 'fail'));

  // Signature is stable for the same set of failing checks. Sort
  // before joining so check order doesn't change the signature. The code
  // and the hook param are part of the identity: hook-activity alone has
  // several warn-tier variants (stale, stop-silent, never-ran-legacy…), and
  // an id:status signature made dismissing one dismiss them ALL — a user
  // who waved off a stale post-commit warning then never saw "session
  // capture may be broken" when the condition changed underneath it.
  const currentSig = concerns
    .map(c => `${c.id}:${c.status}:${c.code ?? ''}:${c.params?.hook ?? ''}`)
    .sort()
    .join('|');
  if (currentSig === dismissedSig) return null;

  function dismiss() {
    setDismissedSig(currentSig);
    try { localStorage.setItem(DISMISS_KEY, currentSig); } catch { /* private mode */ }
  }

  function getHelp() {
    // Pre-fill the GitHub issue with the failing-check summaries.
    // The maintainer sees exactly what the user hit; the user sees
    // a one-click bridge from "something's wrong" to "I reported it".
    const lines = concerns.map(c => {
      const icon = c.status === 'fail' ? '❌' : '⚠️';
      const fix = c.fix ? ` _Fix: ${c.fix}_` : '';
      return `- ${icon} **${c.label}**: ${c.summary}${fix}`;
    });
    const body = `${t('doctorBanner.preambleForIssue')}\n\n${lines.join('\n')}`;
    const labels = 'feedback,from-dashboard,bug,doctor-warning';
    const url = githubIssueUrl({ title: '[Bug] memesh doctor reported issues', body, labels });
    if (!openExternalWindow(url)) {
      setHelpUrl(url);
      setHelpCopied(false);
      setHelpCopyFailed(false);
    } else {
      // GitHub opened this time: the blocked-popup block from an earlier
      // attempt no longer applies.
      setHelpUrl('');
    }
  }

  async function repair(c: DoctorCheck) {
    if (!c.fixId || repairingId) return;
    setRepairingId(c.id);
    setRepairedId(null);
    setRepairError(null);
    try {
      const result = await api<{ restartRequired?: boolean }>('POST', '/v1/doctor/fix', { id: c.id }, { timeoutMs: REPAIR_TIMEOUT_MS });
      setRepairedId(c.id);
      if (result?.restartRequired) {
        setRepairError(t('doctorBanner.restartRequired'));
      }
      window.dispatchEvent(new Event('memesh:data-changed'));
    } catch (err) {
      setRepairError(actionFailureMessage(err));
    } finally {
      setRepairingId(null);
    }
  }

  async function copyHelpLink() {
    if (!helpUrl) return;
    try { await navigator.clipboard.writeText(helpUrl); setHelpCopied(true); setHelpCopyFailed(false); }
    catch { setHelpCopied(false); setHelpCopyFailed(true); }
  }

  const isFail = doctor.status === 'FAIL';
  const tone = isFail ? 'var(--danger)' : 'var(--warning)';
  const toneBg = isFail ? 'var(--danger-soft)' : 'var(--warning-soft)';

  return (
    <div
      // `role="alert"` alone: it already implies an assertive live region,
      // and pairing it with `aria-live="polite"` told every screen reader two
      // contradictory urgencies for the same node. A failed doctor check is
      // the thing the user must hear about before interacting — assertive is
      // the right one of the two.
      role="alert"
      style={{
        position: 'relative',
        margin: '12px auto 0',
        maxWidth: 920,
        padding: '12px 16px',
        border: `1px solid ${tone}`,
        borderRadius: 'var(--radius)',
        background: toneBg,
        color: 'var(--text-1)',
      }}
    >
      <button
        type="button"
        onClick={dismiss}
        aria-label={t('doctorBanner.dismiss')}
        style={{
          position: 'absolute',
          top: 6,
          right: 8,
          background: 'transparent',
          border: 'none',
          color: 'var(--text-3)',
          fontSize: 18,
          lineHeight: 1,
          cursor: 'pointer',
          padding: 4,
          minWidth: 24,
          minHeight: 24,
        }}
      >
        ×
      </button>
      <div style={{ fontSize: 14, fontWeight: 600, color: tone, marginBottom: 6 }}>
        {isFail ? t('doctorBanner.failTitle') : t('doctorBanner.warnTitleSoft')}
      </div>
      <ul style={{ margin: '6px 0 10px', paddingLeft: 18, fontSize: 14, lineHeight: 1.5, color: 'var(--text-2)' }}>
        {listed.slice(0, 3).map(c => {
          const fix = trFix(c);
          const autoRepairable = c.fixId === 'config-retired-settings' || c.fixId === 'plugin-cache-refresh';
          return (
            <li key={c.id}>
              <strong>{trLabel(c)}:</strong> {trSummary(c)}
              {fix && <>
                {!autoRepairable && <>
                  {' — '}<em style={{ color: 'var(--text-3)' }}>{fix}</em>
                  {terminalCommands(fix).map(command => (
                    <TerminalHandoff key={command} id="doctor-fix-command" command={command} />
                  ))}
                </>}
                {autoRepairable && (
                  <div style={{ marginTop: 7 }}>
                    <button
                      type="button"
                      class="btn btn-sm"
                      disabled={repairingId !== null}
                      onClick={() => { void repair(c); }}
                    >
                      {repairingId === c.id
                        ? t('doctorBanner.fixInProgress')
                        : repairedId === c.id
                          ? t('doctorBanner.fixDone')
                          : t('doctorBanner.fix')}
                    </button>
                  </div>
                )}
              </>}
            </li>
          );
        })}
        {concerns.length > 3 && (
          <li style={{ color: 'var(--text-3)' }}>{t('doctorBanner.moreCount', { n: concerns.length - 3 })}</li>
        )}
      </ul>
      {repairError && (
        <div role="status" style={{ margin: '4px 0 8px', color: 'var(--text-2)', fontSize: 14 }}>
          {repairError}
        </div>
      )}
      {/* "Get help" pushes a GitHub issue. Only show for FAIL (broken
          install — the user can't fix it themselves). For WARN-only
          the fix command is already in the list above, so the GitHub
          escalation route would be premature and noisy. */}
      {isFail && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" class="btn" onClick={getHelp} style={{ fontSize: 14, padding: '4px 12px' }}>
            {t('doctorBanner.getHelp')}
          </button>
          <GitHubDestination id="doctor-help" />
          <span style={{ fontSize: 14, color: 'var(--text-3)' }}>
            {t('doctorBanner.helpHint')}
          </span>
        </div>
      )}
      {helpUrl && (
        <div role="alert" style={{ marginTop: 8, fontSize: 14 }}>
          <div>{t('feedback.popupBlocked')}</div>
          <a href={helpUrl} target="_blank" rel="noopener noreferrer">{t('feedback.retry')}</a>{' '}
          <button type="button" class="btn btn-sm" onClick={() => { void copyHelpLink(); }}>
            {helpCopied ? t('feedback.linkCopied') : t('feedback.copyLink')}
          </button>
          {helpCopyFailed && <div role="status" style={{ color: 'var(--danger)' }}>{t('feedback.copyFailed')}</div>}
        </div>
      )}
    </div>
  );
}
