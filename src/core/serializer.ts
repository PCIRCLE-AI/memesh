// =============================================================================
// Serializer — export/import memory snapshots
// Extracted from operations.ts for single-responsibility
// =============================================================================

import { getDatabase } from '../db.js';
import { KnowledgeGraph } from '../knowledge-graph.js';
import { truncateTitle } from './title.js';
import { parseSqliteUtcMs } from './time-utils.js';
import { NAMESPACES } from './types.js';
import type { ExportInput, ExportResult, ImportInput, ImportResult } from './types.js';

type EntityMetadata = {
  trust?: 'trusted' | 'untrusted';
  provenance?: Record<string, unknown>;
  [key: string]: unknown;
};

/**
 * Metadata keys a BUNDLE may contribute — because reading them back never
 * changes what MeMesh DOES, only what it displays or how it explains its own
 * history. Everything else is refused by default (see
 * `AUTHORITY_METADATA_KEYS`): round 1 (#359) and round 3 (#361) both denied
 * one more key by name after a review found the previous deny-list missed
 * it, and "anything added later that carries authority has to be added here
 * too" had failed three times running. An ALLOW-list fails the opposite way
 * — a real, safe field gets dropped, which a test catches — instead of
 * silently admitting the next authority key nobody thought to name.
 *
 * Built from evidence: every key below was found by grepping every metadata
 * WRITE site and every metadata READ site in `src/` and `scripts/hooks/`,
 * then verifying the read site does not gate a decision. The scrape itself
 * is `tests/core/import-metadata-classification.test.ts`, which fails if a
 * future behaviour-reading key is added to neither this set nor
 * `AUTHORITY_METADATA_KEYS`.
 */
export const IMPORTABLE_METADATA_KEYS: ReadonlySet<string> = new Set([
  // Title bookkeeping (knowledge-graph.ts ~382-402, db.ts ~604,
  // graph-repairs.ts ~440, scripts/hooks/_shared.js ~788-860): distinguishes
  // a machine-generated title from a user-provided one for DISPLAY only —
  // grepped for a conditional read (`title_source ===`) and found none.
  'title_source',
  // Dreamer bookkeeping, `dream accept` -> `createEntity` (dreamer.ts
  // ~611-628): a digest's own provenance (where it came from, when, and
  // under what cluster). None of these six are read back anywhere outside
  // the write site itself — `product-improvements.ts`/`cli.ts` display the
  // separate `dream_proposals` TABLE row, not this copy. Beyond the
  // originating review's own example list; verified independently.
  'source_kind',
  'source',
  'cluster_key',
  'dreamed_at',
  'kind',
  'project',
  // Namespace-move breadcrumb pair (knowledge-graph.ts ~420-432): "where an
  // entity was, and when it moved", for `memesh why` / display. Grepped for
  // every reader of both (`grep -rn namespace_moved_at`): the ONLY other hit
  // is `tests/knowledge-graph.test.ts:1010`, which asserts its TYPE
  // (`typeof === 'string'`) as a display-shape check, not a behaviour gate.
  // `namespace_moved_at` was missing from this list through round 5 — round
  // 6 review found a real export→import round trip silently dropped it
  // while `previous_namespace` survived (`tests/core/export-import.test.ts`,
  // "a moved entity's namespace-move breadcrumb pair survives a real
  // export→import round trip"). Treated identically to its sibling: no
  // separate validator, same plain allow-list membership — neither field
  // gates a decision, so neither needs one.
  'previous_namespace',
  'namespace_moved_at',
  // `splitFusedLessons` provenance (graph-repairs.ts ~435, ~611-641): names
  // the shell an entity was split from. The one READ
  // (`repairFusedLessonShellHistory`, called from `migrateToCurrentSchema`
  // -> `db.ts:189`) is a marker-guarded ONE-TIME migration that runs
  // SYNCHRONOUSLY inside every `openDatabase()` call, before the handle is
  // returned to any caller — and `importMemories()` cannot run without an
  // already-open handle. So the migration's marker is always checked/set
  // strictly BEFORE any import on that database could exist, never after —
  // verified 2026-09-20 with a REAL run (child process, isolated HOME/
  // MEMESH_DIR, not an in-process env override): opened a fresh db (marker
  // set), imported an entity carrying `split_from` that pointed at an
  // archived/empty/nonzero-recall-hit shell built to match the migration's
  // WHERE clause exactly, closed and RE-opened the same db (simulating a new
  // session) — the marker was byte-identical both times and the shell's
  // recall_hits stayed untouched, proving the repair did not reconsider the
  // post-import state. A bundle-supplied `split_from` therefore has no live
  // migration left to feed, on a fresh database or an existing one.
  'split_from',
  // Forensic recall-count reset marker (graph-repairs.ts ~84-137): write-only
  // audit trail, no conditional read found.
  'retired_recall',
  // Product-improvement bookkeeping, `dream accept` -> `createEntity`
  // (dreamer.ts ~476-492): a copy of the accepted proposal's own fields
  // (priority, the criteria it must satisfy, its current
  // implementation/outcome status, when it was accepted, which entities it
  // came from) stamped onto the resulting entity for display — the SAME
  // pattern as the six-key transcript-digest block above, a second,
  // independent instance of it that the round-4/5 hand-written 17-file scan
  // never scraped (`dreamer.ts` was ALREADY in that list — the miss was the
  // DETECTION PATTERN, not the file: the old scan only matched `.foo`
  // property READS, and every one of these seven is write-only). Found by
  // round 6's widened scan (`tests/core/import-metadata-classification.test.ts`),
  // which walks the whole tree and also scans object-literal WRITE sites, not
  // just reads. Verified independently: zero conditional readers anywhere in
  // `src/` (`grep -rn 'metadata\.<key>\|meta\.<key>'` for each, all empty).
  'priority',
  'success_criteria',
  'verification_scenario',
  'implementation_state',
  'outcome_state',
  'accepted_at',
  'source_ids',
]);

