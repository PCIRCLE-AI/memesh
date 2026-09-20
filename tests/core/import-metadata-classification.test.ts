/**
 * #359 round 4: the guard against round 5. Three rounds in a row, an
 * independent review found ONE MORE metadata key that carried authority and
 * was not on the deny-list (`guard` -> `demo` -> `task_state`/`pin`/
 * `signal_score`/`consolidation_depth`/`compacted_into`/`proposal_id`/
 * `session_id`). `buildImportedMetadata` is now an ALLOW-list
 * (`IMPORTABLE_METADATA_KEYS`) precisely so the failure mode flips: an
 * unclassified key is refused by default, not admitted by default.
 *
 * This file is what keeps the classification itself honest. It scrapes the
 * real source for every place a metadata key is READ BACK to change
 * behaviour, or WRITTEN into an entity's metadata, and fails if any key it
 * finds is not named in EITHER `IMPORTABLE_METADATA_KEYS` (safe to import) or
 * `AUTHORITY_METADATA_KEYS` (must never be granted by a bundle without an
 * explicit, reviewed exception). A key can be unclassified by being in
 * NEITHER set — that is the round-5 failure this file exists to catch.
 *
 * ROUND 6 (independent review): the denominator used to be a hand-written
 * 17-file list, already stale by three files
 * (`src/core/work-topology.ts`, `src/core/note-ingest.ts`,
 * `src/core/delegation.ts` were missing), and the detection patterns only
 * covered `.foo` property reads and one `json_extract` shape. Both are
 * replaced:
 *
 * - The FILE LIST is gone. The scan now WALKS `src/**\/*.ts` and
 *   `scripts/hooks/**\/*.js` itself (excluding `_generated`, anything with
 *   `.test.` in its name, and `.d.ts` files) — a file cannot silently drop
 *   out of the denominator by not being remembered.
 * - The PATTERNS widened from "one" to five: `metadata.foo`/`meta.foo`
 *   property reads, bracket access with a string literal
 *   (`metadata['foo']`), destructuring from a `metadata`/`meta` identifier
 *   (`const { foo } = metadata`), `json_extract(metadata, '$.foo')`, and —
 *   new — WRITE-SIDE object-literal keys assigned into metadata (a
 *   `metadata: { foo: ... }` property, `const metadata = { foo: ... }`, or
 *   an `updateEntityMetadata(name, (x) => ({ foo: ... }))` callback that
 *   returns a paren-wrapped object literal). This last pattern is what
 *   found the actual round-6 gap: `namespace_moved_at`
 *   (knowledge-graph.ts:429, an `updateEntityMetadata` arrow callback) was
 *   missing from `IMPORTABLE_METADATA_KEYS` for five rounds because nothing
 *   ever scraped a WRITE site, only reads — and a key that is written but
 *   never read back with a literal `.foo` still has to be classified,
 *   because a bundle CAN supply it even though the app itself does not
 *   read it conditionally. The same pattern also surfaced seven real,
 *   previously-invisible keys in the product-improvement `dream accept`
 *   path (dreamer.ts ~476-492) — see `src/core/serializer.ts` for the
 *   evidence each one was independently verified against (zero conditional
 *   readers) before being added to `IMPORTABLE_METADATA_KEYS`.
 *
 * WHAT THIS SCAN CANNOT SEE (stated once, honestly, so no comment above or
 * below this one gets read as an "every key" claim):
 *
 * - It is REGEX-based, not a parser. It does not skip `//` or `/* *\/`
 *   comments or string contents for the simple READ patterns (`prop`,
 *   `bracket`, `destructure`, `sql`) — a literal `metadata.foo` inside a
 *   comment or a string is indistinguishable to those four patterns from
 *   real code. This can only produce FALSE POSITIVES (a name that needs
 *   excluding with a reason, see `SCRAPE_NOISE` below), never a false
 *   negative on that axis.
 * - The write-side scan follows exactly TWO shapes: a literal
 *   `metadata`/`meta` binding assigned an object literal, and an
 *   `updateEntityMetadata(<name-arg>, (PARAM) => (OBJECT_LITERAL))`
 *   callback — the PAREN-WRAPPED arrow-body idiom specifically. A
 *   BLOCK-bodied callback (`(current) => { ...; return {...}; }`) is NOT
 *   parsed for its `return` statement or for property-assignment mutations
 *   (`next.foo = ...`) — every block-bodied `updateEntityMetadata` callback
 *   in the tree at the time this test was written was read BY HAND instead
 *   (`operations.ts:333`, `operations.ts:575`, `knowledge-graph.ts:577`; all
 *   three only reference keys already classified below — `replaced_history`,
 *   `pin`, `forgotten_observation_hashes`). A FUTURE block-bodied callback
 *   introducing a genuinely new key would not be caught by this file.
 * - It cannot see a key assembled from a runtime string (`metadata[dynamicVar]`)
 *   or spread from an unrelated object under the name `metadata`/`meta` by
 *   coincidence.
 *
 * None of this is a reason to trust the scan less than it is trusted: it is
 * a floor (every key it names as unclassified genuinely needs a decision),
 * not a ceiling (a key it does not find might still exist). The anti-vacuity
 * test below proves the floor is not empty; the break-test in the round-6
 * report proved a newly-introduced key the scan CAN see is caught.
 *
 * ROUND 7 (independent review): two bypasses, both reproduced with a scratch
 * file and both closed.
 *
 * 1. `dashboard/src` was NOT in the walk at all, even though dashboard code
 *    reads entity metadata for display (`dashboard/src/components/
 *    ProjectRoadmap.tsx` reads `signal_score` off an entity's metadata to
 *    filter the roadmap view). A scratch
 *    `dashboard/src/zz-probe.ts` containing a literal `metadata.probe_key`
 *    stayed invisible — the scan cannot fail on a key it never looked for.
 *    `dashboard/src/**\/*.{ts,tsx}` is now in the walk (`sourceFiles()`
 *    below), on the same exclusion rules as `src/`. Re-scanning the EXISTING
 *    tree with the directory added found no NEW key: `demo` gained one more
 *    location (`dashboard/src/lib/i18n.ts`, inside translated help-copy
 *    strings like "Removes everything tagged metadata.demo") but `demo` was
 *    already classified AUTHORITY, so nothing changed there. Two REAL
 *    dashboard reads remain outside what even the widened patterns can see
 *    — documented here rather than silently trusted: `ProjectRoadmap.tsx`'s
 *    own `signal_score` read is `(e.metadata as Record<string, unknown> |
 *    undefined)?.signal_score` (a type-cast breaks the direct
 *    `metadata.KEY` adjacency `propPattern` requires), and
 *    `InsightsTab.tsx` reads a DESTRUCTURED, RENAMED local (`g.guard?.tool`,
 *    where `g` came from `.map((p) => ({...p, guard: JSON.parse(...)}))`)
 *    — a base identifier that is no longer literally `metadata`/`meta` at
 *    the read site at all. Both reference keys (`signal_score`, `guard`)
 *    that are ALREADY classified, verified by hand, so neither is a live
 *    gap today — but a FUTURE new key read the same two ways would not be
 *    caught by this file, on top of the block-bodied-callback and
 *    dynamic-key blind spots already named above.
 *
 * 2. `SCRAPE_NOISE` used to suppress a key GLOBALLY by name — `type` hid
 *    EVERY `metadata.type` hit anywhere in the tree, not just the two
 *    specific comment/CLI-help locations that motivated the entry. A
 *    scratch file with a REAL conditional branch on `metadata.type`
 *    stayed invisible for exactly that reason. Noise suppression is now
 *    scoped to a `(key, file)` PAIR, not a bare key name: `SCRAPE_NOISE` is
 *    an array of `{key, file, reason}`, and the classification check only
 *    drops a hit that matches BOTH the key and the exact file it was found
 *    in — the same key found in any OTHER file still has to be classified,
 *    or the check fails on it by name.
 *
 * Both round-7 bypasses above, and the round-8 digit-identifier bypass, were
 * originally proven with a scratch file written directly into the real
 * repository tree (by hand in round 7; as a permanent-but-unsafe test in
 * round 8 — see the round-9 note on the describe block below for why that
 * was itself a defect). All three now have PERMANENT regression coverage
 * that never touches the real tree — see "round 9: temp-root regression
 * tests" at the bottom of this file.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMPORTABLE_METADATA_KEYS, AUTHORITY_METADATA_KEYS } from '../../src/core/serializer.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Walks `dir` for files ending in one of `exts`, skipping `_generated`,
 *  `node_modules`, `.d.ts` files and anything with `.test.` in its name.
 *  Tolerates a MISSING directory (returns `[]`) — a temp-root regression
 *  test (round 9, see below) only creates the subtrees it needs, and a
 *  walk that required all three to exist would force every such test to
 *  build directories it has no use for. */
