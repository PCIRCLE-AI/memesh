#!/usr/bin/env node
// Validates the binding/completeness of an independent browser review, not the
// truth of its observations. The release owner must inspect and replay evidence.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REQUIRED_CHECKS = [
  'plain-language', 'localized-backend-messages', 'actionable-diagnostics',
  'unpublished-version', 'isolated-database', 'feature-navigation-alignment',
  'empty-loading-error-states', 'persisted-effects-and-cleanup',
  'text-contrast-and-size', 'responsive-layout',
];
export const REPORT_PATH = '.qa/ui-review.json';

/** Derive scope from shipped UI source; fail closed if its declaration changes. */
export function uiScope(root) {
  const i18n = fs.readFileSync(path.join(root, 'dashboard/src/lib/i18n.ts'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'dashboard/src/App.tsx'), 'utf8');
  const locales = i18n.match(/^type Locale = ([^;]+);/m)?.[1];
  const tabs = app.match(/const TAB_KEYS = \[([^\]]+)\] as const;/)?.[1];
  const strings = value => [...(value ?? '').matchAll(/'([^']+)'/g)].map(match => match[1]);
  const scope = { locales: strings(locales), tabs: strings(tabs) };
  if (!scope.locales.length || !scope.tabs.length) throw new Error('UI scope declarations unreadable; update the scope reader, never assume empty coverage');
  return scope;
}

export function validateUiReview(report, { revision, clean, scope, root, now = Date.now() }) {
  const errors = [];
  const text = value => typeof value === 'string' && value.trim().length > 0;
  if (!clean) errors.push('candidate working tree is not clean');
  if (!report || report.schema_version !== 'memesh-ui-review/v1') return [...errors, 'missing or invalid independent UI review report'];
  if (!/^[a-f0-9]{40}$/.test(revision ?? '') || report.revision !== revision) errors.push('review must name the exact candidate SHA');
  if (report.dirty !== false) errors.push('review must exercise a clean candidate');
  const finished = Date.parse(report.reviewed_at);
  if (!Number.isFinite(finished) || finished > now || now - finished > 86_400_000) errors.push('review must be dated within the last 24 hours, not in the future');
  if (!text(report.reviewer) || !text(report.implementer) || report.reviewer === report.implementer || report.independent !== true) errors.push('a different, non-authoring independent reviewer is required');
  if (report.verdict !== 'PASS') errors.push('UI findings must be fixed and re-reviewed before PASS');
  if (!text(report.runtime)) errors.push('identify the actual browser and candidate server runtime');
  if (!text(report.reviewer_basis)) errors.push('retain the independent reviewer identity/non-authorship basis');
  try {
    const dashboard = fs.readFileSync(path.join(root, 'dashboard/dist/index.html'));
    if (createHash('sha256').update(dashboard).digest('hex') !== report.dashboard_sha256) errors.push('reviewed dashboard artifact differs from the current build');
  } catch {
    errors.push('built dashboard artifact is unavailable');
  }

  function evidence(item, label) {
    if (item?.status !== 'PASS' || !text(item?.observation)) errors.push(`${label}: missing passing observation`);
    if (!Array.isArray(item?.replay) || !item.replay.length || !item.replay.every(text) || !text(item?.expected) || !text(item?.actual)) errors.push(`${label}: replay steps and expected/actual visible results are required`);
    const relative = item?.evidence;
    if (!text(relative) || !relative.startsWith('.qa/') || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) {
      errors.push(`${label}: evidence must be a local .qa file`);
      return;
    }
    try {
      const resolved = fs.realpathSync(path.join(root, relative));
      const qaRoot = fs.realpathSync(path.join(root, '.qa')) + path.sep;
      if (!resolved.startsWith(qaRoot)) throw new Error('evidence escapes .qa');
      const bytes = fs.readFileSync(resolved);
      if (!bytes.length || createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error('missing bytes or digest mismatch');
    } catch {
      errors.push(`${label}: evidence unreadable or digest does not match`);
    }
  }
  for (const id of REQUIRED_CHECKS) {
    const rows = Array.isArray(report.checks) ? report.checks.filter(row => row?.id === id) : [];
    if (rows.length !== 1) errors.push(`${id}: require exactly one review check`);
    else evidence(rows[0], id);
  }
  if (Array.isArray(report.checks) && report.checks.some(row => !REQUIRED_CHECKS.includes(row?.id))) errors.push('unknown check in review inventory');
  if (Array.isArray(report.coverage) && report.coverage.some(row => !scope.locales.includes(row?.locale) || !scope.tabs.includes(row?.tab))) errors.push('unknown locale/tab in review inventory');
  // Every advertised locale and tab must be visited, not just a convenient sample.
  for (const locale of scope.locales) for (const tab of scope.tabs) {
    const rows = Array.isArray(report.coverage) ? report.coverage.filter(row => row?.locale === locale && row?.tab === tab) : [];
    if (rows.length !== 1) errors.push(`${locale}/${tab}: missing or duplicate browser coverage`);
    else evidence(rows[0], `${locale}/${tab}`);
  }
  if (!Array.isArray(report.findings)) errors.push('findings inventory is required, even when empty');
  else for (const finding of report.findings) {
    if (!text(finding?.id) || !text(finding?.fix) || finding?.resolved !== true) errors.push('every finding needs a fix and a resolved disposition');
    evidence(finding?.retest, `finding ${finding?.id ?? '?' } retest`);
  }
  return errors;
}

export function main(root = process.cwd()) {
  try {
    const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const revision = git(['rev-parse', 'HEAD']);
    const clean = git(['status', '--porcelain']) === '';
    const scope = uiScope(root);
    const report = JSON.parse(fs.readFileSync(path.join(root, REPORT_PATH), 'utf8'));
    const errors = validateUiReview(report, { revision, clean, scope, root });
    if (errors.length) throw new Error(errors.join('\n'));
    console.log('UI review evidence binding/completeness accepted; this is not automated proof of usability or reviewer independence. Release owner must verify the retained replay.');
    return 0;
  } catch (error) {
    console.error(`BLOCKED — UI review: ${error.message}\nFollow CONTRIBUTING.md: independent browser review, fix findings, refreeze, and re-review. Never fabricate ${REPORT_PATH}.`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) process.exitCode = main();