/**
 * Metadata keys that change what MeMesh DOES — ranking, compaction
 * eligibility, prompt injection, hard deletion, or auto-trust — and must
 * therefore never be set, changed, or cleared by an untrusted bundle on an
 * entity that already exists. `buildImportedMetadata` denies every key here
 * by omitting it from the allow-list filter; the ONLY exceptions are the
 * FOUR named explicitly where this file builds a validated fresh-entity
 * value (`forgotten_observation_hashes`, `pin`, `signal_score`,
 * `replaced_history`) — everything else in this set is refused outright, for
 * an existing entity AND for one the import creates.
 *
 * This constant exists to be complete, not to encode policy: policy lives in
 * `buildImportedMetadata` below. Its job is that
 * `tests/core/import-metadata-classification.test.ts` can assert every
 * behaviour-reading key the codebase actually has is classified SOMEWHERE —
 * so a new authority key added later fails a test instead of shipping quiet.
 */
export const AUTHORITY_METADATA_KEYS: ReadonlySet<string> = new Set([
  // Dreamer idempotency gate (dreamer.ts ~810-814, `dream accept`'s Phase-3
  // pattern path): `if (!evidenceFor.includes(digestId)) evidenceFor.push
  // (digestId)` reads THIS FIELD to decide whether to append — a genuine
  // conditional, not display. Round 4-5 classified it DESCRIPTIVE (read only
  // by its own writer, no OTHER reader) — true, but that writer's read
  // GATES a write, so the round-6 review correctly reclassified it: "when
  // unsure, AUTHORITY" applies even to a key with exactly one reader if that
  // reader branches on it. Denied always, no restore exception — a bundle
  // must not be able to pre-seed this idempotency list. `dream accept`
  // still works on an entity imported without it: `Array.isArray(undefined)`
  // is `false`, so a missing field reads as `[]`, `includes(digestId)` is
  // `false`, and the real `dream accept` path pushes `digestId` and creates
  // the relation exactly as it would for any entity never used as evidence
  // before — at worst (an extremely unlikely digest-id collision with a
  // PRIOR run this entity's own history no longer records) it re-adds a
  // digest id already linked, which `INSERT OR IGNORE` on the relation row
  // already makes idempotent regardless.
  'evidence_for',
  // Bash guard installation (guard-check.js, doctor.ts, _shared.js
  // ~79/~132) — denied always, no restore exception (#359).
  'guard',
  // Marks memesh's own seeded tour data; `demo --reset` HARD-DELETES every
  // entity carrying it — denied always, no restore exception (#361).
  'demo',
  // Keeps a Stop snapshot from re-adding text `forget` explicitly removed
  // (knowledge-graph.ts ~576-587) — denied for an existing entity; a FRESH
  // entity gets a VALIDATED restore (`validateFreshForgottenHashes` below).
  'forgotten_observation_hashes',
  // Injected verbatim into SessionStart / `memesh briefing` context
  // (task-state.ts, briefing.ts, task-state-store.ts) — the prompt-injection
  // path #359's round-4 review closed. Denied always, fresh or not: a
  // restored task state is stale by definition, and this is text a received
  // file could put in front of the agent.
  'task_state',
  // The dreamer's compaction-exclusion flag (operations.ts `setPinned`,
  // dreamer.ts ~111) — denied for an existing entity (a bundle must not be
  // able to UNPIN a protected memory by omission or by `pin: false`); a
  // FRESH entity accepts ONLY the literal `true` (protective grants are
  // safe, protective revocations from a bundle are not).
  'pin',
  // Ranking/eligibility weight (signal-scorer.ts, dreamer.ts ~109,
  // briefing.ts ~138, kg-backfill.ts ~547, session-start.js ~1251, and the
  // dashboard's default-hide threshold) — denied for an EXISTING entity,
  // same as every other authority key: a bundle can neither set, change nor
  // clear it. `tests/core/export-import.test.ts` ("carries metadata, but
  // never a guard") already promised a delete-then-reimport round trip
  // keeps a FRESH entity's score, so — owner decision — it gets the SAME
  // narrow, VALIDATED restore exception as `pin` and
  // `forgotten_observation_hashes`: only a finite number in [0, 1]
  // (`validateFreshSignalScore`, matching `computeSignalScore`'s own
  // documented range) is accepted; anything else is dropped and the
  // importing machine stamps its own content-derived score.
  'signal_score',
  // `--replace`'s history (operations.ts ~87-139, ~248-263, ~334-335):
  // round-4/5/6 classified this DESCRIPTIVE — "read back only to compute a
  // COUNT for the recall response shape" — which was true of ONE reader
  // (`summarizeReplacedHistory`, operations.ts ~122-129) and false of a
  // SECOND: `rememberInTransaction`'s own `replace` path READS the current
  // value, APPENDS the version it just replaced, and WRITES the result back
  // (operations.ts ~334-335, `updateEntityMetadata(name, (current) => ({
  // ...current, replaced_history: boundReplacedHistory([...history,
  // version]) }))`) — a read-modify-write, not a display read. Missed by
  // round 4-6 because every prior audit of this key asked "is it READ to
  // change behaviour" and stopped at the first reader found; it never asked
  // "does some OTHER path read it, mutate it, and write it back", which is
  // the trap a bundle's forged history walks straight into: on an EXISTING
  // entity, `bundledSafe`'s unconditional spread (round 7 and earlier)
  // replaced real local history with the bundle's, and the next LOCAL
  // `--replace` then appended the genuine new version onto that FORGED
  // list — round 7 review reproduced this for real, isolated database,
  // before this fix. Denied for an EXISTING entity, same as every other
  // authority key: local history (or its absence) always wins, for
  // `append` and `overwrite` alike. A FRESH entity accepts ONLY a value
  // `validateFreshReplacedHistory` below shapes-checks against exactly what
  // `rememberInTransaction`'s own `replace` path writes
  // (`ReplacedVersion`, operations.ts ~132-139) — never a partially
  // trusted shape.
  'replaced_history',
  // Compaction-chain depth guard (dreamer.ts ~110, ~747) — denied always, no
  // restore exception: an importing machine cannot know a bundle-claimed
  // depth is honest, and a wrong depth changes future compaction eligibility.
  'consolidation_depth',
  // Back-pointer to the digest an entity was compacted into (dreamer.ts
  // ~112, ~841-845) — denied always: a bundle-forged pointer would mark a
  // real memory as already-superseded.
  'compacted_into',
  // Links an accepted entity back to its `dream_proposals` row
  // (db.ts ~526-527, product-improvements.ts ~306-308) — denied always.
  // CHANGELOG.md ~2381 already documents this as deliberate design: a
  // migration is "scoped by `metadata.proposal_id` so it cannot reach an
  // import" — this round only makes the SAME rule apply to the ordinary
  // import path, not just that one migration.
  'proposal_id',
  // Keys the KG-backfill session-co-occurrence rule
  // (kg-backfill.ts ~720-726; `memesh kg backfill-relations
  // --session-cooccurrence`, documented in API_REFERENCE.md ~1725 /
  // CHANGELOG.md ~5068) — a bundle setting this would wire the imported
  // entity into a real session's relation cluster. Denied always.
  'session_id',
  // Rebuilt wholesale by every import regardless — never read from the
  // bundle at all (see the unconditional `trust`/`provenance` below). Listed
  // here only so the classification scrape has somewhere to put them.
  'trust',
  'provenance',
]);