function walkSourceFiles(dir: string, exts: string[], out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '_generated' || entry.name === 'node_modules') continue;
      walkSourceFiles(abs, exts, out);
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      if (entry.name.endsWith('.d.ts')) continue;
      if (entry.name.includes('.test.')) continue;
      out.push(abs);
    }
  }
  return out;
}

/**
 * Round 9 (independent review): `root` is now an injectable parameter,
 * defaulting to the real repository root — every EXISTING call site in this
 * file (the "real" classification tests below) keeps scanning the actual
 * tree unchanged. What changes is that a TEST can now point this at a
 * throwaway directory instead, which is the whole fix for the finding this
 * round closes: the round-8 permanent digit-key test wrote and deleted a
 * FIXED path inside the real repository (`src/core/zz-round8-...ts`) —
 * `writeFileSync` truncates whatever was already there, and a killed run,
 * or a second process touching the same path, could leave a maintainer's
 * real file overwritten or gone. Reproduced for real (round-9 report): a
 * pre-existing file at that exact path was silently replaced and then
 * deleted by a passing test run. No test in this file may create, truncate
 * or delete anything inside the repository ever again — every temp-root
 * test below builds its fixture under `mkdtempSync`, outside the repo, and
 * is guarded against `root` ever resolving inside `repoRoot`.
 */
