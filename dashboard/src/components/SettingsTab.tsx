import { useState, useEffect } from 'preact/hooks';
import {
  api,
  type AutoUpdatePolicy,
  type ConfigData,
  type UpdateStatusData,
} from '../lib/api';
import { t, setLocale, getLocales, type Locale } from '../lib/i18n';
import { actionFailureMessage } from '../lib/failure';
import { TerminalHandoff } from './ExternalHandoff';

interface SettingsTabProps {
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
}

/** Reject a successful but incompatible response instead of rendering false state. */
export function isConfigRenderable(c: ConfigData | null): c is ConfigData {
  return typeof c?.config === 'object' && c.config !== null;
}

/**
 * The fields the update summary BRANCHES on, not merely renders. A hollow
 * `{}` here does not crash anything — worse, it falls through every branch
 * and lands on "Up to date": a false green produced by a payload that said
 * nothing at all. Version strings and timestamps degrade to '—' harmlessly
 * and are deliberately not required.
 */
export function isUpdateStatusRenderable(u: UpdateStatusData | null): u is UpdateStatusData {
  return (
    typeof u?.checkSucceeded === 'boolean' &&
    typeof u.freshness === 'string' &&
    typeof u.updateAvailable === 'boolean'
  );
}

function formatTimestamp(locale: Locale, value: string | null): string {
  if (!value) return '—';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(locale);
}

function getInstallChannelLabel(channel: UpdateStatusData['installChannel'] | undefined): string {
  switch (channel) {
    case 'npm-global':
      return t('settings.installNpmGlobal');
    case 'npm-local':
      return t('settings.installNpmLocal');
    case 'source-checkout':
      return t('settings.installSourceCheckout');
    default:
      return t('settings.installUnknown');
  }
}

function getInstallChannelGuidance(channel: UpdateStatusData['installChannel'] | undefined): string {
  switch (channel) {
    case 'npm-global':
      return t('settings.updateGuidanceNpmGlobal');
    case 'npm-local':
      return t('settings.updateGuidanceNpmLocal');
    case 'source-checkout':
      return t('settings.updateGuidanceSourceCheckout');
    default:
      return t('settings.updateGuidanceUnknown');
  }
}

