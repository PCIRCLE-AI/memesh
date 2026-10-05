/** Complete set of deliberate Dashboard exits. Contract tests keep the
 * rendered surfaces and this inventory in sync — in both directions: every
 * entry is rendered where it says, and every handoff a component renders is
 * an entry here with the destination that component kind implies. */
export const DASHBOARD_EXTERNAL_HANDOFFS = [
  { id: 'doctor-fix-command', destination: 'terminal', surface: 'DoctorBanner' },
  { id: 'doctor-help', destination: 'github', surface: 'DoctorBanner' },
  { id: 'feedback-submit', destination: 'github', surface: 'FeedbackWidget' },
  { id: 'settings-update', destination: 'terminal', surface: 'SettingsTab' },
  { id: 'demo-cli-fallback', destination: 'terminal', surface: 'OnboardingBanner' },
  { id: 'project-hook-setup', destination: 'terminal', surface: 'ProjectTab' },
  { id: 'load-recovery', destination: 'terminal', surface: 'failure' },
  { id: 'server-error-recovery', destination: 'terminal', surface: 'api' },
] as const;

export function openExternalWindow(url: string): boolean {
  const opened = window.open(url, '_blank');
  if (!opened) return false;
  try { opened.opener = null; } catch { /* cross-origin browser policy */ }
  return true;
}

/** `encodeURIComponent` throws on a lone surrogate (`"a\uD800b"`); the text of
 *  a feedback description is the user's, so it can carry one. Replace it with
 *  U+FFFD instead of letting the whole submit die unreported. */
function wellFormed(text: string): string {
  return Array.from(text, (ch) => (ch.length === 1 && ch >= '\uD800' && ch <= '\uDFFF' ? '\uFFFD' : ch)).join('');
}

/** The pre-filled "new issue" address — one builder for the two surfaces that
 *  open one (the feedback widget and the doctor banner's Get help). */
export function githubIssueUrl({ title, body, labels }: { title: string; body: string; labels: string }): string {
  const q = (value: string) => encodeURIComponent(wellFormed(value));
  return `https://github.com/PCIRCLE-AI/memesh/issues/new?title=${q(title)}&body=${q(body)}&labels=${q(labels)}`;
}

export function terminalCommands(text: string): string[] {
  return [...text.matchAll(/`(memesh(?:\s+[^`]+)?)`/g)].map(match => match[1]);
}