function sourceFiles(root: string = repoRoot): string[] {
  return [
    ...walkSourceFiles(path.join(root, 'src'), ['.ts']),
    ...walkSourceFiles(path.join(root, 'scripts/hooks'), ['.js']),
    // Round 7: dashboard code reads entity metadata for display too (the
    // roadmap view filters on `signal_score`) — a dashboard-only authority
    // key would previously never have been scraped at all.
    ...walkSourceFiles(path.join(root, 'dashboard/src'), ['.ts', '.tsx']),
  ];
}

/**
 * Known non-behavioural noise the regex-based scan cannot itself
 * distinguish from a real hit — each verified BY HAND and given a one-line
 * reason, per the round-6 review requirement that no key stay excluded
 * without one. Round 7: scoped to the EXACT `(key, file)` pair, not the bare
 * key name — see the round-7 header note for why a global-by-name exclusion
 * is a bypass (it hid a real conditional branch planted in a different file
 * under the same key name during that round's red/green fixture).
 */
const SCRAPE_NOISE: ReadonlyArray<{ key: string; file: string; reason: string }> = [
  {
    key: 'style',
    file: 'src/cli/view-live.ts',
    reason: "`meta` there is a DOM element local variable (`meta.style.cssText = ...`), not an entity's metadata.",
  },
  {
    key: 'textContent',
    file: 'src/cli/view-live.ts',
    reason: 'the same DOM element variable (`meta.textContent = ...`).',
  },
  {
    key: 'type',
    file: 'src/core/note-ingest.ts',
    reason: "matches only inside a comment (note-ingest.ts:8) describing a note FILE's own YAML frontmatter `type` field — never a real `metadata.type`/`meta.type` code access.",
  },
  {
    key: 'type',
    file: 'src/transports/cli/cli.ts',
    reason: "matches only inside a CLI `--help` string (~line 680) describing the SAME note-file frontmatter `type` field named above — never a real code access.",
  },
];

