import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTranscriptDiscoveryContract } from '../scripts/lib/transcript-doc-contract.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(repoRoot, 'src/core/transcript-source.ts'), 'utf8');
const dreamer = fs.readFileSync(path.join(repoRoot, 'src/core/dreamer.ts'), 'utf8');
const schemas = fs.readFileSync(path.join(repoRoot, 'src/transports/schemas.ts'), 'utf8');
const api = fs.readFileSync(path.join(repoRoot, 'docs/api/API_REFERENCE.md'), 'utf8');

describe('work_package transcript discovery documentation contract', () => {
  it('accepts the source-derived positive paragraph in the bounded work_package section', () => {
    expect(checkTranscriptDiscoveryContract(source, dreamer, schemas, api)).toMatchObject({ ok: true });
  });

  it.each([
    ['removed', (text: string) => text.replace('Transcript discovery considers files modified within the last 3 days. ', '')],
    ['negated', (text: string) => text.replace('Transcript discovery considers', 'Transcript discovery does not consider')],
    ['relocated', (text: string) => {
      const paragraph = text.match(/Transcript discovery considers[^\n]+/)?.[0] ?? '';
      return text.replace(paragraph, '').replace('### remember', `### remember\n\n${paragraph}`);
    }],
  ])('rejects a %s public discovery claim', (_label, mutate) => {
    expect(checkTranscriptDiscoveryContract(source, dreamer, schemas, mutate(api))).toMatchObject({ ok: false });
  });

  it('rejects source-value drift until the public paragraph is synchronized', () => {
    const changedSource = source.replace(
      'MAX_TRANSCRIPT_SOURCE_BYTES = 8 * 1024 * 1024',
      'MAX_TRANSCRIPT_SOURCE_BYTES = 9 * 1024 * 1024',
    );
    expect(checkTranscriptDiscoveryContract(changedSource, dreamer, schemas, api)).toMatchObject({ ok: false });
  });

  it.each([
    ['missing-cwd acceptance', source.replace('return sessionCwd !== null && sameProjectPath(sessionCwd, cwd);', 'return sessionCwd === null || sameProjectPath(sessionCwd, cwd);'), dreamer],
    ['mismatched-cwd acceptance', source.replace('if (!transcriptMatchesProject(buf, cwd)) continue;', 'if (transcriptMatchesProject(buf, cwd)) continue;'), dreamer],
    ['pinned digest acceptance', source, dreamer.replace('if (pinned || compacted) continue;', 'if (!pinned || compacted) continue;')],
  ])('rejects %s source semantics that contradict the public contract', (_label, changedSource, changedDreamer) => {
    expect(checkTranscriptDiscoveryContract(changedSource, changedDreamer, schemas, api)).toMatchObject({ ok: false });
  });

  it.each([
    ['turn count', dreamer.replace('TRANSCRIPT_PACKAGE_MAX_TURNS = 100', 'TRANSCRIPT_PACKAGE_MAX_TURNS = 99'), schemas],
    ['source bytes', dreamer.replace('TRANSCRIPT_PACKAGE_SOURCE_BYTES = 48 * 1024', 'TRANSCRIPT_PACKAGE_SOURCE_BYTES = 47 * 1024'), schemas],
    ['package bytes', dreamer.replace('WORK_PACKAGE_MAX_BYTES = 64 * 1024', 'WORK_PACKAGE_MAX_BYTES = 63 * 1024'), schemas],
    ['result bytes', dreamer, schemas.replace('WORK_PACKAGE_RESULT_MAX_BYTES = 16 * 1024', 'WORK_PACKAGE_RESULT_MAX_BYTES = 15 * 1024')],
    ['digest maximum', dreamer.replace('COMPACT_MAX_CLUSTER_SIZE = 100', 'COMPACT_MAX_CLUSTER_SIZE = 99'), schemas],
    ['digest entity types', dreamer.replace("  'session_keypoint',\n", ''), schemas],
  ])('rejects %s drift until the public contract is synchronized', (_label, changedDreamer, changedSchemas) => {
    expect(checkTranscriptDiscoveryContract(source, changedDreamer, changedSchemas, api)).toMatchObject({ ok: false });
  });

  it('is the predicate used by the release gate rather than a parallel test-only copy', () => {
    const gate = fs.readFileSync(path.join(repoRoot, 'scripts/check-doc-claims.mjs'), 'utf8');
    expect(gate).toContain("import { checkTranscriptDiscoveryContract } from './lib/transcript-doc-contract.mjs'");
    expect(gate).toMatch(/checkTranscriptDiscoveryContract\(\s*read\('src\/core\/transcript-source\.ts'\),\s*read\('src\/core\/dreamer\.ts'\),\s*read\('src\/transports\/schemas\.ts'\),\s*read\('docs\/api\/API_REFERENCE\.md'\)/);
  });
});