export function SettingsTab({ locale, onLocaleChange }: SettingsTabProps) {
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatusData | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configSaving, setConfigSaving] = useState(false);
  const [configMessage, setConfigMessage] = useState('');
  const [updateLoading, setUpdateLoading] = useState(true);
  const [updateRefreshing, setUpdateRefreshing] = useState(false);
  async function loadUpdateStatus(forceFresh = true, keepCurrentState = false) {
    if (keepCurrentState) {
      setUpdateRefreshing(true);
    } else {
      setUpdateLoading(true);
    }

    try {
      const path = forceFresh ? '/v1/update-status' : '/v1/update-status?cached=1';
      const data = await api<UpdateStatusData>('GET', path);
      if (!isUpdateStatusRenderable(data)) {
        // The request SUCCEEDED, so no error path will ever log this — and a
        // hollow payload here would read as "Up to date", not as a failure.
        console.warn('[memesh dashboard] /v1/update-status answered, but with a shape this bundle cannot render — stale bundle or version skew, not an outage:', data);
        if (!keepCurrentState) setUpdateStatus(null);
        return;
      }
      setUpdateStatus(data);
    } catch {
      if (!keepCurrentState) {
        setUpdateStatus(null);
      }
    } finally {
      if (keepCurrentState) {
        setUpdateRefreshing(false);
      } else {
        setUpdateLoading(false);
      }
    }
  }

  useEffect(() => {
    let cancelled = false;
    setConfigLoading(true);
    api<ConfigData>('GET', '/v1/config')
      .then((data) => {
        if (cancelled) return;
        if (!isConfigRenderable(data)) {
          if (data !== null) {
            console.warn('[memesh dashboard] /v1/config answered, but with a shape this bundle cannot render — stale bundle or version skew, not an outage:', data);
          }
          setConfig(null);
          return;
        }
        setConfig(data);
      })
      .catch((e) => {
        // This chain had a .finally and no .catch, so a server that was simply
        // down became an unhandled rejection instead of a degraded tab.
        console.warn('[memesh dashboard] /v1/config failed to load:', e);
        setConfig(null);
      })
      .finally(() => { if (!cancelled) setConfigLoading(false); });

    void loadUpdateStatus();

    return () => {
      cancelled = true;
    };
  }, []);

  async function saveAutoUpdate(next: AutoUpdatePolicy) {
    setConfigSaving(true);
    setConfigMessage('');
    try {
      await api('POST', '/v1/config', { autoUpdate: next });
      const readback = await api<ConfigData>('GET', '/v1/config');
      if (!isConfigRenderable(readback) || readback.config.autoUpdate !== next) {
        throw new Error(t('settings.configReadbackFailed'));
      }
      setConfig(readback);
      setConfigMessage(t('settings.saved'));
    } catch (e) {
      setConfigMessage(t('common.error') + ': ' + actionFailureMessage(e));
    } finally {
      setConfigSaving(false);
    }
  }

  function changeInterfaceLanguage(nextLocale: Locale) {
    setLocale(nextLocale);
    onLocaleChange(nextLocale);
  }
  const isCheckingUpdates = updateLoading || (updateRefreshing && !updateStatus);
  const updateActionInProgress = updateLoading || updateRefreshing;
  const isDeprecated = Boolean(updateStatus?.currentVersionDeprecated);
  const hasUpdateTarget = Boolean(
    updateStatus?.latestVersion
    && updateStatus.latestVersion !== updateStatus.currentVersion,
  );
  // Codex rounds 34/35: "confirmed no upgrade target" is only safe
  // to claim when the registry-side equality came from a FRESH
  // lookup. Round 34 distinguished null (unknown) from === current.
  // Round 35 noted that === current from cached/stale data still
  // can't be trusted — npm could have published a replacement
  // since the last successful check. Treat cache/stale/null all as
  // "target unknown" and route the user at `memesh update`.
  const noUpgradeTargetConfirmed = Boolean(
    isDeprecated
    && updateStatus?.latestVersion
    && updateStatus.latestVersion === updateStatus.currentVersion
    && updateStatus?.freshness === 'fresh',
  );
  // Codex round 28: partial-failure state is `checkSucceeded === true`
  // (the version lookup answered) AND `lastError` populated (the
  // deprecation sub-call did not). In that case we don't actually
  // know whether the installed version is flagged for security
  // disclosure. Refuse to show "Up to date" + green here — that's
  // a false-green that hides a security-relevant unknown.
  const isPartialDeprecationFailure = Boolean(
    updateStatus?.checkSucceeded && updateStatus?.lastError,
  );
  // A maintainer-deprecated install is never "up to date" — even
  // when no newer version has been published yet. The primary
  // summary line and color must reflect that so the green "all
  // clear" state can't contradict the deprecation card above. But
  // we also can't claim "Update available" when there's no actual
  // newer version published; in that rare case (deprecation lands
  // before the replacement does), keep the deprecation banner card
  // doing the talking and label the summary "Deprecated — no
  // upgrade target yet" so the user understands `memesh update`
  // would no-op.
  const updateSummary = isCheckingUpdates
    ? t('settings.updateChecking')
    : !updateStatus
      ? t('settings.updateUnavailable')
      : isDeprecated
        ? hasUpdateTarget
          ? t('settings.updateAvailable')
          : noUpgradeTargetConfirmed
            ? t('settings.updateDeprecatedNoTarget')
            : t('settings.updateDeprecatedTargetUnknown')
        : updateStatus.freshness === 'unavailable'
          ? t('settings.updateNoSuccessfulChecks')
          : !updateStatus.checkSucceeded && updateStatus.freshness === 'stale'
            ? t('settings.updateStale')
            : !updateStatus.checkSucceeded && updateStatus.freshness === 'cached'
              ? t('settings.updateCachedFallback')
              : updateStatus.updateAvailable
                ? t('settings.updateAvailable')
                : isPartialDeprecationFailure
                  ? t('settings.updatePartialSummary')
                  : t('settings.upToDate');
  const updateSummaryColor = !updateStatus
    ? 'var(--warning)'
    : isDeprecated
      ? 'var(--danger)'
      : updateStatus.freshness === 'unavailable'
        ? 'var(--warning)'
        : !updateStatus.checkSucceeded && updateStatus.freshness === 'stale'
          ? 'var(--warning)'
          : !updateStatus.checkSucceeded && updateStatus.freshness === 'cached'
            ? 'var(--info)'
            : updateStatus.updateAvailable
              ? 'var(--info)'
              : isPartialDeprecationFailure
                ? 'var(--warning)'
                : 'var(--success)';
  const updateSourceLabel = updateStatus?.freshness === 'stale'
    ? t('settings.updateSourceStale')
    : updateStatus?.source === 'cache'
      ? t('settings.updateSourceCached')
      : updateStatus?.source === 'fresh'
        ? t('settings.updateSourceFresh')
        : t('settings.updateSourceUnavailable');
  const installMethodLabel = getInstallChannelLabel(updateStatus?.installChannel);
  const installGuidance = getInstallChannelGuidance(updateStatus?.installChannel);
  const lastAttemptLabel = isCheckingUpdates ? t('common.loading') : formatTimestamp(locale, updateStatus?.lastAttemptAt || null);
  const lastSuccessfulLabel = isCheckingUpdates ? t('common.loading') : formatTimestamp(locale, updateStatus?.lastSuccessfulCheckAt || null);
  const showLastSuccessful = Boolean(updateStatus?.lastSuccessfulCheckAt);
  const showLastError = Boolean(updateStatus?.lastError) && !isCheckingUpdates;

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {/* Updates */}
      <div class="card">
        <div class="card-title">{t('settings.updates')}</div>
        {updateStatus?.currentVersionDeprecated && updateStatus.deprecationMessage && (
          <div
            style={{
              background: 'var(--danger-soft)',
              border: '1px solid rgba(255, 122, 107, 0.4)',
              borderRadius: 'var(--radius-xs)',
              padding: '10px 12px',
              marginBottom: 12,
              fontSize: 12,
              color: 'var(--text-0)',
              lineHeight: 1.55,
            }}
            data-testid="settings-deprecation-warning"
          >
            <strong style={{ color: 'var(--danger)' }}>
              {t('settings.updateDeprecatedTitle', { version: updateStatus.currentVersion })}
            </strong>
            <div style={{ marginTop: 4, opacity: 0.9 }}>{updateStatus.deprecationMessage}</div>
          </div>
        )}
        {updateStatus && updateStatus.checkSucceeded && updateStatus.lastError && (
          <div
            style={{
              background: 'var(--warning-soft)',
              border: '1px solid rgba(255, 171, 64, 0.4)',
              borderRadius: 'var(--radius-xs)',
              padding: '10px 12px',
              marginBottom: 12,
              fontSize: 12,
              color: 'var(--text-0)',
              lineHeight: 1.55,
            }}
            data-testid="settings-update-partial-warning"
          >
            <strong style={{ color: 'var(--warning)' }}>{t('settings.updatePartialTitle')}</strong>
            <div style={{ marginTop: 4, opacity: 0.9 }}>
              {t('settings.updatePartialDescription', { message: updateStatus.lastError ?? '' })}
            </div>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'baseline', marginBottom: 12, flexWrap: 'wrap' }}>
          <div style={{ color: updateSummaryColor, fontSize: 13, fontWeight: 600 }}>{updateSummary}</div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            {!isCheckingUpdates && updateStatus && (
              <div style={{ fontSize: 11, color: 'var(--text-2)' }}>{updateSourceLabel}</div>
            )}
            <button
              class="btn btn-sm"
              type="button"
              onClick={() => { void loadUpdateStatus(true, Boolean(updateStatus)); }}
              disabled={updateActionInProgress}
            >
              {updateActionInProgress ? t('settings.updateChecking') : t('settings.checkNow')}
            </button>
          </div>
        </div>

        <div style={{ display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, fontSize: 12 }}>
            <span style={{ color: 'var(--text-2)' }}>{t('settings.installMethod')}</span>
            <span style={{ color: 'var(--text-0)' }}>{isCheckingUpdates ? t('common.loading') : installMethodLabel}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, fontSize: 12 }}>
            <span style={{ color: 'var(--text-2)' }}>{t('settings.currentVersion')}</span>
            <span style={{ color: 'var(--text-0)', fontFamily: 'var(--mono)' }}>{updateStatus?.currentVersion || '—'}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, fontSize: 12 }}>
            <span style={{ color: 'var(--text-2)' }}>{t('settings.latestVersion')}</span>
            <span style={{ color: 'var(--text-0)', fontFamily: 'var(--mono)' }}>{updateStatus?.latestVersion || '—'}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, fontSize: 12 }}>
            <span style={{ color: 'var(--text-2)' }}>{t('settings.lastAttempted')}</span>
            <span style={{ color: 'var(--text-0)', fontFamily: 'var(--mono)' }}>{lastAttemptLabel}</span>
          </div>
          {showLastSuccessful && (
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, fontSize: 12 }}>
              <span style={{ color: 'var(--text-2)' }}>{t('settings.lastSuccessful')}</span>
              <span style={{ color: 'var(--text-0)', fontFamily: 'var(--mono)' }}>{lastSuccessfulLabel}</span>
            </div>
          )}
          {!updateLoading && (
            <div style={{ color: 'var(--text-2)', fontSize: 12, lineHeight: 1.5, marginTop: 2 }}>{installGuidance}</div>
          )}
          {showLastError && (
            <div style={{ color: 'var(--warning)', fontSize: 12, lineHeight: 1.5 }}>
              {t('settings.updateLastError', { message: updateStatus?.lastError || '' })}
            </div>
          )}
          {updateStatus?.recommendedCommand && (
            <div style={{ display: 'grid', gap: 6, marginTop: 4 }}>
              <span style={{ color: 'var(--text-2)', fontSize: 12 }}>{t('settings.updateCommand')}</span>
              <TerminalHandoff id="settings-update" command={updateStatus.recommendedCommand} />
            </div>
          )}
        </div>
      </div>

      {/* Behaviour — surfaces autoUpdate so users can configure it from the
          dashboard instead of editing ~/.memesh/config.json by hand. The
          field was already accepted by POST /v1/config; this is the missing
          UI side. */}
      <div class="card">
        <div class="card-title">{t('settings.behaviourTitle')}</div>

        <div style={{ marginTop: 8 }}>
          {configLoading && <div class="loading" role="status" />}
          <label id="settings-autoupdate-label" style={{ fontSize: 12, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>
            {t('settings.autoUpdateLabel')}
          </label>
          <select
            aria-labelledby="settings-autoupdate-label"
            value={config?.config.autoUpdate ?? 'off'}
            disabled={!config || configSaving}
            onChange={(e) => { void saveAutoUpdate((e.target as HTMLSelectElement).value as AutoUpdatePolicy); }}
            style={{ fontSize: 13, padding: '6px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-1)', cursor: 'pointer' }}
          >
            <option value="off">{t('settings.autoUpdateOff')}</option>
            <option value="patch">{t('settings.autoUpdatePatch')}</option>
            <option value="minor">{t('settings.autoUpdateMinor')}</option>
            <option value="major">{t('settings.autoUpdateMajor')}</option>
          </select>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
            {t('settings.autoUpdateHint')}
          </div>
          {configMessage && (
            <div role={configMessage.startsWith(t('common.error')) ? 'alert' : 'status'} style={{ marginTop: 8, fontSize: 12 }}>
              {configMessage}
            </div>
          )}
        </div>

      </div>

      {/* Language */}
      <div class="card">
        <div class="card-title">{t('settings.language')}</div>
        <div style={{ display: 'grid', gap: 12 }}>
          <div>
            <label id="settings-interface-language-label" style={{ fontSize: 12, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>
              {t('settings.interfaceLanguage')}
            </label>
            <select
              aria-labelledby="settings-interface-language-label"
              value={locale}
              onChange={(e) => changeInterfaceLanguage((e.target as HTMLSelectElement).value as Locale)}
              style={{ fontSize: 13, padding: '6px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-1)', cursor: 'pointer' }}
            >
              {getLocales().map((l) => (
                <option key={l.code} value={l.code}>{l.name}</option>
              ))}
            </select>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
              {t('settings.interfaceLanguageHint')}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