/** True when `(key, file)` matches a documented false positive — the ONLY
 *  thing that may suppress a hit; every other occurrence of `key`, in any
 *  OTHER file, must still be classified. */
function isDocumentedNoise(key: string, file: string): boolean {
  return SCRAPE_NOISE.some((n) => n.key === key && n.file === file);
}

/** Comment- and string-aware matching-delimiter finder: given the index of
 *  an opening `{`, `(` or `[`, returns the index of the delimiter that
 *  closes it (tracking depth across all three bracket kinds together, which
 *  is sufficient for well-formed source), or -1. Skips `//` and `/* *\/`
 *  comments and string/template literal contents so an apostrophe in an
 *  English comment ("it's", "doesn't" — this file's own siblings are full of
 *  them) cannot be misread as opening a string that swallows real
 *  delimiters — confirmed as a real failure mode during development: a
 *  version of this scanner without comment-awareness silently mismatched a
 *  metadata object literal's closing brace by 275 lines.
 */
function findMatchingDelimiter(src: string, openIdx: number): number {
  let depth = 0;
  let inStr: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    const c2 = src[i + 1];
    if (inLineComment) {
      if (c === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && c2 === '/') { inBlockComment = false; i++; }
      continue;
    }
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '/' && c2 === '/') { inLineComment = true; i++; continue; }
    if (c === '/' && c2 === '*') { inBlockComment = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Splits `inner` on top-level commas (not descending into nested
 *  brackets/strings/comments). */
function splitTopLevel(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inStr: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  let buf = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    const c2 = inner[i + 1];
    if (inLineComment) {
      if (c === '\n') { inLineComment = false; buf += c; }
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && c2 === '/') { inBlockComment = false; i++; }
      continue;
    }
    if (inStr) {
      buf += c;
      if (c === '\\') { buf += inner[++i] ?? ''; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '/' && c2 === '/') { inLineComment = true; i++; continue; }
    if (c === '/' && c2 === '*') { inBlockComment = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; buf += c; continue; }
    if ('{(['.includes(c)) { depth++; buf += c; continue; }
    if ('})]'.includes(c)) { depth--; buf += c; continue; }
    if (c === ',' && depth === 0) { parts.push(buf); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim()) parts.push(buf);
  return parts;
}

/** Extracts identifier names from a destructuring pattern's inner text
 *  (`foo, bar: renamed, ...rest` -> `['foo', 'bar']`). */
function extractDestructuredNames(inner: string): string[] {
  const names: string[] = [];
  for (const part of inner.split(',')) {
    const p = part.trim();
    if (!p || p.startsWith('...')) continue;
    const m = p.match(/^([A-Za-z_$][\w$]*)/);
    if (m) names.push(m[1]);
  }
  return names;
}

/** Extracts top-level object-literal key names, handling both `key: value`
 *  and ES6 shorthand `key` (no colon), and stripping `//` comments first so
 *  a commented-out property does not count as a real key. */
function extractObjectLiteralKeys(inner: string): string[] {
  const names: string[] = [];
  for (const part of splitTopLevel(inner)) {
    const p = part.trim();
    if (!p || p.startsWith('...')) continue;
    const m = p.match(/^['"]?([A-Za-z_$][\w$]*)['"]?\s*(:|$)/);
    if (m) names.push(m[1]);
  }
  return names;
}

// #359 round 8 (independent review): `sqlPattern` and `propPattern` used
// `[a-zA-Z_]+` — no digits at all — while every OTHER pattern in this file
// already used `[a-zA-Z_][a-zA-Z0-9_]*`. A real property like
// `metadata.key2` or `metadata.v2_flag` silently failed to match (JS
// identifiers allow digits after the first character; `[a-zA-Z_]+` simply
// cannot represent that). A scratch probe with `metadata.dashboard_only_round7`
// stayed invisible while the identical key spelled without the trailing
// digit was caught — reproduced, then fixed here. Every identifier-matching
// pattern in this file now uses the SAME character class,
// `[A-Za-z_$][\w$]*` (a legal JS identifier start, then any run of legal JS
// identifier characters — `\w` is `[A-Za-z0-9_]`, `$` is added separately
// since it is valid in a JS identifier but not part of `\w`), so a future
// drift between two patterns cannot reintroduce this gap in one of them
// while leaving the others fixed.
const sqlPattern = /json_extract\([^,]*metadata,\s*'\$\.([A-Za-z_$][\w$]*)'/g;
// Negative lookbehind excludes `import.meta.url`/`import.meta.env` — the ESM
// builtin, not entity metadata.
const propPattern = /(?<!import\.)\b(?:metadata|meta)\??\.([A-Za-z_$][\w$]*)\b/g;
const bracketPattern = /(?<!import\.)\b(?:metadata|meta)\??\[['"]([A-Za-z_$][\w$]*)['"]\]/g;
const destructurePattern = /\{\s*([^}]*)\}\s*=\s*(?:existingMetadata|metadata|meta)\b(?!\w)/g;
// Direct object-literal write: `metadata: { ... }` or `const/let/var
// metadata|meta = { ... }`.
const directWriteSiteStart = /\b(?:metadata\s*:|(?:const|let|var)\s+(?:metadata|meta)\s*=)\s*\{/g;
// The `updateEntityMetadata(name, (PARAM) => ({ ... }))` idiom — scoped
// tightly to this ONE function name so it cannot match the same
// paren-wrapped-arrow shape anywhere else in the tree (a very common idiom
// for unrelated data, e.g. `.map((x) => ({ id: x.id }))`).
const updateEntityMetadataCallPattern = /\bupdateEntityMetadata\(/g;
// Non-global, freshly matched against each call's own `argsText` below — a
// global regex reused across iterations would need its `lastIndex` reset by
// hand every time, which is exactly the kind of state a scanner like this
// should not carry between unrelated call sites.
const PAREN_ARROW_OBJECT_RE = /\([A-Za-z_$][\w$]*\)\s*=>\s*\(\s*\{/;

function scrapeMetadataKeys(root: string = repoRoot): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  function add(key: string, rel: string) {
    if (!found.has(key)) found.set(key, new Set());
    found.get(key)!.add(rel);
  }

  for (const abs of sourceFiles(root)) {
    const rel = path.relative(root, abs);
    const src = fs.readFileSync(abs, 'utf8');

    for (const m of src.matchAll(sqlPattern)) add(m[1], rel);
    for (const m of src.matchAll(propPattern)) add(m[1], rel);
    for (const m of src.matchAll(bracketPattern)) add(m[1], rel);
    for (const m of src.matchAll(destructurePattern)) {
      for (const name of extractDestructuredNames(m[1])) add(name, rel);
    }
    for (const m of src.matchAll(directWriteSiteStart)) {
      const openIdx = m.index! + m[0].length - 1;
      const closeIdx = findMatchingDelimiter(src, openIdx);
      if (closeIdx === -1) continue;
      const inner = src.slice(openIdx + 1, closeIdx);
      for (const name of extractObjectLiteralKeys(inner)) add(name, rel);
    }
    for (const callMatch of src.matchAll(updateEntityMetadataCallPattern)) {
      const callOpenIdx = callMatch.index! + callMatch[0].length - 1;
      const callCloseIdx = findMatchingDelimiter(src, callOpenIdx);
      if (callCloseIdx === -1) continue;
      const argsText = src.slice(callOpenIdx + 1, callCloseIdx);
      const arrowMatch = PAREN_ARROW_OBJECT_RE.exec(argsText);
      if (!arrowMatch) continue;
      const objOpenIdx = callOpenIdx + 1 + arrowMatch.index + arrowMatch[0].length - 1;
      const objCloseIdx = findMatchingDelimiter(src, objOpenIdx);
      if (objCloseIdx === -1) continue;
      const inner = src.slice(objOpenIdx + 1, objCloseIdx);
      for (const name of extractObjectLiteralKeys(inner)) add(name, rel);
    }
  }
  return found;
}

describe('import metadata classification — every behaviour-reading or metadata-writing key must be classified', () => {
  it('the scrape is not vacuous — it finds the keys this suite already knows are classified', () => {
    const found = scrapeMetadataKeys();
    // Anti-vacuity: a regex that silently matched nothing would make every
    // assertion below pass on an empty set. Prove it actually works first —
    // one key from each detection pattern, including the round-6 additions.
    for (const mustFind of [
      'guard', 'demo', 'task_state', 'pin', 'signal_score', // prop
      'split_from', // sql
      'forgotten_observation_hashes', 'proposal_id', 'consolidation_depth',
      'compacted_into', 'session_id', 'trust', 'provenance',
      'namespace_moved_at', // updateEntityMetadata paren-arrow write (round 6)
      'accepted_at', 'priority', // direct object-literal write (round 6)
    ]) {
      expect(found.has(mustFind), `scrape did not find "${mustFind}" — a pattern may have broken`).toBe(true);
    }
  });

  it('round 7: the walk actually reaches dashboard/src — not just src/ and scripts/hooks/', () => {
    const found = scrapeMetadataKeys();
    // `demo` appears inside dashboard/src/lib/i18n.ts's translated help copy
    // ("Removes everything tagged metadata.demo") — a real file, a real hit,
    // proof the directory is genuinely walked, not just named in a comment.
    const demoFiles = found.get('demo');
    expect(demoFiles?.has('dashboard/src/lib/i18n.ts'), 'the dashboard/src walk is not reaching its files').toBe(true);
  });

  it('every scraped key is classified as IMPORTABLE, AUTHORITY, or documented (key, file)-scoped scan noise — none fall through', () => {
    const found = scrapeMetadataKeys();
    // Round 7: a key already in one of the two real Sets is fully resolved
    // regardless of noise — noise-matching only matters for a key that is in
    // NEITHER Set, where it decides whether a given occurrence explains
    // itself away or leaves the key unclassified.
    const unclassified: Array<{ key: string; files: string[] }> = [];
    for (const [key, files] of found) {
      if (IMPORTABLE_METADATA_KEYS.has(key) || AUTHORITY_METADATA_KEYS.has(key)) continue;
      const uncoveredFiles = [...files].filter((file) => !isDocumentedNoise(key, file));
      if (uncoveredFiles.length > 0) unclassified.push({ key, files: uncoveredFiles });
    }
    expect(
      unclassified,
      `unclassified metadata key(s) found by source scrape: ${unclassified.map((u) => `${u.key} (${u.files.join(', ')})`).join('; ')} — ` +
        'add each to IMPORTABLE_METADATA_KEYS (if purely descriptive) or AUTHORITY_METADATA_KEYS ' +
        '(if it changes behaviour) in src/core/serializer.ts, with the read/write site that justifies the ' +
        'choice — or, if it is scan noise (not a real entity-metadata key at all) at THIS SPECIFIC location, ' +
        'add a {key, file, reason} entry to SCRAPE_NOISE above naming the false-positive source. A key found ' +
        'in a file NOT listed in SCRAPE_NOISE for that key is never suppressed by an entry for a DIFFERENT file.',
    ).toEqual([]);
  });

  it('every SCRAPE_NOISE (key, file) pair is still actually found there by the scan (a stale exclusion hides nothing real)', () => {
    const found = scrapeMetadataKeys();
    for (const { key, file } of SCRAPE_NOISE) {
      const files = found.get(key);
      expect(
        files?.has(file),
        `SCRAPE_NOISE has {key: "${key}", file: "${file}"} but the scan no longer finds "${key}" there — remove the stale entry`,
      ).toBe(true);
    }
  });

  it('the two sets do not overlap — a key is descriptive or authority, never both', () => {
    const overlap = [...IMPORTABLE_METADATA_KEYS].filter((k) => AUTHORITY_METADATA_KEYS.has(k));
    expect(overlap).toEqual([]);
  });

  it('no SCRAPE_NOISE key is also classified — noise and a real classified key must never be the same name', () => {
    const collisions = SCRAPE_NOISE.filter(
      ({ key }) => IMPORTABLE_METADATA_KEYS.has(key) || AUTHORITY_METADATA_KEYS.has(key),
    );
    expect(collisions).toEqual([]);
  });
});

/**
 * Round 9 (independent review): every break-test below used to write into
 * the REAL repository tree, ephemerally by hand (rounds 7-8) and then, once
 * made permanent (round 8), as a FIXED path — `src/core/
 * zz-round8-digit-identifier-probe.ts` — that `writeFileSync` (truncates)
 * and `finally { unlinkSync(...) }` treated as exclusively owned. Codex
 * reproduced the failure mode directly: `touch` a file at that exact path
 * first, run the suite, and the pre-existing file was silently overwritten
 * and then deleted by a PASSING test run — the identical defect class that
 * destroyed a maintainer's real file in this repository the night before
 * this round started. No test in this describe block writes inside
 * `repoRoot` at all: each one builds its fixture under a fresh
 * `mkdtempSync(os.tmpdir())` directory, points the (now-injectable)
 * `scrapeMetadataKeys(root)` at THAT, and removes the temp directory
 * afterward — never the real tree, so a killed run or a concurrent process
 * can at worst leave an orphaned `/tmp` directory, never touch anything a
 * maintainer owns.
 */
describe('import metadata classification — round 9: temp-root regression tests (never touch the real repository tree)', () => {
  /** Creates a fresh temp directory, lets `build` populate it, runs `check`
   *  against it via the injectable-root scanner, then removes it — always,
   *  pass or fail. Guards that `mkdtemp` did not somehow hand back a path
   *  INSIDE the repository (which would defeat the entire point of this
   *  describe block if it ever happened). */
  function withTempRoot(build: (root: string) => void, check: (root: string) => void): void {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-classification-probe-'));
    const resolvedRoot = fs.realpathSync(root);
    const resolvedRepoRoot = fs.realpathSync(repoRoot);
    try {
      expect(
        resolvedRoot === resolvedRepoRoot || resolvedRoot.startsWith(resolvedRepoRoot + path.sep),
        `mkdtemp returned a path INSIDE the repository (${resolvedRoot}) — refusing to build or scan anything there`,
      ).toBe(false);
      build(root);
      check(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  it('a digit-bearing property name (metadata.key2) under a temp src/core/ is found — the round-8 regression, now safe', () => {
    withTempRoot(
      (root) => {
        fs.mkdirSync(path.join(root, 'src/core'), { recursive: true });
        fs.writeFileSync(
          path.join(root, 'src/core/probe.ts'),
          "export function probe(entity: { metadata?: Record<string, unknown> }) {\n" +
          "  return entity.metadata?.key2;\n" +
          "}\n",
        );
      },
      (root) => {
        const found = scrapeMetadataKeys(root);
        expect(found.has('key2'), 'a digit-bearing property name was not found by the scan').toBe(true);
      },
    );
  });

  it('a dashboard-only key under a temp dashboard/src/ is found — the round-7 regression, now safe', () => {
    withTempRoot(
      (root) => {
        fs.mkdirSync(path.join(root, 'dashboard/src'), { recursive: true });
        fs.writeFileSync(
          path.join(root, 'dashboard/src/probe.tsx'),
          "export function Probe(entity: { metadata?: Record<string, unknown> }) {\n" +
          "  return entity.metadata?.dashboard_only_key;\n" +
          "}\n",
        );
      },
      (root) => {
        const found = scrapeMetadataKeys(root);
        expect(found.has('dashboard_only_key'), 'a dashboard/src-only key was not found by the scan').toBe(true);
      },
    );
  });

  it('a real metadata.type branch at a NEW location is found and is NOT silently suppressed by the (key, file)-scoped noise list — the other round-7 regression, now safe', () => {
    withTempRoot(
      (root) => {
        fs.mkdirSync(path.join(root, 'src/core'), { recursive: true });
        fs.writeFileSync(
          path.join(root, 'src/core/probe.ts'),
          "export function probe(entity: { metadata?: Record<string, unknown> }) {\n" +
          "  if (entity.metadata?.type === 'hostile') return true;\n" +
          "  return false;\n" +
          "}\n",
        );
      },
      (root) => {
        const found = scrapeMetadataKeys(root);
        const files = found.get('type');
        expect(files?.has('src/core/probe.ts'), 'a real metadata.type conditional at a new location was not found').toBe(true);
        // The two REAL `SCRAPE_NOISE` entries for `type` name specific REPO
        // paths (`src/core/note-ingest.ts`, `src/transports/cli/cli.ts`).
        // This temp file's path is neither — proving the noise check is
        // scoped to the EXACT file, not the bare key name.
        expect(
          isDocumentedNoise('type', 'src/core/probe.ts'),
          'a brand-new location was wrongly treated as already-documented noise',
        ).toBe(false);
      },
    );
  });

  it('mirrors all three walked roots (src/, scripts/hooks/, dashboard/src/) under one temp tree in a single pass', () => {
    withTempRoot(
      (root) => {
        fs.mkdirSync(path.join(root, 'src/core'), { recursive: true });
        fs.mkdirSync(path.join(root, 'scripts/hooks'), { recursive: true });
        fs.mkdirSync(path.join(root, 'dashboard/src'), { recursive: true });
        fs.writeFileSync(path.join(root, 'src/core/x.ts'), "export const a = (e) => e.metadata?.probe_src_root;\n");
        fs.writeFileSync(path.join(root, 'scripts/hooks/y.js'), "module.exports = (e) => e.metadata?.probe_hooks_root;\n");
        fs.writeFileSync(path.join(root, 'dashboard/src/z.tsx'), "export const c = (e) => e.metadata?.probe_dashboard_root;\n");
      },
      (root) => {
        const found = scrapeMetadataKeys(root);
        expect(found.has('probe_src_root'), 'src/ was not walked under the temp root').toBe(true);
        expect(found.has('probe_hooks_root'), 'scripts/hooks/ was not walked under the temp root').toBe(true);
        expect(found.has('probe_dashboard_root'), 'dashboard/src/ was not walked under the temp root').toBe(true);
      },
    );
  });

  it('a missing subtree under the temp root does not throw — sourceFiles tolerates a partial fixture', () => {
    withTempRoot(
      (root) => {
        fs.mkdirSync(path.join(root, 'src/core'), { recursive: true });
        fs.writeFileSync(path.join(root, 'src/core/x.ts'), "export const a = (e) => e.metadata?.probe_partial;\n");
        // Deliberately no `scripts/hooks/` or `dashboard/src/` under this root.
      },
      (root) => {
        const found = scrapeMetadataKeys(root);
        expect(found.has('probe_partial')).toBe(true);
      },
    );
  });
});
