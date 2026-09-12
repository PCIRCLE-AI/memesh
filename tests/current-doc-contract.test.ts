import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCurrentDocumentationContracts } from '../scripts/lib/current-doc-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');
const baseline = {
  architecture: read('docs/ARCHITECTURE.md'),
  handlers: read('src/transports/mcp/handlers.ts'),
  httpServer: read('src/transports/http/server.ts'),
  retiredRoutes: read('src/transports/http/retired-routes.ts'),
  operations: read('src/core/operations.ts'),
  apiReference: read('docs/api/API_REFERENCE.md'),
  methodology: read('benchmarks/longmemeval/METHODOLOGY.md'),
  benchmarkResults: read('benchmarks/longmemeval/RESULTS.md'),
  benchmarkResultsReadme: read('benchmarks/longmemeval/results/README.md'),
  reproduce: read('benchmarks/longmemeval/REPRODUCE.md'),
  changelog: read('CHANGELOG.md'),
  packageJson: JSON.parse(read('package.json')),
  knowledgeGraph: read('src/knowledge-graph.ts'),
  analytics: read('src/core/analytics.ts'),
};

describe('current source-backed documentation contracts', () => {
  it('accepts the synchronized current docs', () => {
    expect(checkCurrentDocumentationContracts(baseline)).toMatchObject({ errors: [], routeCount: 31, webRouteCount: 2, toolCount: 12 });
  });

  it.each([
    ['MCP tool row removal', { architecture: baseline.architecture.replace(/^\| `work_package`.*\n/m, '') }, 'MCP handler table differs'],
    ['MCP tool duplicate', { architecture: baseline.architecture.replace(/^\| `work_package`.*\n/m, (row) => `${row}${row}`) }, 'MCP handler table differs'],
    ['MCP schema mismatch', { architecture: baseline.architecture.replace('| `forget` | ForgetSchema |', '| `forget` | RecallSchema |') }, 'MCP handler table differs'],
    ['removed config symbol', { architecture: baseline.architecture.replace('owner-local configuration reads', 'owner-local configuration reads via logCapabilities') }, 'removed logCapabilities'],
    ['hard-delete forget claim', { architecture: baseline.architecture.replace('KnowledgeGraph.archiveEntity(name)', 'KnowledgeGraph.deleteEntity(name)') }, 'forget section'],
    ['hard-delete forget implementation', { operations: baseline.operations.replace('kg.archiveEntity(args.name)', 'kg.deleteEntity(args.name)') }, 'operations.forget source'],
    ['missing observation forget implementation', { operations: baseline.operations.replace('kg.removeObservation(args.name, args.observation)', 'kg.archiveEntity(args.name)') }, 'operations.forget source'],
    ['missing API observation mode', { apiReference: baseline.apiReference.replace('only this observation is removed', 'the selected data is handled') }, 'API_REFERENCE forget section'],
    ['removed analytics field claim', { architecture: baseline.architecture.replace('citation compliance', 'value metrics and cleanup suggestions') }, 'analytics summary'],
    ['HTTP method/path row removal', { apiReference: baseline.apiReference.replace(/^\| POST \| \/v1\/message.*\n/m, '') }, 'HTTP route table differs'],
    ['HTTP method drift', { apiReference: baseline.apiReference.replace('| POST | /v1/config |', '| GET | /v1/config |') }, 'HTTP route table differs'],
    ['HTTP route duplicate', { apiReference: baseline.apiReference.replace(/^\| POST \| \/v1\/message.*\n/m, (row) => `${row}${row}`) }, 'HTTP route table differs'],
    ['duplicate architecture route count', { architecture: `${baseline.architecture}\n31 \`/v1\` endpoints including two retired 410 routes\n` }, 'exactly once'],
    ['config capabilities return', { apiReference: baseline.apiReference.replace('"config": {', '"capabilities": {},\n    "config": {') }, 'data.config'],
    ['config enum type', { apiReference: baseline.apiReference.replace('"autoUpdate": "minor"', '"autoUpdate": true') }, 'autoUpdate'],
    ['analytics factor type', { apiReference: baseline.apiReference.replace(/"activity": \{ "score": \d+, "weight": \d+, "detail": "[^"\n]+" \}/, '"activity": 50') }, 'healthFactors.activity'],
    ['analytics timeline key', { apiReference: baseline.apiReference.replace('{ "date": "2026-09-01", "created": 5, "recalled": 12 }', '{ "day": "2026-09-01", "created": 5, "recalled": 12 }') }, 'timeline'],
    ['analytics aliased return key', { analytics: baseline.analytics.replace('    knowledgeRadar,', '    knowledgeRadar,\n    extraField: true,') }, 'top-level keys differ'],
    ['nonexistent benchmark symbol', { methodology: baseline.methodology.replaceAll('buildMatchExpression()', 'buildQueryTerms()') }, 'buildMatchExpression'],
    // `#unreleased` is NOT a safe stand-in for a missing heading: CHANGELOG.md carries a `## [Unreleased]` section whenever something is merged but not yet released (CLAUDE.md), and that heading's anchor is exactly `unreleased`.
    ['missing changelog anchor', { methodology: baseline.methodology.replace('#4211--2026-08-03', '#no-such-changelog-heading') }, 'missing CHANGELOG heading'],
    ['collapsed GitHub punctuation anchor', { methodology: baseline.methodology.replace('#4211--2026-08-03', '#4211-2026-08-03') }, 'must link to CHANGELOG.md headings'],
    ['missing methodology anchor', { benchmarkResults: baseline.benchmarkResults.replace('#42-adapter-limitations', '#missing-section') }, 'missing METHODOLOGY heading'],
    ['removed internal methodology link', { methodology: baseline.methodology.replace('[§2.3 below](#23-fts5-query-construction)', '§2.3 below') }, 'METHODOLOGY.md must link'],
    ['removed methodology link', { benchmarkResults: baseline.benchmarkResults.replace('[METHODOLOGY.md §4.2](METHODOLOGY.md#42-adapter-limitations)', 'METHODOLOGY.md §4.2') }, 'RESULTS.md must link'],
    ['removed changelog link', { benchmarkResultsReadme: baseline.benchmarkResultsReadme.replace('[CHANGELOG 4.2.11](../../../CHANGELOG.md#4211--2026-08-03)', 'CHANGELOG 4.2.11') }, 'results/README.md must link'],
  ])('rejects %s', (_label, change, expected) => {
    const result = checkCurrentDocumentationContracts({ ...baseline, ...change });
    expect(result.errors.join('\n')).toContain(expected);
  });

  it('is the contract used by the release gate', () => {
    const gate = read('scripts/check-doc-claims.mjs');
    expect(gate).toContain("import { checkCurrentDocumentationContracts } from './lib/current-doc-contract.mjs'");
    expect(gate).toContain('const currentDocs = checkCurrentDocumentationContracts({');
  });
});