/**
 * A SHA-256 hex digest — the exact shape `removeObservation` writes into
 * `forgotten_observation_hashes` (knowledge-graph.ts) and the exact shape
 * `createEntityInner`'s untrusted-write filter (same file, ~line 576)
 * compares against on every future untrusted write to a
 * `session-*-(files|fixes|summary)` entity. Anything else is not a hash this
 * system ever produced.
 */
const FORGOTTEN_HASH_RE = /^[a-f0-9]{64}$/;

/**
 * How many hashes a FRESH entity's bundle-supplied `forgotten_observation_hashes`
 * may carry before the whole list is treated as malformed. 1000 is generous
 * for what this field tracks — `forget` calls against ONE session snapshot's
 * own text, realistically single digits to low tens over an entity's life —
 * while still bounding how far an untrusted bundle can grow one JSON metadata
 * column. Over the cap the list is dropped WHOLE, not truncated: this field's
 * only job is suppression, and truncating would silently pick an arbitrary
 * subset of "which observations stay suppressed" — a wrong answer dressed up
 * as a partial right one, worse than restoring none.
 */
const MAX_IMPORTED_FORGOTTEN_HASHES = 1000;

/**
 * A bundle's `metadata.forgotten_observation_hashes`, validated for the ONE
 * case it is ever trusted — seeding a FRESH entity the import is creating
 * (see the comment in `buildImportedMetadata` for why an existing entity
 * never reaches this). Returns the de-duplicated list when every element is
 * a real SHA-256 hex digest and the bundle is not oversized; `null` —
 * "absent", not "partially trusted" — otherwise. One invalid element drops
 * the WHOLE list; this never returns a filtered-down remainder, because a
 * partially-honoured exclusion list is itself a wrong answer to "does memesh
 * honour `forget`".
 *
 * De-duplicates BEFORE checking element shape, not after. `[...new
 * Set(value)]` on a SPARSE array (holes, not JSON-reachable but reachable
 * from any other caller of this exported function) materialises each hole as
 * a literal `undefined` element. `Array.prototype.every` SKIPS holes — it
 * never invokes its callback for an index that does not exist — so checking
 * shape first let a sparse array pass vacuously (no element the callback
 * ever saw), and the untouched holes then rode through the dedup spread and
 * got stored as `[null]` after the JSON round trip: a value that violates
 * every element being a real hash, admitted anyway. Spreading through `Set`
 * FIRST turns holes into ordinary (non-sparse) `undefined` elements, which
 * `every` DOES visit — so the shape check that follows sees them and
 * correctly rejects.
 */
function validateFreshForgottenHashes(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const deduped = [...new Set(value)];
  if (!deduped.every((h) => typeof h === 'string' && FORGOTTEN_HASH_RE.test(h))) return null;
  return deduped.length <= MAX_IMPORTED_FORGOTTEN_HASHES ? deduped : null;
}

/**
 * A bundle's `metadata.signal_score`, validated for the ONE case it is ever
 * trusted — seeding a FRESH entity the import is creating (an existing
 * entity's own score always wins; see `buildImportedMetadata`).
 * `computeSignalScore` (signal-scorer.ts)'s own contract is "Deterministic:
 * never produces NaN, always in [0, 1]" — checked directly in that file's
 * header comment, `metadata.signal_score` ∈ [0, 1] — so this validator
 * accepts exactly that range: a number in `[0, 1]`. Anything else — a
 * string, `NaN`, `Infinity`, `-Infinity`, a negative number, greater than 1,
 * `null`, an object — is refused whole. No partial trust: there is no "clamp
 * it into range" here, matching every other validated restore in this file.
 *
 * No separate `Number.isFinite` check: `NaN` and both infinities already
 * fail `value >= 0 && value <= 1` on their own (every comparison against
 * `NaN` is false, and neither infinity is `<= 1` or `>= 0` on the wrong
 * side), so a second predicate testing the identical cases was dead weight —
 * round 6 review confirmed it is a no-op mutation. Explicit tests for `NaN`,
 * `Infinity` and `-Infinity` still pin the *outcome*, just not through a
 * separate code path.
 */
function validateFreshSignalScore(value: unknown): number | null {
  return typeof value === 'number' && value >= 0 && value <= 1 ? value : null;
}

