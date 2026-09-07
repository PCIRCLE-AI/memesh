import { markdownSection } from './markdown-section.mjs';

function extract(pattern, source) {
  return source.match(pattern)?.[1];
}

/**
 * Compare the public work_package discovery paragraph with the implementation
 * constants it restates. The full positive paragraph is required inside the
 * work_package section; loose tokens or a claim moved elsewhere do not pass.
 */
export function checkTranscriptDiscoveryContract(source, dreamer, schemas, apiReference) {
  const compactableBlock = dreamer.match(/const COMPACTABLE_TYPES = new Set\(\[([\s\S]*?)\]\);/)?.[1];
  const bounds = {
    sourceMiB: extract(/MAX_TRANSCRIPT_SOURCE_BYTES = (\d+) \* 1024 \* 1024/, source),
    scanMiB: extract(/MAX_TRANSCRIPT_SCAN_BYTES = (\d+) \* 1024 \* 1024/, source),
    candidates: extract(/MAX_TRANSCRIPT_CANDIDATES = (\d+)/, source),
    windowDays: extract(/windowDays = opts\.windowDays \?\? (\d+)/, source),
    maxTurns: extract(/TRANSCRIPT_PACKAGE_MAX_TURNS = (\d+)/, dreamer),
    sourceKiB: extract(/TRANSCRIPT_PACKAGE_SOURCE_BYTES = (\d+) \* 1024/, dreamer),
    packageKiB: extract(/WORK_PACKAGE_MAX_BYTES = (\d+) \* 1024/, dreamer),
    resultKiB: extract(/WORK_PACKAGE_RESULT_MAX_BYTES = (\d+) \* 1024/, schemas),
    digestWindowWeeks: extract(/const windowDays = COMPACT_TIME_WINDOW_DAYS \* (\d+)/, dreamer),
    digestWindowDays: extract(/COMPACT_TIME_WINDOW_DAYS = (\d+)/, dreamer),
    digestMin: extract(/COMPACT_MIN_CLUSTER_SIZE = (\d+)/, dreamer),
    digestMax: extract(/COMPACT_MAX_CLUSTER_SIZE = (\d+)/, dreamer),
    signalMin: extract(/COMPACT_MIN_SIGNAL = ([0-9.]+)/, dreamer),
    signalMax: extract(/COMPACT_MAX_SIGNAL = ([0-9.]+)/, dreamer),
    compactableTypes: compactableBlock
      ? [...compactableBlock.matchAll(/'([^']+)'/g)].map((match) => match[1])
      : undefined,
  };
  if (Object.values(bounds).some((value) => value === undefined)) {
    return { ok: false, bounds, error: 'transcript discovery bound extraction stopped matching transcript-source.ts' };
  }
  if (!/return sessionCwd !== null && sameProjectPath\(sessionCwd, cwd\);/.test(source)
    || !/if \(!transcriptMatchesProject\(buf, cwd\)\) continue;/.test(source)) {
    return { ok: false, bounds, error: 'transcript discovery source no longer rejects missing or mismatched recorded cwd' };
  }
  if (!/if \(pinned \|\| compacted\) continue;/.test(dreamer)
    || !/if \(depth >= 1\) continue;/.test(dreamer)
    || !/if \(signal < COMPACT_MIN_SIGNAL \|\| signal > COMPACT_MAX_SIGNAL\) continue;/.test(dreamer)
    || !/if \(!tags\.includes\(`project:\$\{project\}`\)\) continue;/.test(dreamer)) {
    return { ok: false, bounds, error: 'digest discovery source no longer enforces documented project, pin, compaction, and signal exclusions' };
  }

  const section = markdownSection(apiReference, 'work_package');
  if (section === null) {
    return { ok: false, bounds, error: 'API_REFERENCE.md has no `### work_package` section' };
  }
  const paragraph = [
    `Transcript discovery considers files modified within the last ${bounds.windowDays} days.`,
    `It refuses a directory with more than ${bounds.candidates} transcript candidates, skips any individual source larger than ${bounds.sourceMiB} MiB, and returns \`none_available\` when eligible scan input exceeds ${bounds.scanMiB} MiB.`,
    'A transcript without a recorded cwd, or whose cwd does not match the selected workspace, is ineligible.',
  ].join(' ');
  if (!section.includes(paragraph)) {
    return {
      ok: false,
      bounds,
      error: 'API_REFERENCE work_package transcript discovery paragraph drifted from source or moved outside its section',
    };
  }
  const packageParagraph = `From the selected transcript, the package retains at most the ${bounds.maxTurns} most recent visible turns in chronological order and at most ${bounds.sourceKiB} KiB of serialized source turns. The complete returned package is capped at ${bounds.packageKiB} KiB; the submitted result has its separate ${bounds.resultKiB} KiB cap.`;
  if (!section.includes(packageParagraph)) {
    return { ok: false, bounds, error: 'API_REFERENCE work_package package-size paragraph drifted from dreamer/schema source' };
  }
  const digestDays = Number(bounds.digestWindowDays) * Number(bounds.digestWindowWeeks);
  const typeList = bounds.compactableTypes.map((type) => `\`${type}\``).join(', ');
  const digestParagraph = `Digest discovery considers the last ${digestDays} days of active, same-project evidence with these exact entity types: ${typeList}. It excludes pinned or already-compacted rows, consolidation depth 1 or greater, and signal scores outside ${bounds.signalMin}–${bounds.signalMax}. Candidates are grouped by ISO week; only complete groups of ${bounds.digestMin}–${bounds.digestMax} sources whose returned package fits ${bounds.packageKiB} KiB are eligible.`;
  if (!section.includes(digestParagraph)) {
    return { ok: false, bounds, error: 'API_REFERENCE work_package digest eligibility paragraph drifted from dreamer source' };
  }
  return { ok: true, bounds };
}
