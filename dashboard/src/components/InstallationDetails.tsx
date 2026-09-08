import { useEffect, useState } from 'preact/hooks';
import { api } from '../lib/api';
import { t } from '../lib/i18n';

interface VersionDetails {
  current: string;
  terminal: string;
  shellPath: string;
  packageRoot: string;
}

/** Optional installation metadata stays out of the homepage alert channel. */
export function InstallationDetails() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [details, setDetails] = useState<VersionDetails | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setDetails(null);
    api<{ checks?: Array<{ code?: string; params?: Partial<VersionDetails> }> }>('GET', '/v1/doctor')
      .then(result => {
        const params = result?.checks?.find(check => check.code === 'shell-cli.versions')?.params;
        if (active && params && ['current', 'terminal', 'shellPath', 'packageRoot'].every(key => typeof params[key as keyof VersionDetails] === 'string')) {
          setDetails(params as VersionDetails);
        }
      })
      .catch(() => { /* Optional metadata unavailable; rendered explicitly below. */ })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open]);

  return <section class="card">
    <button type="button" class="btn" aria-expanded={open} aria-controls="installation-details" onClick={() => setOpen(!open)}>
      {t('settings.installationDetails')}
    </button>
    {open && <div id="installation-details" style={{ marginTop: 12 }}>
      {loading ? <p>{t('common.loading')}</p> : details ? <>
        <p>{t('doctor.msg.shell-cli.versions.summary', { current: details.current, terminal: details.terminal })}</p>
        <p>{t('settings.installationDetailsHint')}</p>
        <details>
          <summary>{t('settings.technicalDetails')}</summary>
          <dl>
            <dt>{t('settings.interfacePath')}</dt><dd><code>{details.packageRoot}</code></dd>
            <dt>{t('settings.terminalPath')}</dt><dd><code>{details.shellPath}</code></dd>
          </dl>
        </details>
      </> : <p role="status">{t('settings.installationDetailsUnavailable')}</p>}
    </div>}
  </section>;
}