/**
 * How many entries a FRESH entity's bundle-supplied `replaced_history` may
 * carry, and how large the WHOLE serialized array may be, before the list is
 * treated as malformed. Deliberately NOT copied verbatim from
 * `operations.ts`'s own local-production caps — this file doubles both as
 * import-time headroom, so a bundle exported by an OLDER or NEWER build with
 * a different cap does not need editing to still import. Measured against
 * the real writer before picking numbers (round 8, isolated child-process
 * probe, `rememberInTransaction`'s own `replace` path, not a guess):
 *
 * - `REPLACED_HISTORY_MAX` (operations.ts ~87) is 20 entries.
 *   `REPLACED_HISTORY_MAX_BYTES` (operations.ts ~95) is 64 KiB — round 9
 *   review caught a round-8 comment here calling this "64 KiB PER ENTRY",
 *   which the real code does not say: `boundReplacedHistory`'s own byte
 *   check, `while (out.length > 1 && jsonBytes(out) >
 *   REPLACED_HISTORY_MAX_BYTES)`, measures `jsonBytes(out)` — `out` is the
 *   WHOLE array being trimmed down, not one entry. It is a budget for the
 *   ENTIRE serialized history, and this file's own bound below is now
 *   defined the same way, over the same thing, not "double the per-entry
 *   invariant" (there is no per-entry invariant to double).
 * - A single `--replace` on a note carrying 500 tiny observations produced
 *   ONE entry, `observations.length === 500`, and a TOTAL serialized array
 *   size of 4974 bytes for the exact fixture this file's own tests use
 *   (`obs-0` through `obs-499`; re-measured round 10 with
 *   `Buffer.byteLength(JSON.stringify(...), 'utf8')`, the same function this
 *   validator itself calls — two EARLIER rounds had cited 4978 and 3474 for
 *   the same fixture, both wrong)
 *   — comfortably under any byte budget discussed here, and a COUNT-based
 *   per-observation cap (a first draft of this validator used 200) would
 *   have REJECTED this REAL, LEGITIMATE entry regardless. There is no
 *   count-based cap on observations anywhere in `operations.ts`; the only
 *   real invariant is the AGGREGATE byte budget over the WHOLE array. This
 *   validator therefore bounds total serialized SIZE, not element COUNT,
 *   for `observations`/`tags`.
 * - `title` is `string | null` in the real type (`ReplacedVersion`,
 *   operations.ts ~132-139) — genuinely `null`, not merely absent, whenever
 *   the replaced version had no title. A validator that only accepted a
 *   STRING title would reject this real, common shape.
 * - A single 100 KiB observation, replaced, produced an entry with
 *   `observations: []` (empty) and `truncated: true` — `boundReplacedHistory`
 *   cannot split one oversized observation, so it drops it entirely rather
 *   than keep a partial string. An empty `observations` array is therefore a
 *   real, valid shape this validator must accept.
 * - 25 consecutive replaces produced exactly 20 stored entries — confirms
 *   `REPLACED_HISTORY_MAX` is enforced at write time, so this validator's
 *   50-entry ceiling is never the binding constraint for real data, only for
 *   a bundle claiming more than any real build has ever produced.
 *
 * The byte bound below is checked over the WHOLE accepted array (round 9;
 * round 8's version checked it per-entry, at 128 KiB — an unjustified
 * doubling of a per-entry figure that does not exist in the real writer).
 * 256 KiB is 4x `REPLACED_HISTORY_MAX_BYTES` (64 KiB), the same style of
 * cross-version headroom as the 50-vs-20 entry-count ratio above, over the
 * SAME thing the real writer bounds — the whole serialized array, not one
 * entry's share of it.
 */
const MAX_IMPORTED_REPLACED_HISTORY_ENTRIES = 50;
const MAX_IMPORTED_REPLACED_HISTORY_TOTAL_BYTES = 4 * 64 * 1024;

/** The exact key set `ReplacedVersion` (operations.ts ~132-139) has — no
 *  other key survives, on ANY entry, or the WHOLE list is dropped. */
