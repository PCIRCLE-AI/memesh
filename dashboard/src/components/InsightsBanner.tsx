import { useEffect, useState } from 'preact/hooks';
import { api } from '../lib/api';
import { t } from '../lib/i18n';

const DISMISS_KEY = 'memesh.insightsBanner.dismissed';

interface ProposalSummary {
  id: number;
  status: 'pending' | 'applied' | 'rejected';
  // Other fields exist on the wire (project, cluster_key, etc.) but the
  // banner only needs to know that pending proposals exist.
}

interface Props {
  /**
   * Current active tab. The banner self-suppresses on Home — insights
   * lead that tab, so there's no point nudging someone who's already
   * looking at the list.
   */
  currentTab: string;
  /**
   * Click handler that switches the active tab to Home (where insights
   * live). Wired from App.tsx so the banner doesn't need to know about
   * the tab-state machine.
   */
  onNavigateToInsights: () => void;
}

/**
 * Global onboarding banner that surfaces pending dream proposals from
 * any tab. Without this, users only see proposals if they land on Home
 * — which a user parked on another tab may not revisit for days.
 *
 * Visual style mirrors `OnboardingBanner` (accent-tinted, flat fill) so
 * it reads as a friendly nudge rather than an error/warn (those slots
 * are owned by `DoctorBanner`).
 *
 * Hide rules (in order):
 *   1. Already on Home (where insights lead) → no point nudging.
 *   2. User dismissed this session via the × button.
 *   3. No pending proposals.
 *
 * Dismiss is sessionStorage-only on purpose. Persisting across sessions
 * would suppress the banner forever once the user clicks ×, even after
 * the dreamer generates new insights tomorrow. Re-surfacing on the
 * next visit gives users another chance to engage without being
 * repeatedly nagged within one sitting.
 */
export function InsightsBanner({ currentTab, onNavigateToInsights }: Props) {
  const [pendingCount, setPendingCount] = useState<number>(0);
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try { return sessionStorage.getItem(DISMISS_KEY) === 'true'; } catch { return false; }
  });

  useEffect(() => {
    let mounted = true;
    const fetch = () => {
      api<ProposalSummary[]>('GET', '/v1/dream/proposals?status=pending')
        .then((data) => {
          if (!mounted) return;
          // api() already unwraps the server's { success, data } envelope,
          // so `data` IS the proposal array. Anything else is a payload this
          // bundle cannot read — logged, and the count it already has stays.
          if (!Array.isArray(data)) {
            console.warn('[memesh dashboard] /v1/dream/proposals answered, but with a shape this bundle cannot render:', data);
            return;
          }
          setPendingCount(data.length);
        })
        .catch((e: unknown) => {
          // Endpoint unavailable: the banner keeps what it last knew (or stays
          // hidden if it never knew). Logged, like the same request in
          // InsightsTab.
          if (mounted) console.warn('[memesh dashboard] /v1/dream/proposals failed to load:', e);
        });
    };
    fetch();
    window.addEventListener('memesh:data-changed', fetch);
    return () => { mounted = false; window.removeEventListener('memesh:data-changed', fetch); };
  }, []);

  if (currentTab === 'Home') return null;
  if (dismissed) return null;
  if (pendingCount === 0) return null;

  function dismiss() {
    setDismissed(true);
    try { sessionStorage.setItem(DISMISS_KEY, 'true'); } catch { /* private mode */ }
  }

  // Pluralize the noun via a {s} param — "1 new insight" vs
  // "3 new insights". Locales that don't pluralize the same way
  // (zh-TW/zh-CN/ja/ko/th — "insight" stays singular) translate the
  // template directly without the {s} token, which the substitution
  // engine drops harmlessly.
  const message = t('banner.pendingInsights', { n: pendingCount, s: pendingCount === 1 ? '' : 's' });

  return (
    // Two sibling buttons in a plain box: one that goes to the insights, one
    // that dismisses. Nesting the × inside a clickable banner (a div with
    // role="button") put a control inside a control: assistive tech may not
    // expose the inner one, and Enter/Space on it had to be special-cased.
    <div
      style={{
        margin: '12px auto 0',
        maxWidth: 920,
        border: '1px solid rgba(143, 242, 92, 0.32)',
        borderRadius: 'var(--radius)',
        background: 'var(--life-soft)', /* flattened: a decorative gradient is ornament (DESIGN.md) */
        fontSize: 14,
        lineHeight: 1.5,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}
    >
      <button
        type="button"
        // The visible text is part of the name (WCAG 2.5.3): a bare "View all"
        // replaced "3 new insights…" for assistive tech.
        aria-label={`${message} — ${t('banner.viewAll')}`}
        onClick={onNavigateToInsights}
        style={{
          flex: 1,
          minWidth: 0,
          padding: '10px 0 10px 16px',
          background: 'transparent',
          border: 'none',
          color: 'var(--text-1)',
          font: 'inherit',
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <span style={{ marginRight: 6 }} aria-hidden="true">💡</span>
        {message}
      </button>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t('banner.dismiss')}
        style={{
          margin: '0 8px 0 0',
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
    </div>
  );
}
