import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { REQUIRED_CHECKS, uiScope, validateUiReview } from '../scripts/qa/ui-review.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-ui-review-test-'));
fs.mkdirSync(path.join(root, '.qa'));
const bytes = 'Controlled fixture only, not actual UI evidence.\n';
fs.writeFileSync(path.join(root, '.qa/replay.txt'), bytes);
fs.mkdirSync(path.join(root, 'dashboard/dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dashboard/dist/index.html'), '<html>fixture</html>');
const dashboardHash = createHash('sha256').update('<html>fixture</html>').digest('hex');
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const revision = 'a'.repeat(40);
const now = Date.parse('2026-09-08T12:00:00Z');
const scope = { locales: ['en', 'zh-TW'], tabs: ['Home', 'Settings'] };
const context = { root, revision, now, clean: true, scope };
const row = () => ({ status: 'PASS', observation: 'Fixture observation', replay: ['Open fixture route and trigger the specified scenario'], expected: 'Expected fixture output', actual: 'Observed fixture output', evidence: '.qa/replay.txt', sha256: createHash('sha256').update(bytes).digest('hex') });
function valid(): any {
  return {
    schema_version: 'memesh-ui-review/v1', revision, dirty: false,
    reviewed_at: '2026-09-08T11:00:00Z', runtime: 'isolated fixture browser',
    reviewer: 'independent-reviewer', implementer: 'implementer', independent: true,
    reviewer_basis: 'Fixture non-author reviewer assignment', dashboard_sha256: dashboardHash,
    verdict: 'PASS', checks: REQUIRED_CHECKS.map(id => ({ id, ...row() })),
    coverage: scope.locales.flatMap(locale => scope.tabs.map(tab => ({ locale, tab, ...row() }))),
    findings: [],
  };
}

describe('UI review evidence gate', () => {
  it('accepts a complete bound fixture without treating it as real UI proof', () => {
    expect(validateUiReview(valid(), context)).toEqual([]);
  });
  it('derives all advertised tabs and locales from actual source', () => {
    const actual = uiScope(repo);
    expect(actual.locales).toEqual(['en', 'zh-TW', 'zh-CN', 'ja', 'ko', 'pt', 'fr', 'de', 'vi', 'es', 'th']);
    expect(actual.tabs).toEqual(['Home', 'Memories', 'Project', 'Settings']);
  });
  it.each([
    ['missing report', () => null],
    ['wrong SHA', (r: any) => ({ ...r, revision: 'b'.repeat(40) })],
    ['dirty review', (r: any) => ({ ...r, dirty: true })],
    ['same reviewer', (r: any) => ({ ...r, reviewer: r.implementer })],
    ['not independent', (r: any) => ({ ...r, independent: false })],
    ['missing reviewer', (r: any) => ({ ...r, reviewer: '' })],
    ['failed verdict', (r: any) => ({ ...r, verdict: 'FAIL' })],
    ['unresolved concern', (r: any) => ({ ...r, verdict: 'PASS_WITH_CONCERNS' })],
    ['stale', (r: any) => ({ ...r, reviewed_at: '2026-09-06T00:00:00Z' })],
    ['future', (r: any) => ({ ...r, reviewed_at: '2026-09-09T00:00:00Z' })],
    ['missing date', (r: any) => ({ ...r, reviewed_at: null })],
    ['missing runtime', (r: any) => ({ ...r, runtime: '' })],
    ['stale built dashboard', (r: any) => ({ ...r, dashboard_sha256: '0'.repeat(64) })],
    ['missing reviewer basis', (r: any) => ({ ...r, reviewer_basis: '' })],
    ['missing findings', (r: any) => ({ ...r, findings: null })],
    ['open finding', (r: any) => ({ ...r, findings: [{ id: 'F1', resolved: false }] })],
    ['no retest', (r: any) => ({ ...r, findings: [{ id: 'F1', resolved: true, fix: 'fixed' }] })],
  ])('rejects %s', (_label, change) => {
    expect(validateUiReview(change(valid()), context).length).toBeGreaterThan(0);
  });
  it.each(REQUIRED_CHECKS)('cannot omit required review: %s', id => {
    const report = valid();
    report.checks = report.checks.filter((r: any) => r.id !== id);
    expect(validateUiReview(report, context).join('\n')).toContain(id);
  });
  it.each(scope.locales.flatMap(locale => scope.tabs.map(tab => `${locale}/${tab}`)))('cannot omit browser coverage: %s', pair => {
    const report = valid();
    report.coverage = report.coverage.filter((r: any) => `${r.locale}/${r.tab}` !== pair);
    expect(validateUiReview(report, context).join('\n')).toContain(pair);
  });
  it.each(['.qa/missing.txt', '.qa/../package.json', '/tmp/replay.txt'])('rejects absent or out-of-scope evidence %s', evidence => {
    const report = valid();
    report.checks[0].evidence = evidence;
    expect(validateUiReview(report, context).length).toBeGreaterThan(0);
  });
  it('rejects changed evidence bytes, missing observations and duplicate coverage', () => {
    const report = valid();
    report.checks[0].sha256 = '0'.repeat(64);
    report.checks[1].observation = '';
    report.coverage.push(report.coverage[0]);
    expect(validateUiReview(report, context)).toHaveLength(3);
  });
  it('rejects a generic evidence token without replay and visible outcomes', () => {
    const report = valid();
    delete report.checks[0].replay;
    delete report.coverage[0].actual;
    expect(validateUiReview(report, context).filter(error => error.includes('replay steps'))).toHaveLength(2);
  });
  it('rejects invented scope even when the required scope is present', () => {
    const report = valid();
    report.checks.push({ id: 'invented', ...row() });
    report.coverage.push({ locale: 'invented', tab: 'Home', ...row() });
    expect(validateUiReview(report, context)).toHaveLength(2);
  });
  it('requires a clean current tree even if report says clean', () => {
    expect(validateUiReview(valid(), { ...context, clean: false })).toContain('candidate working tree is not clean');
  });
  it('retains resolved findings with passing evidence-bound retests', () => {
    const report = valid();
    report.findings = [{ id: 'F1', fix: 'Corrected message', resolved: true, retest: row() }];
    expect(validateUiReview(report, context)).toEqual([]);
  });
  it('actual CLI fails closed when candidate identity cannot be established', () => {
    const result = spawnSync(process.execPath, [path.join(repo, 'scripts/qa/ui-review.mjs')], { cwd: root, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('BLOCKED — UI review');
  });
});
