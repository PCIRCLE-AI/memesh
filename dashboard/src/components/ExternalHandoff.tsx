import { useState } from 'preact/hooks';
import { t } from '../lib/i18n';

export function TerminalHandoff({ id, command }: { id: string; command: string }) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  async function copyCommand() {
    // `navigator.clipboard` does not exist on a non-secure origin (the
    // dashboard opened over plain http on a LAN address), and the call throws.
    // Say so: a button that does nothing looks broken.
    try { await navigator.clipboard.writeText(command); setCopy('copied'); }
    catch { setCopy('failed'); }
  }
  return (
    <div data-external-handoff={id} data-destination="terminal" style={{ marginTop: 6 }}>
      <div style={{ fontSize: 14, color: 'var(--warning)', fontWeight: 600 }}>{t('handoff.terminal')}</div>
      <div style={{ fontSize: 14, color: 'var(--text-3)', margin: '2px 0 5px' }}>{t('handoff.terminalPrereq')}</div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <code style={{ fontFamily: 'var(--mono)', fontSize: 14 }}>{command}</code>
        <button type="button" class="btn btn-sm" onClick={() => { void copyCommand(); }}>
          {copy === 'copied' ? t('handoff.commandCopied') : t('handoff.copyCommand')}
        </button>
      </div>
      {copy === 'failed' && (
        <div role="status" style={{ fontSize: 14, color: 'var(--danger)', marginTop: 4 }}>{t('handoff.copyFailed')}</div>
      )}
    </div>
  );
}

export function GitHubDestination({ id }: { id: string }) {
  return <span data-external-handoff={id} data-destination="github" style={{ fontSize: 14, color: 'var(--text-3)' }}>{t('handoff.github')}</span>;
}