const REPLACED_HISTORY_ENTRY_KEYS: ReadonlySet<string> = new Set([
  'replaced_at', 'title', 'observations', 'tags', 'truncated',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const jsonBytesOf = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');

/** One `replaced_history` entry, shape-checked against exactly what
 *  `rememberInTransaction`'s `replace` path (operations.ts ~257-263) writes.
 *  `Object.keys` on a value produced by `JSON.parse` enumerates `__proto__`/
 *  `constructor`/`toString` as ordinary OWN string keys (JSON.parse has
 *  special-cased `__proto__` as a data property since ES2019, never as a
 *  prototype override) — the allow-list check below rejects all three the
 *  same way it rejects any other unknown key, not through a separate
 *  prototype-pollution guard. */
function isValidReplacedHistoryEntry(entry: unknown): entry is {
  replaced_at: string; title: string | null; observations: string[]; tags: string[]; truncated?: boolean;
} {
  if (!isPlainObject(entry)) return false;
  for (const key of Object.keys(entry)) {
    if (!REPLACED_HISTORY_ENTRY_KEYS.has(key)) return false;
  }
  if (typeof entry.replaced_at !== 'string' || entry.replaced_at.length > 64) return false;
  if (!(entry.title === null || (typeof entry.title === 'string' && entry.title.length <= 500))) return false;
  if (!Array.isArray(entry.observations) || !entry.observations.every((o) => typeof o === 'string')) return false;
  if (!Array.isArray(entry.tags) || !entry.tags.every((t) => typeof t === 'string')) return false;
  if ('truncated' in entry && typeof entry.truncated !== 'boolean') return false;
  return true;
}

/**
 * A bundle's `metadata.replaced_history`, validated for the ONE case it is
 * ever trusted — seeding a FRESH entity the import is creating. An EXISTING
 * entity's own history (or its absence) always wins: see the
 * round-8 comment on `replaced_history` in `AUTHORITY_METADATA_KEYS` for the
 * read-modify-write bug this closes. `null` — "absent", not "partially
 * trusted" — on any violation, for the same reason every other validator in
 * this file drops the whole value rather than filtering it down: a partial
 * history is a wrong answer to "what did this memory used to say", not a
 * safer one. The byte check runs LAST, over the WHOLE array — the same
 * quantity, over the same thing, `boundReplacedHistory` (operations.ts)
 * bounds for real data; see the constant's own comment above for why this
 * moved here from a per-entry check in round 9.
 */
function validateFreshReplacedHistory(value: unknown): unknown[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (value.length > MAX_IMPORTED_REPLACED_HISTORY_ENTRIES) return null;
  if (!value.every(isValidReplacedHistoryEntry)) return null;
  return jsonBytesOf(value) <= MAX_IMPORTED_REPLACED_HISTORY_TOTAL_BYTES ? value : null;
}

function buildImportedMetadata(
  existingMetadata: EntityMetadata | undefined,
  args: {
    exportedAt: string;
    importVersion: string;
    mergeStrategy: ImportInput['merge_strategy'];
    /** What the BUNDLE said, which is attacker-controlled in the general case. */
    bundled?: Record<string, unknown>;
    /**
     * Whether a local entity already existed before this import touched it.
     * Deliberately a caller-supplied boolean, NOT inferred from
     * `existingMetadata` being present — a row can exist with a `NULL`
     * metadata column (an internal repair path can do this, see
     * `src/storage/graph-repairs.ts`), and that is still an EXISTING local
     * entity, not a fresh one a bundle may seed exclusions onto. The caller
     * (`importMemories`) already has this as `Boolean(existing)`.
     */
    isNewEntity: boolean;
  }
): EntityMetadata {
  const bundled = (args.bundled ?? {}) as Record<string, unknown>;

  // ALLOW-LIST filter — round 4. Only a key in `IMPORTABLE_METADATA_KEYS`
  // reaches `bundledSafe` at all; everything in `AUTHORITY_METADATA_KEYS`
  // AND every key neither list names (an unknown/future field) is silently
  // absent, by construction, with the SAME ONE mechanism. This replaces the
  // round 1-3 deny-list (`const { guard, demo, forgotten_observation_hashes,
  // ...bundledSafe }`), which needed one more excluded name every time a
  // review found the next authority key it had not thought of (#359 round 1,
  // #361). Filtering IN is the version of this mistake a test can catch: a
  // safe key omitted from the allow-list fails loudly (`tests/core/import-
  // metadata-classification.test.ts` plus ordinary round-trip tests); an
  // authority key omitted from the deny-list failed silently, three times.
  const bundledSafe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(bundled)) {
    if (IMPORTABLE_METADATA_KEYS.has(key)) bundledSafe[key] = value;
  }

  // FOUR AUTHORITY keys get a narrow, EXPLICIT restore exception, all only
  // for a FRESH entity (`args.isNewEntity`) and all applied AFTER the
  // allow-list merge below so none can be shadowed by an unrelated key.
  //
  // `forgotten_observation_hashes`: see `validateFreshForgottenHashes`'s own
  // comment. #346 fixed a bundle CLEARING this list on an entity that
  // already had one; #359 found that an entity with NONE locally still let
  // the raw value pass through unvalidated on create. CHANGELOG [4.10.1]
  // promises an observation removed with `forget` "stays removed from later
  // Stop snapshots" with no caveat, and this is what lets a user's OWN
  // backup carry its OWN exclusions onto a fresh machine — denying it always
  // (rather than restoring a validated copy on create) broke that promise on
  // the one path it exists to serve.
  const freshForgottenHashes = args.isNewEntity
    ? validateFreshForgottenHashes(bundled.forgotten_observation_hashes)
    : null;
  // `pin`: protective, so the only direction worth restoring on a fresh
  // entity is GRANTING it, never revoking — a bundle omitting `pin`, or
  // sending `pin: false` or any non-`true` value, must not read as "unpin",
  // because there is nothing local to unpin yet. Strict `=== true`: not `1`,
  // not `"true"`, not merely truthy.
  const freshPin = args.isNewEntity && bundled.pin === true;
  // `signal_score`: an EXISTING entity's own score always wins — the
  // bundle's value never reaches `bundledSafe`, so nothing here can set,
  // change or clear it on a memory you already have, same as every other
  // AUTHORITY key. `tests/core/export-import.test.ts` ("carries metadata,
  // but never a guard") already promises a delete-then-reimport round trip
  // keeps the score for an entity the import CREATES — honoured here, but
  // only for a value `computeSignalScore` itself could have produced
  // (`validateFreshSignalScore`); anything else is dropped and
  // `createEntityInner` stamps its own content-derived score instead.
  const freshSignalScore = args.isNewEntity ? validateFreshSignalScore(bundled.signal_score) : null;
  // `replaced_history`: an EXISTING entity's own history (or its absence)
  // always wins — round 8 found `rememberInTransaction`'s `replace` path
  // reads this field, appends to it, and writes it back
  // (operations.ts ~334-335), so letting a bundle's value through the plain
  // allow-list (as rounds 4-7 did) let a forged history survive a LATER
  // genuine local replace, silently mixed with real data. See the
  // `replaced_history` comment in `AUTHORITY_METADATA_KEYS` above for the
  // full mechanism and the round-8 reproduction.
  const freshReplacedHistory = args.isNewEntity
    ? validateFreshReplacedHistory(bundled.replaced_history)
    : null;

  return {
    ...(existingMetadata ?? {}),
    ...bundledSafe,
    ...(freshForgottenHashes ? { forgotten_observation_hashes: freshForgottenHashes } : {}),
    ...(freshSignalScore !== null ? { signal_score: freshSignalScore } : {}),
    ...(freshPin ? { pin: true } : {}),
    ...(freshReplacedHistory ? { replaced_history: freshReplacedHistory } : {}),
    trust: 'untrusted',
    provenance: {
      ...(existingMetadata?.provenance ?? {}),
      source: 'import',
      imported_at: new Date().toISOString(),
      exported_at: args.exportedAt,
      export_version: args.importVersion,
      merge_strategy: args.mergeStrategy,
    },
  };
}

/**
 * Export entities as a portable JSON snapshot for sharing or backup.
 * Optional tag and namespace filters narrow the export set.
 */
export function exportMemories(args: ExportInput): ExportResult {
  const db = getDatabase();
  const kg = new KnowledgeGraph(db);

  const limit = args.limit || 1000;
  const entities = kg.search(undefined, {
    tag: args.tag,
    // One MORE than asked for, so "there is more" is a fact rather than an
    // inference. `entities.length === limit` cannot tell a graph of exactly
    // `limit` memories from one that was cut short, and it is the cut-short
    // case that matters: measured on a real graph of 1272 memories, the
    // default export carried 1000 and reported `✅ Exported 1000 entities`,
    // so a backup was missing 21% of the thing it was taken to preserve and
    // said nothing. The extra row costs one query, not a second copy of the
    // filter.
    limit: limit + 1,
    // Archived memories ARE part of a backup. They were skipped, so
    // `memesh forget` followed by an export and a restore brought the
    // memory back to life — the one operation whose whole purpose is to
    // take something out of circulation, undone by the one operation whose
    // whole purpose is to preserve state faithfully.
    includeArchived: true,
    namespace: args.namespace,
    // A backup is not a use. Without this, `memesh export` bumped
    // `access_count` and stamped `last_accessed_at = now` on up to a
    // thousand memories — 20% of the ranking — so the act of taking a backup
    // re-sorted the graph and made every exported memory look freshly
    // relevant on the day the backup ran. `listByType` draws the same line
    // by simply never calling trackAccess.
    countAsAccess: false,
  });

  const truncated = entities.length > limit;
  const exported = truncated ? entities.slice(0, limit) : entities;

  return {
    version: '3.1.0',
    exported_at: new Date().toISOString(),
    entity_count: exported.length,
    // Carried in the RESULT, not printed by the CLI alone: the MCP and HTTP
    // callers export too, and an agent taking a backup on the user's behalf
    // is exactly who must not be told a truncated bundle is the whole graph.
    truncated,
    entities: exported.map((e) => ({
      name: e.name,
      type: e.type,
      // The bundle carries `title` because without it the round trip is not a
      // round trip: export → import silently dropped every human-readable
      // title, and the import reported the entity as imported while it came
      // back with nothing but its slug-shaped name in every surface that shows
      // a title. Written explicitly as `null` when absent rather than omitted,
      // so a reader can tell "no title" from "this bundle predates titles".
      title: e.title ?? null,
      namespace: e.namespace ?? 'personal',
      // `created_at` is not a detail. It drives recency in ranking, the
      // dreamer's weekly clustering, `memesh why`, and every "what was I
      // doing then" question — and without it a restore stamped every
      // memory with the day of the restore, flattening the whole timeline
      // into one instant.
      created_at: e.created_at,
      // Only when it is not the default, so an ordinary bundle stays the
      // shape a reader already knows.
      ...(e.archived ? { status: 'archived' } : {}),
      // Everything memesh knows that is not the text: provenance,
      // `signal_score`, `task_state`, the demo marker. Import rebuilds
      // trust and provenance for itself and refuses `guard`.
      ...(e.metadata ? { metadata: e.metadata } : {}),
      observations: e.observations,
      tags: e.tags,
      relations: (e.relations || []).map((r) => ({ to: r.to, type: r.type })),
    })),
  };
}

/**
 * Import entities from a JSON export snapshot.
 * merge_strategy controls how existing entities are handled:
 *   - 'skip': leave existing entities untouched, only create new ones
 *   - 'append': add observations to existing entities
 *   - 'overwrite': clear existing data, then re-populate
 *
 * An existing entity that is ARCHIVED is left untouched by 'append' and
 * 'overwrite' and counted in `kept_archived`, unless `restore_archived` is set:
 * forgetting outranks importing, and the count tells the user it happened.
 * `restore_archived` with 'skip' is refused: 'skip' would ignore it.
 *
 * An unrecognised strategy is REFUSED, not defaulted. This used to be two
 * `if`s and a fall-through, so any other string — a typo like `sikp`, or
 * `safe` — took the overwrite path: the most destructive of the three, on the
 * least information. Measured: `--merge bogus` against an existing entity
 * reported "Imported: 1", exit 0, replaced the observation and archived
 * nothing to restore it from.
 */
const MERGE_STRATEGIES = ['skip', 'overwrite', 'append'] as const;

/**
 * What is wrong with one entry of a bundle, in words, or null if nothing is.
 *
 * The import path used to hand whatever it found straight to SQLite. An entry
 * missing `type` produced `Provided value cannot be bound to SQLite parameter
 * 2` — a message about the storage layer's argument list, for a user who has a
 * JSON file in front of them and no way to map one to the other.
 */
function describeInvalidEntity(entity: unknown, index: number): string | null {
  const where = `entities[${index}]`;
  if (typeof entity !== 'object' || entity === null || Array.isArray(entity)) {
    return `${where} is ${Array.isArray(entity) ? 'an array' : typeof entity}, not an object with "name" and "type".`;
  }
  const e = entity as Record<string, unknown>;
  for (const field of ['name', 'type'] as const) {
    if (typeof e[field] !== 'string' || e[field] === '') {
      return `${where} has no usable "${field}" (found ${e[field] === undefined ? 'nothing' : JSON.stringify(e[field])}).`;
    }
  }
  for (const field of ['observations', 'tags', 'relations'] as const) {
    if (e[field] !== undefined && !Array.isArray(e[field])) {
      return `${where}.${field} is ${typeof e[field]}, not an array.`;
    }
  }
  // The namespace a bundle carries per entity places the entities an import
  // CREATES, and it was unchecked while the caller's override became an enum.
  // So a bundle — which over MCP is content an agent may have been handed —
  // could still write memories into a scope no filter selects: invisible to
  // every scoped recall, to `export --namespace`, and to the memory tool,
  // while squatting the name database-wide so a later legitimate create of it
  // is refused. Reported per entity rather than thrown, so one bad row does
  // not cost the whole bundle.
  if (e.namespace !== undefined && !(NAMESPACES as readonly string[]).includes(e.namespace as string)) {
    return `${where}.namespace is ${JSON.stringify(e.namespace)}, which is not one of: ${NAMESPACES.join(', ')}.`;
  }
  return null;
}

export function importMemories(args: ImportInput): ImportResult {
  if (!(MERGE_STRATEGIES as readonly string[]).includes(args.merge_strategy)) {
    throw new Error(
      `Unknown merge strategy "${args.merge_strategy}". Use one of: ${MERGE_STRATEGIES.join(', ')}. ` +
      'Nothing was imported — refusing rather than guessing, because the wrong guess overwrites existing memories.'
    );
  }

  // Restoring what the user forgot needs an explicit boolean. The transports
  // pass one or refuse the request, but this function is also called
  // directly, and a truthy string must not read as "yes".
  if (args.restore_archived !== undefined && typeof args.restore_archived !== 'boolean') {
    throw new Error(
      'restore_archived must be the boolean true or false. ' +
      'Nothing was imported — refusing rather than guessing, because "yes" brings back memories the user forgot.'
    );
  }

  // `skip` leaves every existing entity alone, an archived one included, so
  // `restore_archived` would change nothing. Refused instead of accepted and
  // ignored: a caller who asked for archived memories back must not read a
  // successful import as having brought them back.
  if (args.restore_archived === true && args.merge_strategy === 'skip') {
    throw new Error(
      'restore_archived (--restore-archived) only applies with merge strategy "append" or "overwrite"; ' +
      '"skip" leaves every existing entity untouched, so there is nothing to restore. Nothing was imported.'
    );
  }

  // The namespace override MOVES entities that already exist, so an
  // unrecognised value does not merely mis-file new rows — it relocates
  // existing memories into a scope no filter matches, and they vanish from
  // every scoped view while the import reports them appended. `ImportSchema`
  // validates this field as `z.string().max(50)` rather than the enum
  // `remember` uses, so MCP and HTTP callers reach here with anything; the CLI
  // is the only transport that checked. Checking in core covers all three.
  if (args.namespace !== undefined && !(NAMESPACES as readonly string[]).includes(args.namespace)) {
    throw new Error(
      `Unknown namespace "${args.namespace}". Use one of: ${NAMESPACES.join(', ')}. ` +
      'Nothing was imported — an unrecognised namespace would move existing memories somewhere nothing queries.'
    );
  }

  // A bundle whose `entities` is not an array cannot be imported at all, and
  // the loop below would not have said so: `for…of` over a STRING iterates its
  // characters, so `"oops"` became four entities named `undefined`, and the
  // report came back as four `undefined: …` lines. A string is the likely
  // shape here — someone JSON-encoded the array twice.
  const bundleEntities = (args.data as { entities?: unknown } | null | undefined)?.entities;
  if (!Array.isArray(bundleEntities)) {
    throw new Error(
      `This file has no "entities" array (found ${bundleEntities === undefined ? 'nothing' : typeof bundleEntities}). ` +
      'Nothing was imported. memesh import expects a file produced by `memesh export`.'
    );
  }

  const db = getDatabase();
  const kg = new KnowledgeGraph(db);

  let imported = 0;
  /** Of `imported`, how many REPLACED an entity that already existed
   *  (merge_strategy 'overwrite' hitting a name already in the graph) —
   *  destructive, versus a genuinely new entity. Both used to increment
   *  the same `imported` counter, so "Imported: 4" printed identically
   *  whether it overwrote four existing memories or created four new
   *  ones from nothing. */
  let overwritten = 0;
  /** (from, to, type) triples held back until every entity exists. */
  const pendingRelations: Array<{ from: string; to: string; type: string }> = [];
  let skipped = 0;
  let appended = 0;
  /** Archived local entities left untouched (see `restore_archived`). */
  let keptArchived = 0;
  const errors: string[] = [];
  /** Relations whose target is not in the bundle and not already stored. */
  const skippedRelations: string[] = [];
  /** Compiled once: a restore can create up to `limit` entities (1000). */
  const setCreatedAt = db.prepare('UPDATE entities SET created_at = ? WHERE name = ?');
  const entityExists = db.prepare('SELECT 1 FROM entities WHERE name = ?');

  for (const [index, entity] of args.data.entities.entries()) {
    const invalid = describeInvalidEntity(entity, index);
    if (invalid) {
      errors.push(invalid);
      continue;
    }
    try {
      // One bundle entry is one commit unit. `createEntity`,
      // `clearEntityData`, and `archiveEntity` are each atomic internally,
      // but import composes them with metadata/time/status restoration. A
      // failure in the last step used to commit the successful prefix: an
      // archived bundle entry whose FTS delete failed remained as an ACTIVE
      // entity, and its relation had already been queued for the second pass.
      // The outer transaction makes the composition atomic; the returned
      // outcome keeps JS counters and pending relations outside that boundary
      // so they describe committed units only.
      const outcome = db.transaction(() => {
        const existing = kg.getEntity(entity.name);
        // The import never read a title, because the export never wrote one —
        // the two halves of the same gap, and together they made every
        // export→import a silent rename of each memory to its slug-shaped
        // `name`. Read defensively, the way describeInvalidEntity reads the rest
        // of the bundle: this is a FILE, possibly written by a memesh that had
        // no titles at all, so the field is present-or-not rather than
        // guaranteed. Absent, blank or non-string becomes `undefined`, which is
        // createEntity's "leave whatever title is already there alone" — an
        // older bundle's missing title must not wipe one off a memory the
        // importer already had. `truncateTitle` because this is a generator-side
        // writer with nobody to bounce bad input back to (schemas.ts REJECTS
        // over-long titles; createEntity itself caps nothing), and one
        // hand-edited 10,000-character title should not become a stored one.
        const bundledTitle = (entity as Record<string, unknown>).title;
        const title = typeof bundledTitle === 'string' && bundledTitle.trim().length > 0
          ? truncateTitle(bundledTitle)
          : undefined;
        // The caller's `--namespace` override applies to everything, existing
        // entities included — that is what "force all imported entities into
        // this namespace" means. The namespace stored IN the bundle only places
        // entities the import creates: a bundle should not be able to relocate a
        // memory you already had, which for `append` would silently move it out
        // of the scope you keep it in.
        const namespace = args.namespace ?? (existing ? undefined : (entity.namespace || 'personal'));
        const importedMetadata = buildImportedMetadata(existing?.metadata as EntityMetadata | undefined, {
          bundled: (entity as { metadata?: Record<string, unknown> }).metadata,
          exportedAt: args.data.exported_at,
          importVersion: args.data.version,
          mergeStrategy: args.merge_strategy,
          isNewEntity: !existing,
        });

        if (existing) {
          if (args.merge_strategy === 'skip') return { kind: 'skipped' } as const;
          // A forgotten memory outranks a bundle naming it: without
          // `restore_archived` it is left exactly as it is. Returning here,
          // like the `skip` line above, queues none of the bundle entry's own
          // relations; a relation from another bundle entry TO it is still
          // created by the second pass, which finds the row by name.
          if (existing.archived && args.restore_archived !== true) return { kind: 'keptArchived' } as const;
          if (args.merge_strategy === 'append') {
            // Exact-text dedupe against what the entity already has.
            // `createEntity` INSERTs every observation it is handed with no
            // dedupe of its own — correct for `remember`, where a caller
            // stating the same fact again may be a deliberate re-assertion,
            // but wrong for import, whose whole point is merging a bundle
            // that may already have been imported once (the same backup
            // restored twice, or two bundles that share entities). Without
            // this, re-running `import --merge append` on the same file
            // grows every shared entity's observation list without bound —
            // dogfooded: the same sentence duplicated on every re-run.
            const existingText = new Set(existing.observations);
            const newObservations = (entity.observations ?? []).filter((o) => !existingText.has(o));
            // Pass trustOverride directly so the createEntity confidence-
            // bump gate denies the lift on untrusted imports. Codex
            // caught a P1 where the trust value was being set via
            // updateEntityMetadata AFTER createEntity returned, so the
            // gate read undefined → defaulted to trusted → bumped.
            kg.createEntity(entity.name, entity.type, {
              title,
              observations: newObservations,
              tags: entity.tags,
              namespace,
              trustOverride: 'untrusted',
            });
            // MERGE, never replace. An updater that ignores `current` rebuilds the
            // column from a snapshot taken before `createEntity` ran, discarding
            // whatever it just wrote — which now includes the
            // `previous_namespace` breadcrumb recorded when `--namespace` moves an
            // entity that already exists. Import is the one path where losing that
            // matters most: it moves entities in bulk, so a user cannot possibly
            // remember where each one came from.
            kg.updateEntityMetadata(entity.name, (current) => ({ ...current, ...importedMetadata }));
            return { kind: 'appended' } as const;
          }
          // overwrite: clear existing data, then re-populate below
          kg.clearEntityData(entity.name);
        }

        kg.createEntity(entity.name, entity.type, {
          title,
          observations: entity.observations,
          tags: entity.tags,
          metadata: importedMetadata,
          namespace,
          trustOverride: 'untrusted',
        });
        if (existing) {
          kg.updateEntityMetadata(entity.name, (current) => ({ ...current, ...importedMetadata }));
        }

        // `created_at` and a bundled `status: 'archived'` are applied only to
        // entities this import CREATED. An entity the importer already had
        // keeps its own creation time and takes no status from the bundle.
        // (With `restore_archived`, an archived one is active again because
        // the `createEntity` call above reactivates any archived row with the
        // same name — the re-remember rule `remember` keeps.)
        //
        // The timestamp is accepted only if `parseSqliteUtcMs` vouches for it.
        // That parser exists because a value it cannot read is a value nothing
        // downstream can order (see `kg-backfill` Rule 5), and it also closes
        // the door on a hand-edited bundle stamping a memory in the future,
        // where a negative age passes every recency check.
        if (!existing) {
          const bundledCreatedAt = (entity as { created_at?: unknown }).created_at;
          const bundledMs = typeof bundledCreatedAt === 'string'
            ? parseSqliteUtcMs(bundledCreatedAt)
            : null;
          if (bundledMs !== null) {
            // Stored in the COLUMN's format, not the bundle's. `parseSqliteUtcMs`
            // accepts either separator, so a bundle carrying `...T...` validates
            // and would be written back verbatim — recreating the two-format
            // column that `demo.ts` was just fixed to stop producing, and that
            // every `datetime(col)` workaround downstream exists to survive.
            // One writer, one format.
            setCreatedAt.run(new Date(bundledMs).toISOString().replace('T', ' ').slice(0, 19), entity.name);
          }
          if ((entity as { status?: unknown }).status === 'archived') {
            kg.archiveEntity(entity.name);
          }
        }

        return {
          kind: 'imported',
          overwritten: Boolean(existing),
          // Relations are DEFERRED to a second pass. Return them only after
          // this transaction commits; queuing them in the transaction body
          // would leave JS state behind after SQLite rolls back.
          relations: (entity.relations || []).map((rel) => ({
            from: entity.name,
            to: rel.to,
            type: rel.type,
          })),
        } as const;
      }).immediate();

      if (outcome.kind === 'skipped') skipped++;
      else if (outcome.kind === 'keptArchived') keptArchived++;
      else if (outcome.kind === 'appended') appended++;
      else {
        pendingRelations.push(...outcome.relations);
        imported++;
        if (outcome.overwritten) overwritten++;
      }
    } catch (err) {
      errors.push(`${entity.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Second pass: every entity in the bundle now exists, so a relation that
  // still cannot be created is genuinely pointing outside it. That is real
  // information loss and it is REPORTED — the old code could not tell the
  // two cases apart, so it had to swallow both.
  //
  // Reported, but NOT an error. A relation leaving the bundle is a property
  // of the bundle, not a failure of the import: any `--tag`/`--namespace`
  // filter produces them, and so does a bundle cut short by `--limit`. Put
  // in `errors` they set exit 1, which turns the round trip this project
  // documents — `memesh export > b.json && memesh import b.json` — into a
  // failing command on a restore that did exactly what it should. Measured:
  // a full backup of a 1272-memory graph restored 1000 entities and 142 of
  // 151 relations, and exited 1.
  for (const rel of pendingRelations) {
    if (!entityExists.get(rel.to)) {
      skippedRelations.push(`${rel.from} -${rel.type}-> ${rel.to}`);
      continue;
    }
    try {
      kg.createRelation(rel.from, rel.to, rel.type);
    } catch (err) {
      errors.push(
        `${rel.from} -${rel.type}-> ${rel.to}: relation not restored `
        + `(${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  return { imported, overwritten, skipped, appended, kept_archived: keptArchived, errors, skipped_relations: skippedRelations };
}
