import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'node:net';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { findRetiredConfigKeys, getConfigPath, readConfig } from './config.js';
import {
  openDatabase, closeDatabase, isDatabaseOpen, readOnlyFolderState,
} from '../db.js';
import { getUpdateCheck } from './version-check.js';
import { classifyBump } from './updater.js';
import { AUTO_UPDATE_REASONS, currentPolicy, describeLockHolder, inspectAutoUpdateState, readInstalling } from './auto-update.js';
import {
  getCurrentInstallChannel, getInstallChannelSupport, detectPluginHost,
  pluginHostConfigRoot, versionedPluginCacheRoots, PLUGIN_REFRESH_COMMANDS,
  type InstallChannel, type PluginHost,
} from './install-channel.js';
import { readInstallRecordState } from './install-id.js';
import { isWritable, ownerWriteCommand, runOrSay, shellQuote } from './file-mode.js';
import { unreadDeliveryCount } from './agent-message-inbox.js';
import { damagedDatabaseFix, diagnoseDatabaseFailure, isDamagedDatabaseError } from './database-diagnosis.js';
import { withoutFinalPeriod } from './sentence.js';
import { AutoArchiveRecordUnreadable, readLastAutoArchiveRun } from './lifecycle.js';
import { citationRulePath, citationRuleState, type CitationRuleScope } from './citation-rule.js';
import { getAgentRouterSocketPath, getDbPath, getMemeshDirFromDbPath, homeDir, memeshDir } from './paths.js';
import { findProjectIdentitySplits, type ProjectIdentitySplit } from './project-identity-split.js';
import { AGENT_ROUTER_SOCKET_PATH_MAX_BYTES } from './agent-router.js';
import { detectPluginRuntime, readInstallMarker } from './install-hooks.js';
import { manifestScope } from './manifest-scope.js';
import { claudeCodePresent, codexPresent, geminiPresent, isOnPath } from './host-presence.js';
import { UNSPACED_SCRIPT_GLOB_RUN3 } from '../storage/fts-index.js';
import { isUnsupportedNode, MemeshDatabase, MIN_NODE_SERIES } from '../storage/sqlite.js';
import { AUTO_CAPTURE_TAG } from './types.js';
import { SESSION_HANDOFF_TYPE } from './session-handoff.js';
import { parseSqliteUtcMs, sqliteUtcToIso } from './time-utils.js';
import { autoCaptureDecision } from './capture-flag.js';
import { summarizeNoteHolds } from './note-ingest.js';
import { decidePrivacy } from './private-session.js';
import {
  captureLivenessVerdict, parseHookOutcomes, summarizeHookOutcomes, summarizeTypeTrends,
  FAIL_ELIGIBLE_HOOKS, SKIP_REASONS, HOOK_OUTCOMES_FILENAME, NEVER_RAN_GRACE_HOURS, SILENT_HOOK_MIN_RUNS, RECENT_ERROR_RUNS,
  type CaptureLivenessStatus, type HookLivenessSummary, type TypeTrend,
} from './capture-liveness.js';
import { guardFromMetadata } from './guards.js';
import { getAgentMessageStorageReport } from './agent-message-storage.js';
import { HANDLED_RECEIPT_KINDS_SQL } from './agent-messaging.js';
import {
  AGENT_MESSAGE_EXPIRY_DONE_OUTCOMES, AGENT_MESSAGE_EXPIRY_FAILED_OUTCOMES, AGENT_MESSAGE_EXPIRY_INTERVAL_MS, databaseFile, inspectAgentMessageArchive,
  lastAgentMessageExpiryRun, latestAgentMessageExpiryArchive,
} from './agent-message-expiry.js';
import { readHostConfigFile } from '../host-runtime/config.js';
import { journeyRecordPath, readJourneyRecord } from './doctor-journey.js';
import { readRouterIdleExit } from '../host-runtime/router-idle.js';

export type DoctorCheckStatus = 'pass' | 'warn' | 'fail';
export type DoctorOverallStatus = 'PASS' | 'PASS_WITH_CONCERNS' | 'FAIL';

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorCheckStatus;
  summary: string;
  fix?: string;
  /**
   * Machine identifier for `doctor --fix`, attached at the BRANCH that
   * diagnosed the problem — never parsed out of the human `fix` string.
   * Orthogonal to `code` (i18n): a fixId claims no catalogue entry.
   * Only prescriptions on --fix's whitelist carry one; everything else
   * stays advice for a human.
   */
  fixId?: 'install-hooks' | 'fts-rebuild' | 'config-retired-settings' | 'plugin-cache-refresh';
  /**
   * True for rows that REPORT a value rather than ASSERT a fact.
   *
   * A doctor row is one of two very different things:
   *   - an assertion — "SQLite opens", "hooks are wired". It
   *     makes a claim that the outside world can falsify, so it can fail.
   *   - an informational row — "your install id is X". It describes state. It cannot fail, because it is not
   *     claiming anything is working.
   *
   * Before this flag existed both rendered as `[PASS]` and both counted
   * toward `Overall`, so "13/13 PASS" read as "13 things verified" when
   * some had verified nothing.
   *
   * Informational rows are excluded from `summarizeOverallStatus` and are
   * rendered as `[INFO]`. If you want a row to be able to fail, it must
   * probe something.
   */
  informational?: boolean;
  /**
   * Stable message-variant code + interpolation params, present on every
   * warn/fail row. The dashboard translates by code (doctor.msg.<code>.*)
   * and interpolates params — the earlier attempt to localize by check `id`
   * alone was reverted because one id has many states and a generic label
   * destroyed the diagnostic detail. `summary`/`fix` remain the English
   * source of truth (the CLI prints them; the dashboard falls back to them
   * when a code has no catalogue entry). tests/dashboard-i18n.test.ts scans
   * this file for `code:` literals and fails when the catalogue misses one,
   * so a new warn/fail variant cannot ship untranslated.
   */
  code?: string;
  params?: Record<string, string | number>;
}

export interface DoctorResult {
  status: DoctorOverallStatus;
  checks: DoctorCheck[];
  /**
   * The capture-liveness figures behind the `capture-liveness` row (#327).
   *
   * A row's `summary` is one sentence for a human; this is the evidence
   * under it — per hook, and per entity type week over week — so `--json`
   * consumers (and a support conversation) can see WHY the verdict is what
   * it is without a sqlite query. Absent when the check could not run.
   */
  capture?: CaptureLivenessReport;
}

export interface CaptureLivenessReport {
  status: CaptureLivenessStatus;
  hooks: HookLivenessSummary[];
  types: TypeTrend[];
  /** Heartbeat hooks with no outcome record AND no heartbeat row. */
  neverRan: string[];
}

interface JsonObject {
  [key: string]: unknown;
}

/**
 * The slice of the SQLite driver doctor uses, so tests can substitute a stub.
 *
 * `get` returns `unknown` and takes bind parameters. It used to be typed
 * `() => { c?: number }` — the shape of the one query that existed when it was
 * written — which forced every later caller to cast its result to something
 * else, and a cast is not a check. Returning `unknown` makes each call site
 * state what it expects at the point it reads it.
 */
interface DatabaseLike {
  prepare: (sql: string) => {
    get: (...params: unknown[]) => unknown;
    all: (...params: unknown[]) => unknown[];
    run: (...params: unknown[]) => unknown;
  };
}

interface DoctorOptions {
  packageRoot: string;
  packageVersion: string;
  probeHttp?: boolean;
  httpBaseUrl?: string;
  platform?: NodeJS.Platform;
  openDatabaseImpl?: typeof openDatabase;
  closeDatabaseImpl?: typeof closeDatabase;
  isDatabaseOpenImpl?: typeof isDatabaseOpen;
  getConfigPathImpl?: typeof getConfigPath;
  getUpdateCheckImpl?: typeof getUpdateCheck;
  getCurrentInstallChannelImpl?: typeof getCurrentInstallChannel;
  /** Test override for Claude Code's plugin registry — the default reads the
   *  real machine, which would make hook-wiring tests host-state-dependent. */
  installedPluginsPathImpl?: string;
  /** Test override for the commit the marketplace checkout is at — the
   *  default runs `git rev-parse HEAD` in ~/.claude/plugins/marketplaces. */
  marketplaceHeadShaImpl?: (host: import('./install-channel.js').PluginHost) => string | null;
  /** Discover plugin caches when doctor is running from npm-global. */
  pluginCacheDiscoveryImpl?: () => PluginCacheDiscovery[];
  getInstallChannelSupportImpl?: typeof getInstallChannelSupport;
  existsSyncImpl?: typeof fs.existsSync;
  readFileSyncImpl?: typeof fs.readFileSync;
  statSyncImpl?: typeof fs.statSync;
  /** Test override for the environment. A parameter for the same reason
   *  `detectPluginHost` takes one: describing a layout must not require
   *  mutating the process every other test in the file shares. */
  envImpl?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /**
   * Optional owner-supplied message-storage quota. Doctor reports it but
   * never enables it or changes the database. (Retention is not a policy: a
   * message is always kept one day.)
   */
  agentMessageStoragePolicy?: {
    storage_quota_bytes?: number;
  };
  /**
   * Test seam: probe that the built-in SQLite runtime can open a database.
   */
  nativeBindingProbeImpl?: (packageRoot: string) => { ok: true } | { ok: false; message: string };
  /**
   * Test seam: resolve `memesh` on the user's shell PATH. Default uses
   * `which` / `where` via execFileSync. Returns the resolved absolute
   * path or null when not found. Tests inject a stub.
   */
  resolveShellMemeshImpl?: () => string | null;
  /**
   * Opt-in installed-artifact probe for the durable-message MCP surface.
   * It starts the packaged stdio server in an isolated HOME and imports the
   * bundled host adapters; it is intentionally unrelated to the skills hash.
   */
  probeMessageCapability?: boolean;
  messageCapabilityProbeImpl?: (packageRoot: string) => { ok: true } | { ok: false; message: string };
  /**
   * Opt-in read-only probe of the actual Local router endpoint. It does not
   * start a router, register a synthetic host, send content, or wake a session.
   */
  probeMessageRouterStatus?: boolean;
  messageRouterStatusProbeImpl?: () => Promise<MessageRouterStatusProbe>;
}

interface PluginCacheDiscovery {
  host: import('./install-channel.js').PluginHost;
  packageRoot: string;
  installedPluginsPath?: string;
  unverifiableReason?: string;
}

interface ClaudePluginEntries {
  exists: boolean;
  readable: boolean;
  defined: boolean;
  malformed: boolean;
  entries: Array<Record<string, unknown>>;
}

type MessageRouterStatusProbe = {
  socket_path: string;
  socket: 'reachable' | 'missing' | 'insecure' | 'unreachable' | 'path-too-long';
  active_registrations?: number;
  detail?: string;
};

const EXPECTED_HOOK_TYPES = ['PreToolUse', 'SessionStart', 'PostToolUse', 'Stop', 'PreCompact'];
const AGENT_MESSAGE_STORAGE_QUOTA_ENV = 'MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES';

// Locale READMEs that MUST stay in lockstep with README.md. Order matters
// only for the doctor output — alphabetised for readability.
const LOCALE_README_FILES = [
  // The locale set was reduced to English + 繁體中文 + Deutsch (commit
  // bc6d8553) — eleven hand-synced copies of a fast-moving front page
  // drifted faster than they were read. Deutsch was dropped in turn,
  // leaving English + 繁體中文. This list must track that set: listing a
  // removed locale here made every source-checkout doctor run WARN about
  // files that are gone on purpose.
  'README.zh-TW.md',
];

// Locales legitimately translate headings, so we don't text-match the
// anchors — instead we compare H2 *counts*. A locale that's off by ≥2
// almost always means an English section was added (or removed) without
// the locale being resynced. ±1 stays a pass to absorb routine
// translation drift (one locale may collapse two short H2s).
const LOCALE_H2_TOLERANCE = 1;

function countH2Headings(content: string): number {
  // Track whether we're inside a fenced code block (``` or ~~~).
  // A `## comment` line inside a code block is example markdown, not a
  // real H2, so it shouldn't be counted. A simple toggling state
  // machine is enough for the well-formed READMEs this check targets.
  let n = 0;
  let inFence = false;
  for (const line of content.split('\n')) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line.startsWith('## ')) n++;
  }
  return n;
}

function inspectLocaleReadmeParity(
  packageRoot: string,
  existsSyncImpl: typeof fs.existsSync,
  readFileSyncImpl: typeof fs.readFileSync,
): DoctorCheck {
  const englishPath = path.join(packageRoot, 'README.md');
  if (!existsSyncImpl(englishPath)) {
    // Nothing to compare against; not a problem for users — skip with pass.
    return createCheck(
      'readme_locale_parity',
      'README locale parity',
      'pass',
      'README.md not present in this install; locale-parity check skipped.',
    );
  }
  let englishCount: number;
  try {
    englishCount = countH2Headings(readFileSyncImpl(englishPath, 'utf8'));
  } catch (err) {
    return createCheck(
      'readme_locale_parity',
      'README locale parity',
      'warn',
      `Could not read README.md: ${err instanceof Error ? err.message : String(err)}`,
      undefined,
      { code: 'readme-parity.unreadable', params: { detail: err instanceof Error ? err.message : String(err) } },
    );
  }

  // npm packs every README.* file whatever `files` says, so the locale
  // READMEs ship with the package and the plugin alike; one is missing only
  // when someone removed it. That is skipped, not reported: a maintainer-only
  // "keep the translations in sync" check must not reach ordinary users as a
  // WARN in their own doctor output. The repository's doc checks fail when
  // README.zh-TW.md is deleted.
  const present = LOCALE_README_FILES.filter((filename) => existsSyncImpl(path.join(packageRoot, filename)));
  if (present.length === 0) {
    return createCheck(
      'readme_locale_parity',
      'README locale parity',
      'pass',
      'No locale README in this install; locale-parity check skipped.',
    );
  }

  const drift: Array<{ name: string; count: number }> = [];
  for (const filename of present) {
    try {
      const count = countH2Headings(readFileSyncImpl(path.join(packageRoot, filename), 'utf8'));
      if (Math.abs(count - englishCount) > LOCALE_H2_TOLERANCE) {
        drift.push({ name: filename, count });
      }
    } catch {
      // unreadable locale — treat as drift so it surfaces in the report
      drift.push({ name: filename, count: -1 });
    }
  }

  if (drift.length === 0) {
    return createCheck(
      'readme_locale_parity',
      'README locale parity',
      'pass',
      `${present.join(', ')} match the English H2 count (${englishCount}).`,
    );
  }

  const driftDetail = drift
    .map((d) => `${d.name}=${d.count === -1 ? 'unreadable' : d.count}`)
    .join(', ');
  const detail = `H2 count drift (English=${englishCount}): ${driftDetail}`;
  return createCheck(
    'readme_locale_parity',
    'README locale parity',
    'warn',
    detail,
    `Re-sync the listed READMEs against README.md so section structure matches (±${LOCALE_H2_TOLERANCE} H2 tolerated to absorb translation collapse).`,
    { code: 'readme-parity.drift', params: { detail, tolerance: LOCALE_H2_TOLERANCE } },
  );
}

function resolveDatabasePath(): string {
  return getDbPath();
}

// A Node below the floor fails every database row the same way; the Database
// row says why, once, and the others point at it.
const NODE_TOO_OLD_FIX = `Upgrade Node to ${MIN_NODE_SERIES} or newer, then run \`memesh doctor\` again.`;
const NODE_TOO_OLD_SEE_DATABASE_ROW = 'Not checked: this Node cannot open the MeMesh database (the Database row above says why).';

/** Summary of a database row whose read threw. `detail` is the error's own text. */
function queryFailedSummary(err: unknown, detail: string, what: string, unknownMeans: string): string {
  if (isUnsupportedNode(err)) return NODE_TOO_OLD_SEE_DATABASE_ROW;
  return `Could not read ${what} from the database: ${withoutFinalPeriod(detail)}. ${unknownMeans}`;
}

/**
 * The database file is not there (yet). A diagnostic must not be the thing that creates it: a user who runs
 * `memesh doctor` before ever using MeMesh would otherwise get a database, a schema and its migrations as a side
 * effect of asking whether the install is healthy.
 */
export class NoDatabaseYetError extends Error {
  constructor(readonly databasePath: string) {
    super(`No database at ${databasePath} yet`);
    this.name = 'NoDatabaseYetError';
  }
}

/**
 * How doctor opens the database unless a test or caller supplies its own: only a database that already exists, and
 * read-only. No file is created, no schema is brought up to date, no migration or sweep runs. (The permission
 * hardening every opener does, taking group/other access off the files, still applies.)
 */
function openDatabaseForDoctor(dbPath?: string, opts: { busyTimeoutMs?: number } = {}): MemeshDatabase {
  const target = dbPath ?? getDbPath();
  if (!fs.existsSync(target)) throw new NoDatabaseYetError(target);
  return openDatabase(target, { ...opts, readOnly: true });
}

/** Read-only, a database whose schema is older than this version cannot be read by every check: it is behind, not broken. */
function isSchemaBehind(err: unknown): boolean {
  // An error that carries its own fix was raised on purpose by a check that already read the damage (the inbox's
  // missing column, a failed integrity check): that is broken, not behind, and keeps its own advice.
  if (typeof (err as { fix?: unknown } | null)?.fix === 'string') return false;
  return /no such (table|column)/i.test(err instanceof Error ? err.message : String(err));
}
/**
 * What to tell the user about a database that is behind this version's layout. Doctor opens it read-only and does not
 * migrate it; a memesh command does, so the usual advice is to run one. When the folder (or the database file) cannot
 * be written, that command would fail too, and the advice that works is the one that makes it writable, first.
 */
function schemaBehindNote(databasePath: string = getDbPath()): string {
  const base = 'The database was written by an older version and has not been brought up to date yet. Doctor opens it read-only and does not migrate it';
  const update = 'run any memesh command (for example `memesh recall x`) to update it, then run doctor again.';
  const folder = readOnlyFolderState();
  if (folder) return `${base}, and ${folder.reason}, so a memesh command could not update it either. First ${runOrSay(folder.fix).replace(/^Run: /, 'run: ')}; then ${update}`;
  let writeBack: string | undefined;
  try { writeBack = ownerWriteCommand(databasePath); } catch { writeBack = undefined; }
  if (writeBack) return `${base}, and the database file is read-only, so a memesh command could not update it either. First ${writeBack}; then ${update}`;
  return `${base}: ${update}`;
}

/**
 * A read-only database, folder or -wal/-shm is a permission question, not a
 * disk one (#520). MeMesh's own refusals carry their command as `fix`, the
 * same signal the Database row reads, so the rows agree.
 */
function queryFailedFix(err: unknown): string {
  if (isUnsupportedNode(err)) return NODE_TOO_OLD_FIX;
  const fix = (err as { fix?: unknown } | null)?.fix;
  if (typeof fix === 'string') {
    return `MeMesh did not open the database because of its permissions; the Database row above explains why. ${runOrSay(fix)}`;
  }
  const detail = err instanceof Error ? err.message : String(err);
  if (/readonly database|SQLITE_READONLY/i.test(detail)) {
    return 'The database is read-only; the Database row above shows the command that makes it writable again.';
  }
  if (/database is locked|SQLITE_BUSY/i.test(detail)) {
    return 'Another process has the database locked; wait for it to finish, or stop it, then retry.';
  }
  return 'The error is quoted above. Check that ~/.memesh is readable and that the disk is not full.';
}

/**
 * `ok`, or one line naming what SQLite's quick_check found (or the damage it
 * hit while looking). Any other error it raises — a held lock, an I/O error —
 * says nothing about the pages and is thrown as it is, for
 * `diagnoseDatabaseFailure` to name.
 */
function quickIntegrityVerdict(db: DatabaseLike): string {
  let row: { quick_check?: unknown } | undefined;
  try {
    row = db.prepare('PRAGMA quick_check(1)').get() as { quick_check?: unknown } | undefined;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!isDamagedDatabaseError(message)) throw err;
    return message.replace(/\s+/g, ' ').slice(0, 200);
  }
  if (typeof row?.quick_check !== 'string') return 'quick_check returned no verdict';
  return row.quick_check.replace(/\s+/g, ' ').slice(0, 200);
}

/** Where a transcript a hold record names may be, for doctor to read it: the Claude Code and Codex session folders. Anything else is not read. */
function knownTranscriptPath(file: string | undefined): string | undefined {
  if (typeof file !== 'string' || file === '') return undefined;
  let real: string;
  try { real = fs.realpathSync(file); } catch { return file; } // not there: decidePrivacy reads nothing and answers from the marker alone
  const roots = [
    path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homeDir(), '.claude'), 'projects'),
    ...['sessions', 'archived_sessions'].map((d) => path.join(process.env.CODEX_HOME || path.join(homeDir(), '.codex'), d)),
  ];
  for (const root of roots) {
    let realRoot: string;
    try { realRoot = fs.realpathSync(root); } catch { continue; }
    if (real.startsWith(realRoot + path.sep)) return real;
  }
  return undefined;
}

/** What to do about a Hermes private-session marker error: `install-hooks` does not touch the Hermes home. */
const HERMES_MARKER_FIX = 'Hermes could not keep or read its private-session marker. Check that the memesh-private-sessions folder in the Hermes home is a folder you can read and write, and that Hermes was started with a home folder. This row clears once five later Hermes captures have checked the marker without an error.';

/**
 * What to do about an error that is about memesh's private-session records
 * beside the database, not about the hooks: `install-hooks` touches neither,
 * and the transcript is not the problem.
 */
const PRIVATE_FOLDER_FIX = 'The private-sessions folder beside the database cannot be read, so every session is treated as private and nothing is saved. Make it a folder you can read and write again (for example `chmod u+rwx` on it); do not delete it: it is the record of the sessions that asked not to be remembered. This row clears once the hook\'s most recent runs end without an error.';
const PRIVATE_STATE_ERROR_FIXES: Readonly<Record<string, string>> = Object.freeze({
  [SKIP_REASONS.privateCheckMarkerUnreadable]: PRIVATE_FOLDER_FIX,
  [SKIP_REASONS.noteMarkersDirUnreadable]: PRIVATE_FOLDER_FIX,
});

/** Per session doctor may spend deciding again, and in all. */
const DOCTOR_PRIVACY_CHECK_MS = 2000;
const DOCTOR_PRIVACY_TOTAL_MS = 10_000;

/**
 * The private-session state, when there is something to say: records that
 * cannot be read (by file name, only as memesh names them), folders that wait
 * on a held note that could not be read, and sessions whose notes are held
 * because they could not be checked, with what the one check says about them
 * NOW. No text is taken from a record: reasons are codes mapped to fixed
 * sentences (R-I). Deleting a file is offered only as the last step, and
 * always with what it releases.
 */
export function inspectPrivateNoteHolds(now = Date.now()): DoctorCheck | null {
  const summary = summarizeNoteHolds(now);
  if (summary.unsettled.length === 0 && summary.damaged.length === 0 && summary.waitingOnUnreadable.length === 0 && summary.unreadableFolders.length === 0) return null;
  const lines: string[] = [];
  const fixes: string[] = [];
  for (const f of summary.unreadableFolders) {
    lines.push(`the ${f === 'holds' ? 'note-ingest-holds' : 'private-sessions'} folder cannot be read, so no note is imported and what it holds cannot be listed`);
    fixes.push(`Make ${f === 'holds' ? summary.holdsFolder : summary.markersFolder} a folder you can read and write again; do not delete it, it holds the private-session records.`);
  }
  for (const d of summary.damaged) {
    if (d.folder === 'holds') {
      lines.push(`the hold record ${d.file} cannot be read, so no note is imported`);
      fixes.push(`${d.file} in ${summary.holdsFolder} cannot be repaired by hand. Deleting it is the last step and releases the notes it holds: they then import as ordinary notes, so if that session was private its content is stored.`);
    } else {
      lines.push(`the private-session marker ${d.file} cannot be read, so no note is imported`);
      fixes.push(`The session ${d.file} belongs to rebuilds it at its next hook. Only if that session has ended, delete ${d.file} in ${summary.markersFolder}: the notes that session wrote are then imported.`);
    }
  }
  for (const w of summary.waitingOnUnreadable) {
    lines.push(`${w.notes} note(s) held by ${w.file} could not be read, so the folder they are in waits on every note changed since ${new Date(w.since).toISOString().slice(0, 10)}`);
    fixes.push('Make the notes folder and its files readable by you again; the wait ends at the next import that can read them.');
  }
  const deadline = Date.now() + DOCTOR_PRIVACY_TOTAL_MS;
  const memesh = getMemeshDirFromDbPath();
  for (const u of summary.unsettled) {
    let now2 = '';
    let settled = false;
    const transcript = knownTranscriptPath(u.transcript);
    if (u.transcript !== undefined && transcript === undefined) {
      now2 = 'the record names a transcript outside the known folders, so it is not read';
    } else if (Date.now() < deadline) {
      const state = decidePrivacy({ sessionId: u.session.replace(/\.json$/, ''), transcriptPath: transcript, memeshDir: memesh, deadlineAt: Math.min(deadline, Date.now() + DOCTOR_PRIVACY_CHECK_MS), cacheDir: path.join(memesh, 'private-check-cache') });
      settled = state.state !== 'unchecked';
      now2 = state.state === 'no' ? 'it can be checked now and is not private: the next import releases them'
        : state.state === 'yes' ? 'it is private: the next import holds them for good'
          : 'it still cannot be checked';
    }
    lines.push(`${u.notes} note(s) of ${u.file} are held because the session could not be checked (${u.reasonText}; held since ${new Date(u.since).toISOString().slice(0, 10)})${now2 ? `; ${now2}` : ''}`);
    if (settled) {
      // Nothing to do: the next import settles it.
    } else if (u.kind === 'persistent') {
      fixes.push(`This reason does not pass on its own. To release the notes anyway, delete ${u.file} in ${summary.holdsFolder}: they then import as ordinary notes, so if the session was private its content is stored.`);
    } else {
      fixes.push('This reason can pass on its own: the session is checked again at every import and its notes are let through once it can be checked and is not private.');
    }
  }
  const notes = summary.unsettled.reduce((n, u) => n + u.notes, 0);
  return createCheck('private-note-holds', 'Notes kept out of memory', 'warn',
    `${lines.join('; ')}.`,
    [...new Set(fixes)].join(' '),
    { params: { sessions: summary.unsettled.length, notes } });
}

function createCheck(
  id: string,
  label: string,
  status: DoctorCheckStatus,
  summary: string,
  fix?: string,
  // `code` is optional: a PASS row may carry machine-readable params (e.g.
  // hook-wiring's captureWired, consumed by runDoctor) without claiming a
  // catalogue entry — the i18n scan only covers codes, which is correct,
  // because codeless params never render through a locale template.
  i18n?: { code?: string; params?: Record<string, string | number> },
  fixId?: DoctorCheck['fixId'],
): DoctorCheck {
  return { id, label, status, summary, fix, code: i18n?.code, params: i18n?.params, fixId };
}

/**
 * Build a row that REPORTS state instead of asserting it.
 *
 * Use this whenever the row cannot fail. It is excluded from `Overall`, so
 * it can never inflate a green verdict. If you find yourself wanting to
 * write `createCheck(..., 'pass', ...)` with a literal status at the top
 * level of `runDoctor` — i.e. with no branch that could produce 'fail' —
 * that row is informational, not a check. Use this instead.
 */
function createInfo(id: string, label: string, summary: string, fix?: string): DoctorCheck {
  return { id, label, status: 'pass', summary, fix, informational: true };
}

/**
 * A deliberately read-only operator row. The table probe keeps old databases
 * and narrow doctor-test doubles on their established output contract.
 */
function inspectAgentMessageStorage(
  db: MemeshDatabase,
  databasePath: string,
  policy: DoctorOptions['agentMessageStoragePolicy'],
): DoctorCheck | undefined {
  try {
    const present = db.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'agent_messages'",
    ).get() as { present?: number } | undefined;
    if (!present?.present) return undefined;

    const report = getAgentMessageStorageReport(db, { databasePath });
    const quota = policy?.storage_quota_bytes;
    const invalidQuota = quota !== undefined && (!Number.isSafeInteger(quota) || quota < 0);
    const quotaText = quota === undefined
      ? 'quota not configured'
      : !invalidQuota
        ? `quota ${formatStorageBytes(quota)} (${formatStorageBytes(report.payload_bytes)} logical payload used)`
        : 'configured quota is invalid';
    const retentionText = report.expired_pending_message_count === 0
      ? 'messages are kept one day, then deleted'
      : `messages are kept one day, then deleted; ${report.expired_pending_message_count} past that are waiting for the next expiry pass`;
    const walText = report.wal_file_bytes === null
      ? 'WAL size unavailable'
      : `WAL ${formatStorageBytes(report.wal_file_bytes)}`;
    const databaseText = report.database_file_bytes === null
      ? 'database file size unavailable'
      : `database file ${formatStorageBytes(report.database_file_bytes)}`;

    const summary =
      `${report.message_count} message(s), ${formatStorageBytes(report.payload_bytes)} logical payload `
      + `(${report.protected_unresolved_message_count} unresolved/protected); ${formatStorageBytes(report.reusable_freelist_bytes)} `
      + `SQLite freelist reusable; ${databaseText}; ${walText}; ${quotaText}; ${retentionText}. `
      + 'Doctor only read this state: it did not delete messages, checkpoint WAL, or run VACUUM.';

    if (invalidQuota) {
      return createCheck(
        'agent_message_storage',
        'Agent message storage',
        'warn',
        `${summary} Send enforcement rejects this quota configuration; use a canonical non-negative safe decimal integer.`,
        `Set ${AGENT_MESSAGE_STORAGE_QUOTA_ENV} to 0 or a positive decimal integer within the safe integer range, then re-run memesh doctor.`,
      );
    }

    return createInfo(
      'agent_message_storage',
      'Agent message storage',
      summary,
    );
  } catch {
    // This diagnostic must not turn a healthy database row into a duplicate
    // database failure merely because a pre-message schema cannot report it.
    return undefined;
  }
}

/**
 * The one-day message expiry (core/agent-message-expiry.ts): when the last pass
 * ran, what it did, and whether it is keeping up. Read-only. A pass records
 * itself even when it deletes nothing, so "no row" means none has run on this
 * database, not that one ran and said nothing.
 */
function inspectAgentMessageExpiry(db: MemeshDatabase, nowMs: number = Date.now()): DoctorCheck | undefined {
  try {
    const present = db.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('agent_messages', 'agent_message_expiry_runs')",
    ).get() as { n?: number } | undefined;
    if (present?.n !== 2) return undefined;
    const warn = (summary: string, fix: string): DoctorCheck => createCheck('agent_message_expiry', 'Agent message expiry', 'warn', summary, fix);
    const info = (summary: string): DoctorCheck => createInfo('agent_message_expiry', 'Agent message expiry', summary);

    const waiting = getAgentMessageStorageReport(db, {}).expired_pending_message_count;
    const how = 'It runs by itself while the MeMesh router, MCP server or memesh serve is running; start a MeMesh session and re-run memesh doctor.';
    const locked = 'another program may be keeping the database locked, so each pass gave up rather than wait. '
      + 'Close other programs that hold the database open (a sqlite3 shell, a sync or backup tool); if messages still wait five minutes later, re-run memesh doctor.';
    // The pass records itself, and a database file this user cannot write cannot even record that:
    // so doctor looks at the file itself rather than wait for a row that can never be written.
    const file = databaseFile(db);
    if (file !== '') {
      try {
        fs.accessSync(file, fs.constants.W_OK);
      } catch {
        // The same command the database check gives: quoted, and covering a -wal/-shm that lost its write bit too.
        // None when every write bit is already set: a chmod would change nothing.
        const writeBack = ownerWriteCommand(file)
          ?? 'its write bit is already set, so something else refuses the write: an ACL, a read-only mount or a locked file';
        return warn(
          `The database file ${file} cannot be written by this user, so the one-day expiry cannot delete anything (messages past their day are hidden but stay on disk).`,
          `Make the database writable (${writeBack}), then re-run memesh doctor.`);
      }
    }
    // A pass that wrote its row ("started") and has not finished: still working, or stopped.
    const stuck = db.prepare(
      "SELECT started_at_ms, expired_message_count, backup_path FROM agent_message_expiry_runs WHERE outcome = 'started' ORDER BY run_id DESC LIMIT 1",
    ).get() as { started_at_ms: number; expired_message_count: number; backup_path: string | null } | undefined;
    const ago = (ms: number): string => (ms < 90_000 ? 'under a minute ago'
      : ms < 90 * 60_000 ? `${Math.round(ms / 60_000)} minute(s) ago`
        : `${Math.round(ms / 3_600_000 * 10) / 10} hour(s) ago`);
    const last = lastAgentMessageExpiryRun(db);
    const finishedCheck = (): DoctorCheck => {
      if (!last) {
        // A pass that meets a lock gives up rather than hold its process, and when even its row cannot be
        // written there is no row: so "none on record" also means a database some other program keeps locked.
        const noRun = `Either no MeMesh router, MCP server or memesh serve has run while messages were waiting, or ${locked}`;
        return waiting > 0
          ? warn(
            `No expiry pass has run on this database, and ${waiting} message(s) are past their one day. ${noRun}`, noRun)
          : info(`No expiry pass has run yet. Messages are kept one day, then deleted. ${how}`);
      }
      const did = `${last.expired_message_count} message(s) deleted (${last.unread_message_count} with no intake, acknowledgement, disposition or reply; ${last.notice_count} sender notice(s)), `
        + `${last.presence_fact_count} presence fact(s) and ${last.connection_count} connection(s) cleared`;
      const latestArchive = latestAgentMessageExpiryArchive(db);
      const archive = latestArchive ? inspectAgentMessageArchive(db, latestArchive) : undefined;
      const backup = !latestArchive || !archive ? ''
        : archive.kind === 'missing' ? ` The archive of deleted messages, ${latestArchive}, is not there any more.`
          : archive.kind === 'unusable' ? ` The archive of deleted messages, ${latestArchive}, cannot be used: ${archive.reason}.`
            : archive.kind === 'busy' ? ` The archive of deleted messages, ${latestArchive}, is in use by another process right now, so what it holds is not shown.`
            : archive.messages > 0 ? ` Deleted messages are kept one more day in ${latestArchive} (${archive.messages} there now).`
              : ` The archive ${latestArchive} holds no deleted message now (each is kept there one more day after it is deleted).`;
      const summary = `Last pass ${ago(nowMs - last.finished_at_ms)} (${last.outcome}, started by ${last.trigger_source}): ${did}.${backup}${last.detail ? ` ${last.detail}.` : ''}`;
      const archiveFix = latestArchive
        ? `for the archive ${latestArchive}: free disk space, give the owner read and write access to it and to its folder, or move it away if it is not a MeMesh archive`
        : 'for the archive: free disk space or permissions on the backups folder next to the database';
      if (AGENT_MESSAGE_EXPIRY_FAILED_OUTCOMES.has(last.outcome)) {
        return warn(summary,
          `Nothing more is deleted while this fails. Read the detail above, fix it (${archiveFix}; for a read-only database: make it writable), then re-run memesh doctor.`);
      }
      if (archive?.kind === 'unusable') {
        return warn(summary,
          `The next pass that has messages to delete cannot copy them, so it deletes nothing. Fix it (${archiveFix}), then re-run memesh doctor.`);
      }
      // Behind means no pass has done its work for a while. A pass that met a lock did no work, so a run
      // of them, or of passes that left no row at all, does not count as keeping up.
      const lastSuccess = (db.prepare(`
        SELECT MAX(finished_at_ms) AS at FROM agent_message_expiry_runs
        WHERE outcome IN (${[...AGENT_MESSAGE_EXPIRY_DONE_OUTCOMES].map((o) => `'${o}'`).join(', ')})
      `).get() as { at: number | null }).at;
      if (waiting > 0 && (lastSuccess === null || nowMs - lastSuccess > 2 * AGENT_MESSAGE_EXPIRY_INTERVAL_MS)) {
        const since = lastSuccess === null ? 'no pass has done its work yet' : `the last pass that did its work finished ${ago(nowMs - lastSuccess)}`;
        const why = last.outcome === 'database_busy' ? `The last pass met a lock: ${locked}` : how;
        return warn(
          `${summary} ${waiting} message(s) are past their one day and ${since}. ${why}`, why);
      }
      return info(summary);
    };
    if (!stuck) return finishedCheck();
    const sinceMs = nowMs - stuck.started_at_ms;
    const old = sinceMs > 10 * 60_000;
    const unfinished = `A pass started ${ago(sinceMs)} and has not finished`
      + (old ? ' (the process running it was probably stopped)' : ' (it is still working, or it was stopped a moment ago)')
      + `; it had deleted ${stuck.expired_message_count} message(s) when it last saved its count`
      + (stuck.backup_path && fs.existsSync(stuck.backup_path) ? `, and those are in ${stuck.backup_path}` : '')
      + '. If it was stopped, the next pass takes over once its lease runs out (at most three minutes after its last batch), closes it as interrupted and carries on.';
    // Whatever the last finished pass said still counts: a stopped pass must not hide a failure behind it.
    if (!last) {
      return old
        ? warn(unfinished, how)
        : info(unfinished);
    }
    const before = finishedCheck();
    return old || before.status !== 'pass'
      ? warn(`${unfinished} ${before.summary}`, before.fix ?? how)
      : info(`${unfinished} ${before.summary}`);
  } catch {
    return undefined;
  }
}

/** Does this release receipt's detail say the app-server daemon was missing? */
function noDaemonReason(detailJson: string): boolean {
  try {
    return (JSON.parse(detailJson) as { detail?: { reason?: unknown } } | null)?.detail?.reason === 'no_daemon';
  } catch {
    return false; // Malformed detail_json is not this check's problem to diagnose.
  }
}

/**
 * The Codex stuck-message release (#468, `watchCodexQueueRelease` in
 * codex-cli-queue.ts) only works when Codex is running its app-server
 * daemon. An ordinary `codex` CLI session — or any session started with
 * `--no-daemon` — has no daemon for the router to ask, so the release
 * records a `host_activation` receipt with `host_activation: 'unsupported'`
 * and `detail.reason: 'no_daemon'` instead of starting the queued message.
 * A message left in that thread's queue after an interrupted turn then
 * stays queued until the next prompt, and nothing else surfaces that (#491).
 *
 * Read-only, same shape as `inspectAgentMessageStorage` immediately above:
 * a raw `db.prepare` probe, `undefined` (not a row) when the table predates
 * the message schema, and no `code:` — `inspectAgentMessageStorage`'s own
 * `'warn'` branch a few lines up ships the same way, and adding one here
 * would need a translated catalogue entry in all 11 dashboard locales for a
 * server-diagnostic sentence (see DoctorBanner's sanctioned English
 * fallback for an uncoded row).
 */
function inspectCodexQueueDaemon(db: MemeshDatabase): DoctorCheck | undefined {
  try {
    const present = db.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'agent_message_receipts'",
    ).get() as { present?: number } | undefined;
    if (!present?.present) return undefined;

    // Only the receipts the Codex release itself writes: any agent can record
    // a host_activation receipt through the public `activation` action, and an
    // `unsupported` from one of those says nothing about Codex's daemon.
    const rows = db.prepare(`
      SELECT project, recipient, detail_json, created_at FROM agent_message_receipts
      WHERE receipt_kind = 'host_activation'
        AND actor = 'memesh-router'
        AND idempotency_key LIKE 'codex-queue-release-%'
        AND created_at > datetime('now', '-7 days')
      ORDER BY created_at DESC, rowid DESC
    `).all() as Array<{ project: string; recipient: string; detail_json: string; created_at: string }>;

    if (rows.length === 0) {
      return createInfo(
        'codex-queue-daemon',
        'Codex stuck-message release',
        'No Codex host_activation receipts in the last 7 days. The Codex stuck-message release has not run recently, so its app-server-daemon dependency has not been exercised either way.',
      );
    }

    // The newest receipt per thread decides: a thread whose daemon has come
    // back since, and whose release then ran, has nothing stuck.
    const latestPerThread = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const key = `${row.project}\u0000${row.recipient}`;
      if (!latestPerThread.has(key)) latestPerThread.set(key, row);
    }
    const stuck = [...latestPerThread.values()].filter((row) => noDaemonReason(row.detail_json));

    if (stuck.length === 0) {
      return createInfo(
        'codex-queue-daemon',
        'Codex stuck-message release',
        `${latestPerThread.size} Codex thread(s) ran the stuck-message release in the last 7 days; the latest run in each found the app-server daemon. Nothing is waiting on it.`,
      );
    }

    // Every stuck thread is named: the fix below asks for a prompt in each.
    const named = stuck
      .map((row) => `${row.recipient} in ${row.project} (${sqliteUtcToIso(row.created_at)})`)
      .join(', ');
    return createCheck(
      'codex-queue-daemon',
      'Codex stuck-message release',
      'warn',
      `${stuck.length} Codex thread(s) last ran the stuck-message release without the app-server daemon: ${named}. A MeMesh message queued there after an interrupted turn stays in that thread's queue until you send the thread a prompt.`,
      'Send a prompt in each thread named above to drain its queue. To restore the automatic release, run Codex with its app-server daemon (avoid `--no-daemon`).',
    );
  } catch (err) {
    // A failure here, the table probe included, is a real one: say so rather
    // than leave the row out, which would read as "fine".
    return createCheck(
      'codex-queue-daemon',
      'Codex stuck-message release',
      'warn',
      `Could not read the Codex host_activation receipts: ${err instanceof Error ? err.message : String(err)}`,
      'Run `memesh doctor` again; if this persists, check the database rows above for the underlying error.',
    );
  }
}

/**
 * Messages whose latest notice attempt (the one with the highest attempt number for its delivery) ended with
 * one of `codes` and that nothing has since settled: no host accept, and no intake, ack or disposition from
 * the agent. A message whose earlier attempt failed one way and whose latest failed another is counted only
 * under the latest. Counts messages, not attempts, and only those whose latest attempt is from the newest
 * seven days. A message has exactly one delivery, which is why the receipt join matches on the delivery's
 * own message, project and recipient. Undefined when the table does not exist yet.
 */
function countUnsettledNotices(db: MemeshDatabase, codes: readonly string[]): number | undefined {
  const present = db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'agent_dispatch_attempts'",
  ).get() as { present?: number } | undefined;
  if (!present?.present) return undefined;
  const row = db.prepare(`
    SELECT COUNT(DISTINCT a.delivery_id) AS unsettled
    FROM agent_dispatch_attempts a
    WHERE a.failure_code IN (${codes.map(() => '?').join(', ')})
      AND a.created_at > datetime('now', '-7 days')
      AND a.attempt_number = (
        SELECT MAX(l.attempt_number) FROM agent_dispatch_attempts l WHERE l.delivery_id = a.delivery_id
      )
      AND NOT EXISTS (SELECT 1 FROM agent_host_accepts h WHERE h.delivery_id = a.delivery_id)
      AND NOT EXISTS (
        SELECT 1 FROM agent_message_deliveries d JOIN agent_message_receipts r
          ON r.message_id = d.message_id AND r.project = d.project AND r.recipient = d.recipient
        WHERE d.delivery_id = a.delivery_id AND r.receipt_kind IN ${HANDLED_RECEIPT_KINDS_SQL}
      )
  `).get(...codes) as { unsettled?: number } | undefined;
  const count = Number(row?.unsettled);
  return count > 0 ? count : undefined;
}

/**
 * The notice reached a Claude Code session's socket but not its conversation: Claude Code holds a peer
 * message for its user in several cases (for example when the sender does not state its permission mode
 * and the receiving session bypasses permission prompts), recorded as `notice_held` when its "Held peer
 * message" line was seen and as `notice_not_confirmed` when nothing was. The message itself stays in the
 * inbox and is raised at the session's next prompt or turn end; this row says why the live notice did not
 * arrive. A notice held for a message the agent never answers is sent again each time the host is started
 * afresh (a new MCP process), since the record of the hold lives only in the process that saw it. Names no
 * project: doctor rows are copied into public issues.
 */
function inspectHeldNotices(db: MemeshDatabase): DoctorCheck | undefined {
  const found = countNoticeFailures(db, ['notice_not_confirmed', 'notice_held']);
  if (found === undefined) return undefined;
  if (typeof found !== 'number') {
    return createCheck('held-notices', 'Message notices not shown to Claude', 'warn', found.unreadable, UNREADABLE_ATTEMPTS_FIX);
  }
  return createCheck(
    'held-notices',
    'Message notices not shown to Claude',
    'warn',
    `${found} message(s) in the last 7 days reached a Claude Code session's socket but their notice never showed up in its conversation. Possible causes: Claude Code is holding the notice for its user to approve or deny (for example when the sender does not state a permission mode and that session bypasses permission prompts, or when the two sessions' permission modes differ), the session was busy or has stopped, or it dropped the notice. MeMesh cannot tell these apart, and cannot see whether the user denied a held notice. The messages are safe in the inbox and are raised at the session's next prompt or turn end.`,
    'To get the live notice, set "crossSessionInbound" to "accept" in that Claude Code session\'s settings, or install the MeMesh Channel. Otherwise the message appears at the next prompt.',
  );
}

/**
 * MeMesh could not read the Claude Code session's conversation record (`transcript_unavailable`: there is no
 * project folder to look in or the record is not readable; `transcript_not_found`: the session wrote none), so
 * it could not tell whether a notice arrived. Without this row such a failure would show nothing at all.
 */
function inspectUnreadableTranscripts(db: MemeshDatabase): DoctorCheck | undefined {
  const found = countNoticeFailures(db, ['transcript_unavailable', 'transcript_not_found']);
  if (found === undefined) return undefined;
  if (typeof found !== 'number') {
    return createCheck('unreadable-transcripts', 'Claude Code conversation record not readable', 'warn', found.unreadable, UNREADABLE_ATTEMPTS_FIX);
  }
  return createCheck(
    'unreadable-transcripts',
    'Claude Code conversation record not readable',
    'warn',
    `${found} message(s) in the last 7 days could not be checked: MeMesh could not read the Claude Code session's conversation record, so it could not tell whether the notice arrived. The messages are safe in the inbox and are raised at the session's next prompt or turn end.`,
    'Check that CLAUDE_CONFIG_DIR (when you set it) points at the folder Claude Code writes its conversation records to, and that the MeMesh MCP server is started from the project (MEMESH_PROJECT_ROOT or CLAUDE_PROJECT_DIR set, or a single workspace root). Then start a new Claude Code session.',
  );
}

const UNREADABLE_ATTEMPTS_FIX = 'Run `memesh doctor` again; if this persists, check the database rows above for the underlying error.';

/** The number of messages to report, undefined when there is nothing to say, or the reason the attempts could not be read. */
function countNoticeFailures(db: MemeshDatabase, codes: readonly string[]): number | { unreadable: string } | undefined {
  try {
    return countUnsettledNotices(db, codes);
  } catch (err) {
    return { unreadable: `Could not read the message dispatch attempts: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * #408: memories under a plain project name that shares its readable name
 * with a project id in the same graph. Sessions resolve the id, so those
 * memories never reach them. Absent when there is no split.
 *
 * The row names no project, in its summary or its fix: doctor rows are copied
 * into the prefilled public issue of `memesh feedback` and the dashboard, and
 * a project name can be an account or a private repository name. The fix
 * points at `memesh kg rename-project`, which lists the names on the user's
 * own machine. A shared name does not prove one project — an old plain name
 * may have mixed several repositories — so the move is the user's call. A
 * failure reading the tags is a warning of its own, never a failed database
 * row.
 */
function inspectProjectIdentitySplit(db: MemeshDatabase): DoctorCheck | undefined {
  let splits: ProjectIdentitySplit[];
  try {
    splits = findProjectIdentitySplits(db);
  } catch (err) {
    return createCheck(
      'project-identity-split',
      'Project tags',
      'warn',
      `The project tag check could not run (${err instanceof Error ? err.message : String(err)}), so a project split is not ruled out.`,
      'Run `memesh kg rename-project` to list every project tag.',
    );
  }
  if (splits.length === 0) return undefined;
  const total = splits.reduce((sum, split) => sum + split.activeMemories, 0);
  return createCheck(
    'project-identity-split',
    'Project tags',
    'warn',
    `${total} active ${total === 1 ? 'memory' : 'memories'} in ${splits.length} ${splits.length === 1 ? 'project is' : 'projects are'} `
      + "filed under a plain project name (project:<name>) that the project's sessions never read; they use the full id (project:<name>~<hash>).",
    'Run `memesh kg rename-project` to list every project tag with its count. For a plain name listed next to an id of the same name, '
      + 'kg rename-project --from <name> --to <id> previews moving its memories to that id, and the same command with --apply moves them '
      + '(it backs the database up first). A shared name does not prove one project: if a different repository used that name, leave it.',
  );
}

/**
 * Report how ordinary Codex sessions choose their local routing identity.
 * A plugin cache copy is only evidence of cached source; live discovery is
 * still the authoritative proof that Codex enabled the plugin and its
 * SessionStart companion registered this thread.
 */
function inspectCodexSessionSetup(
  codexPluginCacheDetected: boolean,
  existsSyncImpl: typeof fs.existsSync,
): DoctorCheck | null {
  if (!codexPluginCacheDetected) return null;

  const configPath = path.join(getMemeshDirFromDbPath(), 'hosts', 'codex-session.json');
  if (existsSyncImpl(configPath)) {
    return createInfo(
      'codex-session-setup',
      'Codex ordinary-session notifications',
      'A Codex identity override file is present and will be validated at SessionStart. A valid override applies only in its configured workspace; other Codex plugin sessions use automatic thread-scoped identities. A cached plugin copy does not prove a live registration; use `memesh message discover --project <project>` to read current presence.',
    );
  }

  return createInfo(
    'codex-session-setup',
    'Codex ordinary-session notifications',
    'No explicit identity override is configured. When the Codex plugin is enabled, each startup or resumed thread registers automatically under a thread-scoped identity. A cached plugin copy does not prove a live registration; use `memesh message discover --project <project>` to read current presence.',
  );
}

function configuredAgentMessageStoragePolicy(
  explicit: DoctorOptions['agentMessageStoragePolicy'],
): DoctorOptions['agentMessageStoragePolicy'] {
  if (explicit !== undefined) return explicit;
  const quotaRaw = process.env[AGENT_MESSAGE_STORAGE_QUOTA_ENV];
  if (quotaRaw === undefined || quotaRaw === '') return undefined;
  // Keep this predicate byte-for-byte aligned with send enforcement in
  // transports/agent-messaging.ts. Number(raw) alone accepts exponent notation,
  // whitespace, signs, decimals, and values outside Number's safe range.
  if (!/^(0|[1-9][0-9]*)$/.test(quotaRaw)) {
    return { storage_quota_bytes: Number.NaN };
  }
  const parsed = Number(quotaRaw);
  return { storage_quota_bytes: Number.isSafeInteger(parsed) ? parsed : Number.NaN };
}

function formatStorageBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return 'unknown size';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function parseJsonFile(
  filePath: string,
  readFileSyncImpl: typeof fs.readFileSync,
): { ok: true; value: JsonObject } | { ok: false; error: string } {
  try {
    const raw = readFileSyncImpl(filePath, 'utf8');
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object') {
      return { ok: false, error: 'JSON root must be an object.' };
    }
    return { ok: true, value: value as JsonObject };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'unknown parse error',
    };
  }
}

/**
 * Is `~/.memesh/config.json` present, parseable, and an object?
 *
 * ONE row for one file. This used to be two rows (`config` here and a later
 * `config_parse`) that both read + parsed the same file and both failed on
 * invalid JSON — two IDs, two i18n families and two fix strings to keep
 * aligned for one fact. Merged keeping this row's id (pinned by tests) and
 * the stricter checks: `readConfig()` returns `{}` on ANY read failure —
 * corrupt JSON, a half-written file, EACCES, an array root — so every
 * stored setting degrades to a silent no-op; this row makes that state visible.
 */
function inspectConfigFile(
  existsSyncImpl: typeof fs.existsSync,
  readFileSyncImpl: typeof fs.readFileSync,
  getConfigPathImpl: typeof getConfigPath,
): DoctorCheck {
  const configPath = getConfigPathImpl();
  if (!existsSyncImpl(configPath)) {
    return createCheck('config', 'Config', 'pass', `No config file yet (${configPath}); default settings are in effect.`, 'Optional: run memesh config list to inspect settings.');
  }

  try {
    const raw = readFileSyncImpl(configPath, 'utf8') as string;
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return createCheck(
        'config',
        'Config',
        'fail',
        `${configPath} parsed but is not a JSON object — every setting is being ignored.`,
        `Fix or remove ${configPath}, then re-run memesh doctor.`,
        { code: 'config-parse.not-object', params: { path: configPath } },
      );
    }
    const retiredKeys = findRetiredConfigKeys(parsed);
    if (retiredKeys.length > 0) {
      const keys = retiredKeys.join(', ');
      return createCheck(
        'config',
        'Config',
        'warn',
        `${configPath} is valid JSON but still contains ${retiredKeys.length} retired top-level setting(s) (${keys}). ` +
          'This version ignores them, but legacy provider credentials or settings may remain on disk.',
        `Review ${configPath} locally and remove only those retired top-level keys. ` +
          'Do not paste the file into an issue because it may contain credentials. Then run memesh doctor again.',
        {
          code: 'config-parse.retired-settings',
          params: { path: configPath, count: retiredKeys.length, keys },
        },
        'config-retired-settings',
      );
    }
    return createCheck('config', 'Config', 'pass', `${configPath} is valid JSON and its settings are in effect.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return createCheck(
      'config',
      'Config',
      'fail',
      `${configPath} could not be read or parsed (${msg}). Its settings are being ignored right now.`,
      `Fix the JSON or remove the file to fall back to defaults: mv ${shellQuote(configPath)} ${shellQuote(`${configPath}.bak`)}`,
      { code: 'config-parse.unreadable', params: { path: configPath, detail: msg } },
    );
  }
}

const MCP_PLACEHOLDER = '${CLAUDE_PLUGIN_ROOT}';

/**
 * Where the Claude plugin declares its MCP manifest, relative to the package
 * root — read from `.claude-plugin/plugin.json`, never hardcoded.
 *
 * Hardcoding it would recreate the defect this function exists to catch: a
 * hand-written path that stopped matching the manifest. `scripts/lib/
 * executable-targets.mjs` derives the same path for the packaged-artifact
 * gate, and for the same reason.
 *
 * Returns null when the manifest declares no usable path. That is not a
 * cosmetic omission: with no `mcpServers` field Claude Code falls back to
 * auto-discovering `.mcp.json` at the plugin root — which is ALSO the
 * project-scoped path it auto-discovers for anyone who merely opens the
 * directory, and `${CLAUDE_PLUGIN_ROOT}` is undefined there.
 */
function declaredMcpManifest(
  packageRoot: string,
  readFileSyncImpl: typeof fs.readFileSync,
): string | null {
  const parsed = parseJsonFile(path.join(packageRoot, '.claude-plugin', 'plugin.json'), readFileSyncImpl);
  if (!parsed.ok) return null;
  const declared = parsed.value.mcpServers;
  if (typeof declared !== 'string' || !declared.startsWith('./')) return null;
  return declared.slice(2);
}

function inspectMcpConfig(
  packageRoot: string,
  installChannel: InstallChannel,
  existsSyncImpl: typeof fs.existsSync,
  readFileSyncImpl: typeof fs.readFileSync,
  env: NodeJS.ProcessEnv,
): DoctorCheck {
  const relativeManifest = declaredMcpManifest(packageRoot, readFileSyncImpl);
  if (relativeManifest === null) {
    return createCheck(
      'mcp-config',
      'MCP config',
      'fail',
      '.claude-plugin/plugin.json declares no `mcpServers` path, so Claude Code has no MeMesh MCP server to start.',
      'Reinstall MeMesh so the plugin manifest and the MCP manifest it names are both restored.',
      { code: 'mcp-config.missing' },
    );
  }
  // `label` is always this — the `?? fallback` this replaced could never
  // fire: `mcpPath === null` only when `relativeManifest === null`, and that
  // case returns above before `label` is ever read.
  const label = relativeManifest;
  const mcpPath = path.join(packageRoot, relativeManifest);

  if (!existsSyncImpl(mcpPath)) {
    return createCheck(
      'mcp-config',
      'MCP config',
      'fail',
      `${label} is missing.`,
      'Reinstall MeMesh so the plugin manifest and the MCP manifest it names are both restored.',
      { code: 'mcp-config.missing' },
    );
  }

  const parsed = parseJsonFile(mcpPath, readFileSyncImpl);
  if (!parsed.ok) {
    return createCheck(
      'mcp-config',
      'MCP config',
      'fail',
      `${label} is not valid JSON.`,
      `Fix ${mcpPath} so Claude Code can read the MCP server definition.`,
      { code: 'mcp-config.invalid-json', params: { path: mcpPath } },
    );
  }

  const server = (parsed.value.mcpServers as JsonObject | undefined)?.memesh as JsonObject | undefined;
  if (!server || typeof server.command !== 'string') {
    return createCheck(
      'mcp-config',
      'MCP config',
      'fail',
      `${label} does not define a usable \`memesh\` MCP server entry.`,
      `Reinstall MeMesh or restore the \`mcpServers.memesh\` entry in \`${label}\`.`,
      { code: 'mcp-config.no-entry' },
    );
  }

  // Does the script it points at exist?
  //
  // This check used to stop at "there is a string `command`", which made it
  // structurally unable to notice the one way this file actually breaks. When
  // the MCP entry point was renamed, the manifest kept pointing at the old path
  // and every MCP tool died with `-32000 failed to reconnect` — while doctor
  // reported PASS, because the entry was still well-formed. A config that names
  // a file that is not there is not a valid config.
  const args = Array.isArray(server.args) ? server.args : [];
  const entry = typeof args[0] === 'string' ? args[0] : null;
  if (entry) {
    // WHO substitutes ${CLAUDE_PLUGIN_ROOT}, and does it happen here?
    //
    // This used to substitute `packageRoot` unconditionally, with a comment
    // asserting that "Claude Code substitutes that variable with this package
    // root". That is true only on `plugin-marketplace`. On every other channel
    // the substitution was self-fulfilling — it rebuilt a path that exists by
    // construction — so the check could not fail, and a manifest whose
    // placeholder nothing resolves sat behind a green row for three and a half
    // months. Substitute only where something really does substitute.
    const pluginRoot =
      installChannel === 'plugin-marketplace' ? packageRoot : (env.CLAUDE_PLUGIN_ROOT || null);

    if (entry.includes(MCP_PLACEHOLDER) && pluginRoot === null) {
      // Not a failure of this install: on a source checkout or an npm install
      // the plugin manifest is not the wiring in use, so there is no plugin
      // root to resolve against and nothing is broken. It IS a limit on what
      // this row may claim — saying "the script it starts exists" here is the
      // sentence that hid the original defect.
      return createCheck(
        'mcp-config',
        'MCP config',
        'warn',
        `${label} starts \`${entry}\`. NOT VERIFIED: \`${MCP_PLACEHOLDER}\` is substituted by the Claude Code plugin runtime, and this is a ${installChannel} install with CLAUDE_PLUGIN_ROOT unset — so the file it names was not checked.`,
        `Verify it the way the plugin runtime would: CLAUDE_PLUGIN_ROOT=${shellQuote(packageRoot)} memesh doctor`,
        { code: 'mcp-config.placeholder-unresolved', params: { entry, channel: installChannel } },
      );
    }

    const resolved = pluginRoot === null
      ? path.resolve(packageRoot, entry)
      : path.resolve(entry.replaceAll(MCP_PLACEHOLDER, pluginRoot));
    if (!existsSyncImpl(resolved)) {
      return createCheck(
        'mcp-config',
        'MCP config',
        'fail',
        `${label} starts \`${entry}\`, and that file is not in this install — so every memesh MCP tool fails to start.`,
        `Reinstall MeMesh; if you edited \`${label}\` by hand, point it back at \`${MCP_PLACEHOLDER}/dist/mcp/server.js\`.`,
        { code: 'mcp-config.entry-missing', params: { entry, resolved } },
      );
    }
  }

  return createCheck(
    'mcp-config',
    'MCP config',
    'pass',
    `${label} is present, defines the memesh MCP server, and the script it starts exists.`,
  );
}

function extractHookScriptPaths(hooksConfig: JsonObject, packageRoot: string): string[] {
  const hooks = hooksConfig.hooks as Record<string, Array<{ hooks?: Array<{ command?: string }> }>> | undefined;
  if (!hooks) return [];

  const scripts = new Set<string>();
  for (const entries of Object.values(hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!Array.isArray(entry.hooks)) continue;
      for (const hook of entry.hooks) {
        if (typeof hook.command !== 'string') continue;
        const command = hook.command.replace('${CLAUDE_PLUGIN_ROOT}/', '');
        scripts.add(path.join(packageRoot, command));
      }
    }
  }
  return Array.from(scripts).sort();
}

function inspectHooksConfig(
  packageRoot: string,
  platform: NodeJS.Platform,
  existsSyncImpl: typeof fs.existsSync,
  readFileSyncImpl: typeof fs.readFileSync,
  statSyncImpl: typeof fs.statSync,
): DoctorCheck[] {
  const hooksPath = path.join(packageRoot, 'hooks', 'hooks.json');
  if (!existsSyncImpl(hooksPath)) {
    return [
      createCheck(
        'hooks-config',
        'Hooks config',
        'fail',
        'hooks/hooks.json is missing.',
        'Restore `hooks/hooks.json` from the package or reinstall MeMesh.',
        { code: 'hooks-config.missing' },
      ),
    ];
  }

  const parsed = parseJsonFile(hooksPath, readFileSyncImpl);
  if (!parsed.ok) {
    return [
      createCheck(
        'hooks-config',
        'Hooks config',
        'fail',
        'hooks/hooks.json is not valid JSON.',
        `Fix ${hooksPath} so Claude Code can load the hook definitions.`,
        { code: 'hooks-config.invalid-json', params: { path: hooksPath } },
      ),
    ];
  }

  const parsedHooks = parsed.value.hooks;
  const hookTypes = parsedHooks && typeof parsedHooks === 'object' && !Array.isArray(parsedHooks)
    ? Object.keys(parsedHooks)
    : [];
  const missingTypes = EXPECTED_HOOK_TYPES.filter((type) => !hookTypes.includes(type));
  const configCheck = missingTypes.length > 0
    ? createCheck(
      'hooks-config',
      'Hooks config',
      'fail',
      `hooks/hooks.json is missing expected hook types: ${missingTypes.join(', ')}.`,
      'Restore the shipped hook configuration or reinstall MeMesh.',
      { code: 'hooks-config.missing-types', params: { types: missingTypes.join(', ') } },
    )
    : createCheck(
      'hooks-config',
      'Hooks config',
      'pass',
      `hooks/hooks.json is present with ${hookTypes.length} hook types configured.`,
    );

  const scriptPaths = extractHookScriptPaths(parsed.value, packageRoot);
  // Zero extracted scripts must not fall through to the pass branch below —
  // it used to print "All 0 hook scripts are present and executable" for a
  // hooks.json whose entries carry no `hooks` arrays (or all-empty ones),
  // i.e. an install whose hooks can never fire. Every check downstream of
  // this line filters FROM scriptPaths, so an empty set satisfies all of
  // them vacuously; the only honest verdict for it is fail.
  if (scriptPaths.length === 0) {
    return [
      configCheck,
      createCheck(
        'hook-scripts',
        'Hook scripts',
        'fail',
        'hooks/hooks.json parsed, but yields zero hook script commands — hooks can never fire.',
        'Restore the shipped hook configuration or reinstall MeMesh.',
        { code: 'hook-scripts.none' },
      ),
    ];
  }
  const missingScripts = scriptPaths.filter((scriptPath) => !existsSyncImpl(scriptPath));
  if (missingScripts.length > 0) {
    return [
      configCheck,
      createCheck(
        'hook-scripts',
        'Hook scripts',
        'fail',
        `Missing hook scripts: ${missingScripts.map((entry) => path.relative(packageRoot, entry)).join(', ')}.`,
        'Restore the missing files from the package or reinstall MeMesh.',
        { code: 'hook-scripts.missing', params: { files: missingScripts.map((entry) => path.relative(packageRoot, entry)).join(', ') } },
      ),
    ];
  }

  if (platform !== 'win32') {
    const nonExecutable = scriptPaths.filter((scriptPath) => {
      const mode = statSyncImpl(scriptPath).mode;
      return (mode & 0o111) === 0;
    });
    if (nonExecutable.length > 0) {
      return [
        configCheck,
        createCheck(
          'hook-scripts',
          'Hook scripts',
          'fail',
          `Hook scripts are not executable: ${nonExecutable.map((entry) => path.relative(packageRoot, entry)).join(', ')}.`,
          'Run `npm run build` from the repo checkout or `chmod +x scripts/hooks/*.js` for a local repair.',
          { code: 'hook-scripts.not-executable', params: { files: nonExecutable.map((entry) => path.relative(packageRoot, entry)).join(', ') } },
        ),
      ];
    }
  }

  return [
    configCheck,
    createCheck(
      'hook-scripts',
      'Hook scripts',
      'pass',
      `All ${scriptPaths.length} hook scripts are present${platform === 'win32' ? '' : ' and executable'}.`,
    ),
  ];
}

/**
 * Verify memesh's hooks are actually wired into Claude Code's
 * settings.json — not just present on disk. The earlier doctor
 * check only confirmed the hook scripts exist; it would PASS even
 * for a user whose Claude Code never loaded them, which was the
 * exact failure mode that masked memesh's "self-improving memory
 * loop never runs" bug for two weeks of npm downloads.
 *
 * Source of truth: the install-hooks.json marker written by
 * `memesh install-hooks`. Without that marker we can't tell a
 * fresh-install-needs-wiring case apart from a manually-wired
 * case the user did themselves — so we surface as WARN with a fix.
 */
function inspectHookWiring(
  existsSyncImpl: typeof fs.existsSync,
  readFileSyncImpl: typeof fs.readFileSync,
  memeshDir: string,
  installChannel?: InstallChannel,
  installedPluginsPath?: string,
  pluginHost?: PluginHost | null,
): DoctorCheck {
  const markerPath = path.join(memeshDir, 'install-hooks.json');
  if (!existsSyncImpl(markerPath)) {
    // Plugin-marketplace install path: when memesh is loaded as a
    // Claude Code plugin (via `/plugin install memesh@pcircle-memesh`),
    // hook wiring happens through the plugin runtime — `memesh
    // install-hooks` never runs, so the marker file is legitimately
    // absent. Report PASS there; `inspectHookActivity` covers the runtime
    // signal of whether hooks are actually firing.
    //
    // This used to key off `<packageRoot>/.claude-plugin/plugin.json`, which
    // is shipped inside the npm tarball (it is listed in `files`). So the
    // directory exists on EVERY install, and every install reported "Hooks
    // wired into Claude Code / PASS" — including a plain `npm i -g` where
    // nothing was wired and nothing would ever be remembered. The WARN below
    // was unreachable. The install channel is the honest signal: it is
    // `plugin-marketplace` only when the package actually sits under a
    // plugin runtime's cache (`~/.claude/plugins/cache/` or Codex's
    // `~/.codex/plugins/cache/`), which only that runtime writes.
    if (installChannel === 'plugin-marketplace') {
      // Naming the runtime matters here: this row is the answer to "are my
      // hooks actually connected", and a Codex user told "wired via the
      // Claude Code plugin runtime" has been handed a sentence about a
      // product they are not running.
      const runtime = pluginHost === 'codex' ? 'Codex CLI' : 'Claude Code';
      return createCheck(
        'hook-wiring',
        'Hooks wired into Claude Code',
        'pass',
        `Wired via the ${runtime} plugin runtime (this is a plugin-marketplace install). The install-hooks marker is not used on this install path.`,
      );
    }
    // A DIFFERENT copy may still be wired: on a plugin-managed machine the
    // npm-global doctor used to WARN "not connected" here while
    // install-hooks' own guard said "hooks are active" — one report, two
    // answers. The plugin registry is machine-level truth, so consult it
    // before claiming the machine is unwired. Injectable
    // (installedPluginsPathImpl) because the default path reads the REAL
    // machine — without the seam, every unit test of this branch would
    // flip on any developer box with the plugin installed.
    if (detectPluginRuntime(installedPluginsPath)) {
      return createCheck(
        'hook-wiring',
        'Hooks wired into Claude Code',
        'pass',
        'Wired via the Claude Code plugin runtime (found in installed_plugins.json). This copy is not the one doing the capturing — the plugin manages the hooks.',
      );
    }
    // A machine without Claude Code but with Codex or Gemini CLI: it has no Claude Code
    // hooks to connect, and telling it to run `memesh install-hooks` would create a
    // Claude directory nobody uses. Gemini is judged the way `memesh setup` judges it:
    // its command is on PATH.
    const claudeHere = claudeCodePresent(existsSyncImpl, isOnPath);
    const codexHere = codexPresent(existsSyncImpl, isOnPath);
    const geminiHere = geminiPresent(isOnPath);
    if (!claudeHere && (codexHere || geminiHere)) {
      const hostName = codexHere ? 'Codex' : 'Gemini CLI';
      return createCheck(
        'hook-wiring',
        'Hooks wired into Claude Code',
        'pass',
        `Claude Code was not found on this machine (${hostName} is), so there are no Claude Code hooks to wire. This row does not check ${hostName}'s own hooks; the Capture liveness row shows whether any hook has recorded a result.`,
        undefined,
        { code: 'hook-wiring.no-claude-code', params: { captureWired: 0 } },
      );
    }
    // No agent host at all. Telling this machine to run `install-hooks` would
    // connect memesh to a program that is not installed, and `doctor --fix` used to
    // do exactly that. There is nothing to repair yet, so the row carries no fixId.
    if (!claudeHere && !codexHere && !geminiHere) {
      return createCheck(
        'hook-wiring',
        'Hooks wired into Claude Code',
        'warn',
        'No agent host was found on this machine (looked for Claude Code, Codex and Gemini CLI: their commands on PATH, and the Claude Code and Codex configuration directories), so memesh has nothing to connect to yet.',
        NO_HOST_NEXT_STEP,
        { code: 'hook-wiring.no-host' },
      );
    }
    return createCheck(
      'hook-wiring',
      'Hooks wired into Claude Code',
      'warn',
      'memesh is not connected to Claude Code yet, so nothing gets remembered automatically from your sessions.',
      'Run `memesh install-hooks` once to connect it, then `memesh doctor` to confirm.',
      { code: 'hook-wiring.no-marker' },
      'install-hooks',
    );
  }
  const parsed = parseJsonFile(markerPath, readFileSyncImpl);
  if (!parsed.ok) {
    return createCheck(
      'hook-wiring',
      'Hooks wired into Claude Code',
      'warn',
      `install-hooks marker at ${markerPath} is unreadable.`,
      'Re-run `memesh install-hooks` to refresh the marker.',
      { code: 'hook-wiring.marker-unreadable', params: { path: markerPath } },
    );
  }
  const marker = parsed.value as {
    plugin_root?: string;
    settings_path?: string;
    version?: string;
    scope?: string;
  };
  if (typeof marker.settings_path !== 'string') {
    return createCheck(
      'hook-wiring',
      'Hooks wired into Claude Code',
      'warn',
      'install-hooks marker is malformed (missing settings_path).',
      'Re-run `memesh install-hooks`.',
      { code: 'hook-wiring.marker-malformed' },
    );
  }
  if (!existsSyncImpl(marker.settings_path)) {
    return createCheck(
      'hook-wiring',
      'Hooks wired into Claude Code',
      'fail',
      `Marker recorded settings at ${marker.settings_path} but the file no longer exists. Hooks are not wired.`,
      'Re-run `memesh install-hooks`.',
      { code: 'hook-wiring.settings-missing', params: { path: String(marker.settings_path) } },
    );
  }
  const settingsParsed = parseJsonFile(marker.settings_path, readFileSyncImpl);
  if (!settingsParsed.ok) {
    return createCheck(
      'hook-wiring',
      'Hooks wired into Claude Code',
      'fail',
      `${marker.settings_path} is no longer valid JSON, so nothing can read your hook wiring — including memesh.`,
      // NOT "re-run install-hooks" on its own. `installHooks` parses the file
      // first and throws `refusing to modify` on unparseable JSON, so the
      // suggested remedy could not succeed: the user runs it, gets a refusal,
      // and is back where they started. The JSON has to be repaired or moved
      // aside FIRST; install-hooks writes a fresh file when none exists.
      `Repair the JSON, or move the file aside (\`mv ${shellQuote(String(marker.settings_path))} ${shellQuote(`${marker.settings_path}.broken`)}\`) — memesh keeps timestamped \`.bak-pre-memesh-*\` copies next to it. Then run \`memesh install-hooks\`.`,
      { code: 'hook-wiring.settings-invalid', params: { path: String(marker.settings_path) } },
    );
  }
  // Walk hooks looking for _memesh:true entries. Presence anywhere is the
  // wiring contract, but the CAPTURE events are tracked separately: a
  // SessionStart-only wiring is a real wiring (recall works) while proving
  // nothing about whether a capture hook should ever execute — and
  // hook-activity's never-ran FAIL says "they should be executing", so it
  // must key on capture wiring specifically, not on wiring at all.
  const CAPTURE_EVENTS = new Set(['Stop', 'PostToolUse', 'PreCompact']);
  const hooks = (settingsParsed.value as { hooks?: Record<string, unknown> }).hooks;
  let hasMemeshHook = false;
  let hasCaptureHook = false;
  let missingScript: string | null = null;
  if (hooks && typeof hooks === 'object') {
    for (const [event, entries] of Object.entries(hooks)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const cmds = (entry as { hooks?: unknown[] }).hooks;
        if (!Array.isArray(cmds)) continue;
        for (const c of cmds) {
          const cmd = c as { _memesh?: boolean; command?: unknown };
          if (cmd._memesh !== true) continue;
          hasMemeshHook = true;
          if (CAPTURE_EVENTS.has(event)) hasCaptureHook = true;
          // A wired entry whose script no longer exists is worse than no
          // wiring: the agent invokes a nonexistent file on every matching
          // event. This is the upgrade residue a release leaves when it
          // retires a hook — install-hooks now prunes it, but nothing runs
          // install-hooks automatically on a package upgrade, so doctor is
          // where the state gets caught and named.
          if (missingScript === null && typeof cmd.command === 'string'
            && path.isAbsolute(cmd.command) && !existsSyncImpl(cmd.command)) {
            missingScript = cmd.command;
          }
        }
      }
    }
  }
  if (missingScript !== null) {
    return createCheck(
      'hook-wiring',
      'Hooks wired into Claude Code',
      'fail',
      `A wired memesh hook points at ${missingScript}, which no longer exists — the agent invokes a missing file on every matching event. This is usually residue from an upgrade that retired the hook.`,
      'Run `memesh install-hooks` to re-wire (it now removes retired entries), then restart your agent.',
      { code: 'hook-wiring.script-missing', params: { path: missingScript } },
    );
  }
  if (!hasMemeshHook) {
    return createCheck(
      'hook-wiring',
      'Hooks wired into Claude Code',
      'fail',
      `Marker recorded a memesh install at ${marker.settings_path}, but no _memesh:true hook entries are present anymore. Settings drifted (manual edit?) or memesh was uninstalled out-of-band.`,
      'Re-run `memesh install-hooks` to re-wire.',
      { code: 'hook-wiring.entries-removed', params: { path: String(marker.settings_path) } },
    );
  }
  // Check the recorded plugin_root still exists — npm-global path
  // can change after a Node.js upgrade, leaving stale absolute paths.
  if (typeof marker.plugin_root === 'string' && !existsSyncImpl(marker.plugin_root)) {
    return createCheck(
      'hook-wiring',
      'Hooks wired into Claude Code',
      'fail',
      `Hook commands point at ${marker.plugin_root}, which no longer exists (likely after an npm-global path change).`,
      'Re-run `memesh install-hooks` to refresh paths.',
      { code: 'hook-wiring.root-moved', params: { path: String(marker.plugin_root) } },
    );
  }
  return createCheck(
    'hook-wiring',
    'Hooks wired into Claude Code',
    'pass',
    `Wired in ${marker.settings_path} (scope: ${marker.scope ?? 'user'}, version: ${marker.version ?? 'unknown'}).`,
    undefined,
    // Consumed by runDoctor to arm hook-activity's never-ran FAIL — not a
    // user-facing message param.
    { params: { captureWired: hasCaptureHook ? 1 : 0 } },
  );
}

/**
 * Confirm the auto-capture loop is alive, from what actually RAN.
 *
 * The verdict reads `hook_runs` — the heartbeat each capture hook stamps at
 * its own successful exit — not the count of captured entities. A produced
 * entity is no longer the evidence: "ran, found nothing worth saving" is the
 * healthy case that produces no row at all, and judging by rows made a quiet
 * day and a dead loop byte-identical. The `source:auto-capture` count still
 * appears in the PASS message, but as detail, never as the verdict. (The
 * count once judged this check by entity TYPE, which a hand-typed
 * `memesh learn` satisfied — the check reported the user's own typing back
 * as proof of automation. That is why the count can never be trusted with
 * the verdict again.)
 *
 * Three hooks stamp, but only one is load-bearing: `session-summary` fires
 * on every session's Stop (its low-signal bails stamp too), so its silence
 * is meaningful. `post-commit` and `pre-compact` fire only when the user
 * commits or a session compacts — their absence proves nothing, so their
 * STALENESS caps at warn, never fail. The two ways they can still drive a
 * red are both positive evidence, not absence: a corrupt/future timestamp
 * (stale-unknown — the row itself is lying), and the stop-silent warn when
 * they keep stamping for days while session-summary has never stamped once
 * (commit capture hiding dead session capture).
 *
 * Staleness has two tiers on purpose: >24h is a WARN ("worth a look — or a
 * weekend"), >72h is the FAIL. The first version failed at 24h flat, which
 * turned every Monday morning into a red "capture has stopped" banner; an
 * alarm that cries wolf on weekends trains the user to ignore the real one.
 *
 * Deliberate silence is not a failure: capture disabled by config is a PASS
 * with its own message, and "never ran" only reds when hook wiring is
 * actually in place — otherwise the hook-wiring row already carries that
 * story and this one downgrades to a quiet corroborating warn.
 *
 * Grace periods for the never-ran verdict: tracking younger than 24h (every
 * pre-heartbeat database on its upgrade day), or an install-hooks marker
 * younger than 24h (fresh install, no session yet).
 */
function inspectHookActivity(
  openDatabaseImpl: typeof openDatabase,
  closeDatabaseImpl: typeof closeDatabase,
  existsSyncImpl: typeof fs.existsSync = fs.existsSync,
  statSyncImpl: typeof fs.statSync = fs.statSync,
  wiringPresent: boolean = true,
): DoctorCheck {
  const TITLE = 'Hook activity';

  // Deliberately disabled capture is a configuration, not a failure — and
  // every verdict below would misread it: the heartbeats legitimately stop
  // the moment the user turns capture off. The two sources are reported
  // separately because they have different blast radius: the config file is
  // shared by every process, but an env var is visible only to THIS shell —
  // the agent's hooks may be running under a different environment, so an
  // env-sourced "disabled" is a statement about doctor's own process, not a
  // verified fact about the capture loop.
  const captureOff = autoCaptureOffSource();
  if (captureOff === 'config') {
    return createCheck('hook-activity', TITLE, 'pass',
      'Automatic capture is turned off (config autoCapture: false) — deliberately, so hook silence is expected. Re-enable it to resume capturing sessions.',
      undefined,
      { code: 'hook-activity.disabled' });
  }
  if (captureOff === 'env') {
    return createCheck('hook-activity', TITLE, 'pass',
      'Automatic capture is turned off by MEMESH_AUTO_CAPTURE=false in this shell\'s environment. Doctor can only see its own environment — if your agent runs without this variable, capture there is unaffected.',
      undefined,
      { code: 'hook-activity.disabled-env' });
  }

  let db: DatabaseLike | null = null;
  try {
    db = openDatabaseImpl() as unknown as DatabaseLike;

    // A pre-heartbeat database whose FILE is read-only opens without the
    // table (the open path skips migration on a read-only file rather than
    // dying) — that is "tracking has not started", not a query failure.
    const hookRunsTablePresent = !!db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'hook_runs'",
    ).get();
    const rows = hookRunsTablePresent
      ? db.prepare(
        `SELECT hook, last_run_at FROM hook_runs`,
      ).all() as Array<{ hook: string; last_run_at: string }>
      : [];

    const captured = (db.prepare(
      `SELECT COUNT(DISTINCT e.id) as c FROM entities e
       JOIN tags t ON t.entity_id = e.id
       WHERE t.tag = ?
         AND e.created_at > datetime('now', '-24 hours')`,
    ).get(AUTO_CAPTURE_TAG) as { c: number } | undefined)?.c ?? 0;

    // How long tracking has been possible — both the event-hook branch and
    // the nothing-ever-ran branch below reason about it.
    const since = (db.prepare(
      "SELECT value FROM memesh_metadata WHERE key = 'hook_runs_since'",
    ).get() as { value: string } | undefined)?.value;
    const measuringHours = since !== undefined ? hoursSince(since) : null;

    // Small negative ages are clock jitter between processes; anything
    // beyond that is a future timestamp — a wrong clock stamped it, and
    // "the future" must not read as "recently" (a dead loop would hide
    // behind it until the wall clock caught up).
    const SKEW_TOLERANCE_H = 5 / 60;
    // hook_runs is user-writable SQLite, so a row's name is untrusted twice
    // over: it must not ride a diagnostic into the pre-filled PUBLIC GitHub
    // issue body (`memesh feedback` copies summaries verbatim), and it must
    // not COUNT — our hooks only ever stamp three literals, so any other
    // row was written by something that is not us, and treating its
    // timestamp as liveness evidence would let one foreign row turn a dead
    // capture loop permanently green (four independent reviews converged on
    // this). Foreign rows are simply not evidence, in either direction.
    const KNOWN_HOOKS = new Set(['session-summary', 'post-commit', 'pre-compact']);
    const ages = new Map<string, number | null>();
    for (const r of rows) {
      if (!KNOWN_HOOKS.has(r.hook)) continue;
      const age = hoursSince(r.last_run_at);
      ages.set(r.hook, age !== null && age >= -SKEW_TOLERANCE_H ? Math.max(age, 0) : null);
    }

    if (ages.size > 0) {
      const capturedTail = captured > 0
        ? `${captured} memor${captured === 1 ? 'y' : 'ies'} captured in the last 24h.`
        : 'Nothing was worth saving in that time, which is normal — the loop still ran.';

      // These two shapes each appear on two independent branches
      // (session-summary-owned and event-hook-only), and their strings must
      // stay aligned with 11 dashboard locales — one definition, one sync
      // point. Stale wording rounds UP (Math.ceil): at 24.4h the status has
      // already turned warn, and "last ran 24 hours ago" would contradict
      // the 24h PASS wording next to it.
      const staleUnknown = (hook: string) => createCheck('hook-activity', TITLE, 'fail',
        `The ${hook} hook's last-run timestamp cannot be read (corrupt, or stamped by a machine with a wrong clock). ` +
          'Capture health is unknown, which is not the same as healthy.',
        'End one work session, then re-run `memesh doctor` — a fresh run overwrites the bad timestamp.',
        { code: 'hook-activity.stale-unknown', params: { hook } });
      // params.hours uses the SAME Math.ceil as the English sentence: the 11
      // dashboard locales interpolate {hours} from params, and a Math.round
      // there rendered "ran about 24 hours ago" on a warn row at 24.0–24.4h —
      // the exact contradiction the ceil exists to prevent, localized.
      const stale = (hook: string, age: number, status: DoctorCheckStatus) => createCheck(
        'hook-activity', TITLE, status,
        `The ${hook} hook last ran ${formatHoursAgo(Math.ceil(age))}. ` +
          'If you have worked since then, capture has stopped and nothing from those sessions was saved.',
        'Restart your agent, then end one session and re-run `memesh doctor`. If it does not recover, run `memesh install-hooks`.',
        { code: 'hook-activity.stale', params: { hook, hours: Math.ceil(age) } });

      // session-summary is the only hook whose silence is meaningful, so its
      // row — when it has one — owns the verdict.
      const ssAge = ages.has('session-summary') ? ages.get('session-summary')! : undefined;
      if (ssAge === null) return staleUnknown('session-summary');
      if (ssAge !== undefined) {
        if (ssAge <= 24) {
          return createCheck('hook-activity', TITLE, 'pass',
            `The session-summary hook last ran ${formatHoursAgo(ssAge)} — auto-capture is alive. ${capturedTail}`);
        }
        if (ssAge <= 72) return stale('session-summary', ssAge, 'warn');
        // Past 72h, distinguish "the hook died" from "the user moved to
        // another agent": if Claude Code itself wrote anything recently
        // (Phase 2 stamps metadata.provenance.source_host on every write
        // path), the agent is in use and its Stop hook is provably silent —
        // that is the red. No recent Claude Code writes is NOT proof of
        // death (a session can write nothing), so absence only holds the
        // verdict at warn — it never upgrades to fail on missing evidence.
        // json_valid guards the extract: metadata has no validity constraint
        // and the migration chain deliberately preserves unparseable legacy
        // values, so one bad row must not turn this whole check into
        // query-failed (measured: json_extract THROWS on malformed JSON).
        const ccWrites = (db.prepare(
          `SELECT COUNT(*) as c FROM entities
           WHERE created_at > datetime('now', '-72 hours')
             AND json_valid(metadata)
             AND json_extract(metadata, '$.provenance.source_host') = 'claude-code'`,
        ).get() as { c: number } | undefined)?.c ?? 0;
        if (ccWrites > 0) return stale('session-summary', ssAge, 'fail');
        // The hedge is its own code, not a tail glued onto the English
        // summary: the 11 dashboard locales render by code, and gluing the
        // hedge onto `hook-activity.stale` meant every non-English user read
        // an unqualified "capture has stopped" — with exactly the sentence
        // that says "this may be fine" dropped in translation.
        return createCheck('hook-activity', TITLE, 'warn',
          `The session-summary hook last ran ${formatHoursAgo(Math.ceil(ssAge))}, and no Claude Code writes landed in the last 3 days either. If this machine has moved to another agent (Codex / Gemini), this is expected; if you still use Claude Code here, capture has stopped.`,
          'If you still use Claude Code on this machine: restart it, end one session, and re-run `memesh doctor`. If it does not recover, run `memesh install-hooks`.',
          { code: 'hook-activity.stale-unconfirmed', params: { hook: 'session-summary', hours: Math.ceil(ssAge) } });
      }

      // Only the event-driven hooks (post-commit / pre-compact) have stamped.
      // Their triggers depend on user behaviour — no commits means no
      // post-commit run, dead or alive — so their staleness caps at WARN,
      // never fail: evidence from hooks the user may simply not be
      // triggering cannot prove death, only invite a look.
      const known = [...ages.entries()].filter((e): e is [string, number] => e[1] !== null);
      if (known.length === 0) {
        const [hook] = [...ages.keys()].sort();
        return staleUnknown(hook);
      }
      const [freshestHook, freshestAge] = known.sort((a, b) => a[1] - b[1])[0];
      if (freshestAge <= 24) {
        // Fresh event activity proves the machinery runs — but session-summary,
        // the hook that carries session memory, has never stamped once. Early
        // in tracking that is expected; past three days it stops being
        // explicable by quiet sessions (the low-signal bails stamp too), and
        // a permanently silent Stop hook hiding behind daily commits is the
        // exact masked-death this check exists to expose.
        if (measuringHours !== null && measuringHours > 72) {
          return createCheck('hook-activity', TITLE, 'warn',
            `The ${freshestHook} hook is stamping (last ran ${formatHoursAgo(freshestAge)}), but the session-summary hook has never run once in the ${Math.round(measuringHours)} hours since tracking began — session capture may be broken while commit capture hides it.`,
            'End one work session and re-run `memesh doctor`. If session-summary still has not run, run `memesh install-hooks` and restart your agent.',
            { code: 'hook-activity.stop-silent', params: { hook: freshestHook, hours: Math.round(measuringHours) } });
        }
        return createCheck('hook-activity', TITLE, 'pass',
          `The ${freshestHook} hook last ran ${formatHoursAgo(freshestAge)} — auto-capture is alive. ` +
            `(session-summary has not stamped yet — expected until a session with real work ends.) ${capturedTail}`);
      }
      return stale(freshestHook, freshestAge, 'warn');
    }

    if (since !== undefined && (measuringHours === null || measuringHours < 0)) {
      // The tracking marker itself is unreadable or in the future. Left
      // alone forever it would grant the "just started" grace FOREVER — a
      // fail-open — but the healer is NOT this function: doctor is a reader
      // (reachable via an unauthenticated loopback GET /v1/doctor, where a
      // state-changing side effect has no place), and ensureHookRunsSince
      // validates and restamps the marker on every real write-path open.
      // The next session, commit, or CLI command heals it; doctor just says
      // so.
      return createCheck('hook-activity', TITLE, 'pass',
        'The hook-run tracking marker is unreadable — it will be re-stamped automatically the next time the database is opened for writing (any session, commit, or memesh command does it). Tracking restarts then.');
    }
    if (measuringHours === null || measuringHours < 24) {
      // A database that only just gained the heartbeat has an empty table for
      // reasons that say nothing about hook health. Every existing install is
      // in this state for its first day.
      return createCheck('hook-activity', TITLE, 'pass',
        'Hook-run tracking has only just started on this database — the first work session will fill it in.');
    }
    // Fresh-install grace: hooks wired within the last day, no session yet.
    const markerPath = path.join(memeshDir(), 'install-hooks.json');
    if (existsSyncImpl(markerPath)) {
      try {
        if (Date.now() - statSyncImpl(markerPath).mtimeMs < 24 * 60 * 60 * 1000) {
          return createCheck('hook-activity', TITLE, 'pass',
            'Hooks were wired in the last day and no session has ended yet — normal for a fresh install.');
        }
      } catch { /* marker unreadable; fall through to the real verdict */ }
    }
    // Version skew: the npm CLI/MCP side and the plugin hooks ship through
    // separate channels. An upgraded CLI starts tracking while still-old
    // hooks (which predate the heartbeat) keep capturing without stamping —
    // entities carrying the auto-capture tag ARE landing, so "nothing is
    // being remembered" would be flatly false. The window is "since tracking
    // began", not the last 24h: legacy hooks capture on the user's schedule,
    // and a quiet weekend must not flip this warn into the never-ran FAIL
    // below (the false red would tell a working install its memory is gone).
    // The tag is hand-typeable, so this is a warn, never a pass.
    const legacyCaptured = (db.prepare(
      `SELECT COUNT(DISTINCT e.id) as c FROM entities e
       JOIN tags t ON t.entity_id = e.id
       WHERE t.tag = ?
         AND e.created_at > ?`,
    ).get(AUTO_CAPTURE_TAG, since) as { c: number } | undefined)?.c ?? 0;
    if (legacyCaptured > 0) {
      return createCheck('hook-activity', TITLE, 'warn',
        `No hook has stamped the heartbeat, but ${legacyCaptured} auto-capture memor${legacyCaptured === 1 ? 'y' : 'ies'} landed since tracking began — hooks from a version before heartbeat tracking are probably still running.`,
        'Update the memesh hooks to the current version (plugin installs: `/plugin update memesh`; npm installs: `memesh install-hooks`), then restart your agent.',
        { code: 'hook-activity.never-ran-legacy', params: { captured: legacyCaptured } });
    }
    if (!wiringPresent) {
      // No CAPTURE hook is confirmed wired — the hook-wiring row is already
      // telling that story with its own fix. Failing here too would
      // double-report one condition, and for installs that never intend to
      // wire capture hooks (MCP-only hosts, recall-only wirings) it would be
      // a permanent unfixable red. Note "capture hook", not "wired at all":
      // a SessionStart-only wiring passes the wiring row but proves nothing
      // about Stop/PostToolUse/PreCompact ever executing, so it must not
      // arm the never-ran FAIL below.
      return createCheck('hook-activity', TITLE, 'warn',
        'No capture hook has ever run — and no capture hook (Stop / PostToolUse / PreCompact) is confirmed wired on this machine, so there is nothing to run.',
        'If you want automatic capture, run `memesh install-hooks`. If this install is MCP-only (Codex / Gemini), this is expected and safe to ignore.',
        { code: 'hook-activity.not-wired' });
    }
    return createCheck('hook-activity', TITLE, 'fail',
      `No capture hook has run since tracking began ${formatHoursAgo(measuringHours)}. ` +
        'Hook wiring is in place, so they should be executing and are not — nothing is being remembered.',
      'Run `memesh doctor` after ending one work session. If this still says no hook has run, run `memesh install-hooks` and restart your agent.',
      { code: 'hook-activity.never-ran', params: { hours: Math.round(measuringHours) } });
  } catch (err) {
    if (err instanceof NoDatabaseYetError) {
      return createInfo('hook-activity', TITLE,
        'No database yet, so no hook can have captured anything: hook activity is not checked until MeMesh has stored its first memory. Doctor does not create the database.');
    }
    if (isSchemaBehind(err)) return createInfo('hook-activity', TITLE, `Not checked: ${schemaBehindNote()}`);
    const detail = err instanceof Error ? err.message : String(err);
    return createCheck('hook-activity', TITLE, 'fail',
      queryFailedSummary(err, detail, 'hook activity', 'Capture health is unknown, which is not the same as healthy.'),
      queryFailedFix(err),
      { code: 'hook-activity.query-failed', params: { detail } });
  } finally {
    try { if (db) closeDatabaseImpl(); } catch { /* best-effort */ }
  }
}

/**
 * Capture liveness — has the automatic memory layer written anything lately,
 * and if not, why not (#327)?
 *
 * `inspectHookActivity` next door answers "did a hook RUN". This answers the
 * question that actually matters to a user: "and did it SAVE anything". The
 * two came apart for two days on the owner's graph — post-commit ran on every
 * Bash call and skipped every one of them, because the commits were made with
 * `git commit -q` and printed no line to match (#321). Every heartbeat was
 * green throughout.
 *
 * Two independent sources, deliberately:
 *   - `hook-outcomes.jsonl`, written by the hooks themselves, which is the
 *     only place a SKIP REASON exists;
 *   - the database, for what actually landed, per entity type, this week
 *     versus last.
 *
 * A type that wrote last week and nothing this week is a concern even when
 * every hook looks busy — that is the shape of a capture path that broke
 * downstream of the hook.
 */
/**
 * The session handoff's exact name, taken from the `handoff-capture` records
 * in the same window the diagnosis was made from — or null.
 *
 * Null unless those records name exactly ONE handoff: when several projects'
 * handoffs were archived, no single command fixes them all, and the unnamed
 * advice (which says how to look each one up) is the honest one.
 *
 * The name goes into a command the dashboard offers to copy, so it is used
 * only when it is COMPLETE (outcome records cut an entity at 200 characters;
 * a cut name ends before the 32-hex project hash) and SAFE to paste into a
 * shell unquoted (the project label is a raw folder name and can hold spaces,
 * quotes, `$` or backticks).
 */
const SAFE_HANDOFF_NAME = /^session-handoff:[A-Za-z0-9._-]+~[0-9a-f]{32}$/;

function archivedHandoffName(file: ReturnType<typeof parseHookOutcomes>): string | null {
  if (!Object.hasOwn(file.hooks, 'handoff-capture')) return null;
  const names = new Set<string>();
  for (const r of file.hooks['handoff-capture']) {
    if (r.outcome === 'skipped' && r.reason === SKIP_REASONS.handoffArchived && typeof r.entity === 'string') names.add(r.entity);
  }
  if (names.size !== 1) return null;
  const [name] = names;
  return SAFE_HANDOFF_NAME.test(name) ? name : null;
}

/**
 * Reinstalling the hooks cannot help an archived handoff: captureEntity
 * leaves an archived memory alone on purpose. Re-remembering it under the
 * same name makes it active again, and the next Stop replaces its text.
 */
function archivedHandoffCheck(title: string, runs: number, name: string | null): DoctorCheck {
  const summary = `handoff-capture: ${runs} runs, 0 writes — the session handoff was archived with \`forget\`, so it is not updated any more.`;
  if (name) {
    return createCheck('capture-liveness', title, 'warn', summary,
      // The handoff is filed under the project its name carries; `remember` refuses a write that names another one.
      `To turn it back on, run \`memesh remember --name ${name} --type session-handoff --obs restart --project ${name.slice(name.indexOf(':') + 1)}\`; the next Stop replaces it.`,
      { code: 'capture-liveness.handoff-archived', params: { runs, name } });
  }
  return createCheck('capture-liveness', title, 'warn', summary,
    'To turn it back on, find its exact name with `memesh recall session-handoff --include-archived`, then remember anything under that name with type session-handoff; the next Stop replaces it.',
    { code: 'capture-liveness.handoff-archived-unnamed', params: { runs } });
}

/** What to tell a machine that has no agent host at all, instead of `memesh install-hooks`. */
const NO_HOST_NEXT_STEP = 'Install Claude Code or Codex (or Gemini CLI), then run `memesh setup` to connect memesh to it.';

/** What to tell a machine whose agent is Codex: Codex's hooks come from its plugin, not from `memesh install-hooks`. */
const CODEX_NEXT_STEP = `Refresh the Codex plugin (\`${PLUGIN_REFRESH_COMMANDS.codex}\`), restart Codex, start one session, and re-run \`memesh doctor\`. If you just updated, start a session first — the records begin on the next hook run.`;

/** What to tell a machine whose only agent is Gemini CLI: it is an MCP-only host, there is no hook to install. */
const GEMINI_NEXT_STEP = 'Gemini CLI connects to memesh as an MCP server only, so there are no memesh hooks to install on this machine.';

/**
 * Which agent the machine has, as far as the rows that prescribe a hook fix are
 * concerned. It is read off the hook-wiring row, so the rows cannot disagree with it.
 */
export type HostFixState = 'claude' | 'no-host' | 'codex' | 'gemini';

export function hostFixState(wiringCode: string | undefined, codexHere: boolean): HostFixState {
  if (wiringCode === 'hook-wiring.no-host') return 'no-host';
  if (wiringCode === 'hook-wiring.no-claude-code') return codexHere ? 'codex' : 'gemini';
  return 'claude';
}

/**
 * The ONE place that writes the fix of a row that would otherwise prescribe
 * `memesh install-hooks`. That command writes Claude Code's settings, so on a
 * machine that has no Claude Code it would create a directory nobody uses and
 * contradict the hook-wiring row. Every such row gets the hook-wiring row's
 * answer for this machine instead (and no fixId, so `doctor --fix` cannot act on it).
 */
export function withHostFix(check: DoctorCheck, state: HostFixState): DoctorCheck {
  if (state === 'claude' || check.status === 'pass' || !check.fix?.includes('install-hooks')) return check;
  const fix = state === 'no-host' ? NO_HOST_NEXT_STEP : state === 'codex' ? CODEX_NEXT_STEP : GEMINI_NEXT_STEP;
  return { ...check, fix, fixId: undefined };
}

/**
 * Name the agent hosts the outcome records came from, on every capture-liveness
 * verdict that has records (#447). The per-hook figure rides `--json`; the
 * sentence a person reads names them too, and a warning is where a mislabelled
 * host matters most.
 */
function withRecordedHosts(
  result: { check: DoctorCheck; report?: CaptureLivenessReport },
): { check: DoctorCheck; report?: CaptureLivenessReport } {
  // No report (capture off, or the read failed) means no records to name.
  if (!result.report) return result;
  const hostsSeen = [...new Set(result.report.hooks.flatMap((h) => h.hosts))].sort();
  if (hostsSeen.length === 0) return result;
  return { ...result, check: { ...result.check, summary: `${result.check.summary} Hosts recorded: ${hostsSeen.join(', ')}.` } };
}

function inspectCaptureLiveness(
  openDatabaseImpl: typeof openDatabase,
  closeDatabaseImpl: typeof closeDatabase,
  readFileSyncImpl: typeof fs.readFileSync = fs.readFileSync,
  memeshDirImpl: () => string = getMemeshDirFromDbPath,
  captureWired: boolean = true,
): { check: DoctorCheck; report?: CaptureLivenessReport } {
  const TITLE = 'Capture liveness';

  // Deliberately disabled capture is a configuration, not a failure —
  // identical reasoning to hook-activity, and every verdict below would
  // misread it: the records legitimately stop the moment capture is off.
  if (autoCaptureOffSource() !== null) {
    return {
      check: createCheck('capture-liveness', TITLE, 'pass',
        'Automatic capture is turned off, so there is nothing to keep alive. Re-enable it to resume capturing.'),
    };
  }

  let raw: string | null;
  try {
    raw = readFileSyncImpl(path.join(memeshDirImpl(), HOOK_OUTCOMES_FILENAME), 'utf8') as string;
  } catch {
    // No file yet is the ordinary state right after an upgrade — the hooks
    // create it on their next run. It is NOT evidence of death, and the
    // never-ran branch below refuses to treat it as such.
    raw = null;
  }
  const outcomeFile = parseHookOutcomes(raw);
  const hooks = summarizeHookOutcomes(outcomeFile);

  let db: DatabaseLike | null = null;
  let types: TypeTrend[];
  let neverRan: string[];
  let measuringHours: number | null;
  let legacyCaptured = 0;
  let stampedCount: number;
  let newestHeartbeatHours: number | null = null;
  try {
    db = openDatabaseImpl() as unknown as DatabaseLike;

    // Per type, this week against the previous one. Restricted to
    // auto-capture rows: a hand-typed `memesh learn` is not evidence that the
    // automatic layer is alive, which is the mistake an earlier version of
    // the hook-activity count made.
    //
    // The session handoff is left out: it is ONE row per project that each
    // Stop rewrites in place, so its `created_at` never moves and it would
    // read as "stopped" from the eighth day on. `handoff-capture` has its own
    // row in the hook table above.
    const rows = db.prepare(
      `SELECT e.type AS type,
              SUM(CASE WHEN e.created_at > datetime('now', '-7 days') THEN 1 ELSE 0 END) AS last7,
              SUM(CASE WHEN e.created_at <= datetime('now', '-7 days')
                        AND e.created_at > datetime('now', '-14 days') THEN 1 ELSE 0 END) AS prev7
         FROM entities e
         JOIN tags t ON t.entity_id = e.id
        WHERE t.tag = ?
          AND e.created_at > datetime('now', '-14 days')
          AND e.type <> ?
        GROUP BY e.type`,
    ).all(AUTO_CAPTURE_TAG, SESSION_HANDOFF_TYPE) as Array<{ type: string; last7: number; prev7: number }>;
    types = summarizeTypeTrends(rows.map((r) => ({
      type: String(r.type),
      last7: Number(r.last7) || 0,
      prev7: Number(r.prev7) || 0,
    })));

    const tablePresent = !!db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'hook_runs'",
    ).get();
    const heartbeats = tablePresent
      ? db.prepare('SELECT hook, last_run_at FROM hook_runs').all() as Array<{ hook: string; last_run_at: string }>
      : [];
    const stamped = new Set(heartbeats.map((r) => r.hook));
    stampedCount = stamped.size;
    for (const r of heartbeats) {
      const h = hoursSince(String(r.last_run_at));
      if (h !== null && (newestHeartbeatHours === null || h < newestHeartbeatHours)) newestHeartbeatHours = h;
    }
    // Only session-summary is FAIL-eligible; see FAIL_ELIGIBLE_HOOKS for why
    // a hook whose trigger depends on user behaviour can never reach it.
    neverRan = FAIL_ELIGIBLE_HOOKS.filter((h) => !stamped.has(h));

    const since = (db.prepare(
      "SELECT value FROM memesh_metadata WHERE key = 'hook_runs_since'",
    ).get() as { value: string } | undefined)?.value;
    measuringHours = since !== undefined ? hoursSince(since) : null;

    // Legacy hooks that predate the outcome record write auto-capture
    // entities without either a heartbeat or an outcome record. If any have
    // landed since tracking began, "the session-summary hook never ran" is
    // version skew, not death — the same hedge hook-activity's
    // never-ran-legacy takes, so the two rows cannot contradict each other
    // about the same graph.
    if (since !== undefined) {
      legacyCaptured = (db.prepare(
        `SELECT COUNT(DISTINCT e.id) as c FROM entities e
         JOIN tags t ON t.entity_id = e.id
        WHERE t.tag = ? AND e.created_at > ?`,
      ).get(AUTO_CAPTURE_TAG, since) as { c: number } | undefined)?.c ?? 0;
    }
  } catch (err) {
    if (err instanceof NoDatabaseYetError) {
      return {
        check: createInfo('capture-liveness', TITLE,
          'No database yet, so there is nothing to keep alive: capture liveness is not checked until MeMesh has stored its first memory. Doctor does not create the database.'),
      };
    }
    if (isSchemaBehind(err)) return { check: createInfo('capture-liveness', TITLE, `Not checked: ${schemaBehindNote()}`) };
    // A query failure is not a healthy graph and must not read as one.
    const detail = err instanceof Error ? err.message : String(err);
    return {
      check: createCheck('capture-liveness', TITLE, 'fail',
        queryFailedSummary(err, detail, 'capture liveness', 'Whether anything is being saved is unknown, which is not the same as healthy.'),
        queryFailedFix(err),
        { code: 'capture-liveness.query-failed', params: { detail } }),
    };
  } finally {
    try { if (db) closeDatabaseImpl(); } catch { /* best-effort */ }
  }

  const verdict = captureLivenessVerdict({ hooks, types, neverRanHooks: neverRan, measuringHours });
  const report: CaptureLivenessReport = {
    status: verdict.status,
    hooks,
    types,
    neverRan: verdict.deadHooks,
  };

  if (verdict.status === 'FAIL') {
    const hook = verdict.deadHooks[0];
    // Two ways a "never ran" FAIL is not a defect. First: no capture hook
    // is confirmed wired at all (MCP-only hosts, recall-only wirings), so
    // there is nothing that SHOULD have run — a permanent unfixable red on
    // a supported install type. Second: legacy hooks that predate the
    // outcome record keep capturing without one, so this is version skew,
    // not death. Both mirror hook-activity's not-wired / never-ran-legacy
    // hedges so the two rows never contradict each other about one graph.
    if (!captureWired) {
      return {
        check: createCheck('capture-liveness', TITLE, 'warn',
          `The ${hook} hook has never run — but no capture hook (Stop / PostToolUse / PreCompact) is confirmed wired on this machine, so there is nothing that should be running.`,
          'If you want automatic capture, run `memesh install-hooks`. If this install is MCP-only (Codex / Gemini / Cursor), this is expected and safe to ignore.',
          { code: 'capture-liveness.not-wired', params: { hook } }),
        report: { ...report, status: 'PASS_WITH_CONCERNS' },
      };
    }
    // Only when there are NO outcome records at all. Once any current-version
    // hook has recorded an outcome, the outcome-recording hooks are
    // installed, and a session-summary that still left nothing is a broken
    // Stop hook — softening it to "update the hooks" would contradict
    // hook-activity's stop-silent about the same graph.
    if (legacyCaptured > 0 && hooks.length === 0) {
      return {
        check: createCheck('capture-liveness', TITLE, 'warn',
          `The ${hook} hook has left no record and no heartbeat, but ${legacyCaptured} auto-capture memor${legacyCaptured === 1 ? 'y' : 'ies'} landed since tracking began — hooks from a version before outcome tracking are probably still running.`,
          'Update the memesh hooks to the current version (plugin installs: `/plugin update memesh`; npm installs: `memesh install-hooks`), then restart your agent.',
          { code: 'capture-liveness.never-ran-legacy', params: { hook, captured: legacyCaptured } }),
        report: { ...report, status: 'PASS_WITH_CONCERNS' },
      };
    }
    return {
      check: createCheck('capture-liveness', TITLE, 'fail',
        `The ${hook} hook has left no record and no heartbeat in the ${Math.round(measuringHours ?? 0)} hours since tracking began — it has never run, so nothing it would capture is being saved.`,
        'Run `memesh install-hooks` and restart your agent, then end one work session and re-run `memesh doctor`.',
        { code: 'capture-liveness.never-ran', params: { hook, hours: Math.round(measuringHours ?? 0) } }),
      report,
    };
  }

  // #555: recorded errors reach the verdict, ahead of silence — a capture hook
  // that fails on every run also writes nothing, and the error is the cause.
  // Uncoded: a translated catalogue entry for a server-diagnostic sentence
  // would be needed in every dashboard locale, and an uncoded row falls back to
  // this English text there; `params.hook` keeps one hook's dismissal from
  // hiding another's. Only the date of `at` is shown, and only when it is one:
  // the ledger is a file, and this sentence is copied into feedback reports.
  if (verdict.erroringHook) {
    const h = verdict.erroringHook;
    const day = h.lastErrorAt !== null && /^\d{4}-\d{2}-\d{2}/.test(h.lastErrorAt) ? ` on ${h.lastErrorAt.slice(0, 10)}` : '';
    const newest = Math.min(RECENT_ERROR_RUNS, h.triggeredRuns);
    return {
      check: createCheck('capture-liveness', TITLE, 'warn',
        `${h.hook}: ${h.recentErrors} of its ${newest} most recent runs ended in an error (${h.errors} in its recorded window); the latest was '${h.lastErrorReason}'${day}.`,
        h.hook === 'hermes-private-session'
          ? HERMES_MARKER_FIX
          : PRIVATE_STATE_ERROR_FIXES[h.lastErrorReason ?? ''] ?? 'The reason says what failed; `memesh doctor --json` has the per-hook figures. This row clears once the hook\'s most recent runs (those its trigger applied to) end without an error. If it keeps failing, run `memesh install-hooks` and restart your agent.',
        { params: { hook: h.hook } }),
      report,
    };
  }

  if (verdict.silentHook) {
    const h = verdict.silentHook;
    const reason = h.dominantSkipReason ?? 'no reason recorded';
    if (h.hook === 'handoff-capture' && reason === SKIP_REASONS.handoffArchived) {
      return { check: archivedHandoffCheck(TITLE, h.triggeredRuns, archivedHandoffName(outcomeFile)), report };
    }
    return {
      check: createCheck('capture-liveness', TITLE, 'warn',
        `${h.hook}: ${h.triggeredRuns} runs, 0 writes — '${reason}'. The hook is alive and deciding there is nothing to save every single time, which is also what a broken capture path looks like.`,
        'Run `memesh doctor --json` for the per-hook figures. If the reason does not describe your usage, run `memesh install-hooks` and restart your agent.',
        { code: 'capture-liveness.silent-hook', params: { hook: h.hook, runs: h.triggeredRuns, reason } }),
      report,
    };
  }

  // Heartbeats but not one outcome record, well past the grace. Every
  // current hook records on every exit path, so this is one of two things,
  // and neither is "normal right after an upgrade" forever: hooks from a
  // version before outcome tracking are still the ones running, or the
  // hooks crash as they load (a missing `_generated` file — the 4.8.2 and
  // 4.9.4 shape) and leave nothing at all, which the old heartbeats from
  // before the crash would otherwise cover.
  if (hooks.length === 0 && stampedCount > 0
    && measuringHours !== null && measuringHours > NEVER_RAN_GRACE_HOURS) {
    const lastHeartbeat = newestHeartbeatHours === null ? null : Math.round(newestHeartbeatHours);
    return {
      check: createCheck('capture-liveness', TITLE, 'warn',
        `Hooks have run on this machine (last heartbeat ${lastHeartbeat ?? '?'} hours ago), but not one has left an outcome record. Either the running hooks predate outcome tracking, or they fail as they load and record nothing.`,
        'Update the memesh hooks (plugin installs: `/plugin update memesh`; npm installs: `memesh install-hooks`), restart your agent, start one session, and re-run `memesh doctor`. If you just updated, start a session first — the records begin on the next hook run.',
        { code: 'capture-liveness.no-records', params: { hours: lastHeartbeat ?? '?' } }),
      report: { ...report, status: 'PASS_WITH_CONCERNS' },
    };
  }

  if (verdict.stoppedTypes.length > 0) {
    const t = verdict.stoppedTypes[0];
    return {
      check: createCheck('capture-liveness', TITLE, 'warn',
        `Nothing of type '${t.type}' was captured in the last 7 days, against ${t.prev7} in the 7 days before. Something that was being remembered has stopped being remembered.`,
        'Run `memesh doctor --json` for the per-hook figures, and check whether the way you work changed — if it did not, run `memesh install-hooks` and restart your agent.',
        { code: 'capture-liveness.type-stopped', params: { type: t.type, prev: t.prev7 } }),
      report,
    };
  }

  const writing = hooks.filter((h) => h.writes > 0);
  /** Hooks with enough triggered runs that "and wrote nothing" is a statement. */
  const ranEnough = hooks.filter((h) => h.triggeredRuns >= SILENT_HOOK_MIN_RUNS);
  let summary: string;
  if (writing.length > 0) {
    // "did their work", not "wrote something". Several hooks have an effect
    // the user can see and write nothing to the graph — a printed nudge, an
    // injected context block. Those runs record the `notified` outcome
    // (capture-liveness.ts), which is kept out of `writes`, so a hook
    // reaching this branch really did write a memory. The wording stays
    // non-committal anyway: `writes > 0` is the only thing checked here, and
    // one sentence should not promise more than the predicate behind it.
    summary = `${writing.length} of ${hooks.length} recording hooks did their work in their recorded window (${writing.map((h) => h.hook).join(', ')}).`;
  } else if (ranEnough.length > 0) {
    // Consult the RUN COUNTS before explaining a zero. This branch used to
    // assert every hook was below the threshold without looking, so a hook
    // that had run 20 times and written nothing was reported as a fresh
    // install with no records yet — a sentence contradicted by the
    // triggeredRuns figure in the same `--json` output. The hooks that
    // reach here are never SILENT_ELIGIBLE (those return above as a warn),
    // so this stays a `pass`: writing nothing is their ordinary state.
    summary = `${ranEnough.map((h) => `${h.hook} (${h.triggeredRuns} runs)`).join(', ')} ran without writing anything. These hooks decide there is nothing to save on most runs by design, so that is not itself a fault — \`memesh doctor --json\` has the per-hook figures.`;
  } else if (hooks.length > 0) {
    summary = `Every recording hook is below the ${SILENT_HOOK_MIN_RUNS}-run threshold where silence would mean anything — too early to say, which is normal on a fresh install.`;
  } else {
    summary = 'No hook has recorded an outcome yet — the records start on the next hook run, which is normal right after an upgrade.';
  }
  return {
    check: createCheck('capture-liveness', TITLE, 'pass', summary),
    report,
  };
}

/**
 * Is automatic capture deliberately switched off — and by WHICH source?
 *
 * Mirrors the precedence the hooks themselves use (`isAutoCaptureEnabled`
 * in scripts/hooks/_shared.js): env wins over config, and only the explicit
 * strings/values count — a stray env value must not disable capture.
 *
 * The source matters to the caller: config is shared by every process on
 * the machine, while the env var is per-process — doctor observing it in
 * ITS shell says nothing certain about the agent's hooks.
 */
function autoCaptureOffSource(): 'env' | 'config' | null {
  let configAutoCapture: unknown;
  try {
    configAutoCapture = readConfig().autoCapture;
  } catch {
    configAutoCapture = undefined;
  }
  // The precedence itself lives in capture-flag.ts — the same module the
  // hooks execute (via _generated/), so the two sides cannot fork.
  return autoCaptureDecision(process.env.MEMESH_AUTO_CAPTURE, configAutoCapture).offSource;
}

/**
 * Hours between a SQLite timestamp and now, or null if it cannot be read.
 *
 * SQLite writes `datetime('now')` and `CURRENT_TIMESTAMP` as
 * `YYYY-MM-DD HH:MM:SS` in **UTC**, which is not an ISO-8601 string: handing it
 * to `new Date(...)` is implementation-defined, and the engines that do accept
 * it read it as LOCAL time — so the same row measures as "3 hours ago" in
 * London and "11 hours ago" in Taipei, and a capture loop that stopped an hour
 * ago can read as healthy. Parsed explicitly as UTC instead.
 *
 * Returns null rather than 0 for an unreadable value: a corrupt timestamp is
 * "we do not know", and letting it collapse to "just now" would report a dead
 * loop as alive, which is the exact failure this whole check exists to end.
 */
export function hoursSince(sqliteTimestamp: string): number | null {
  // Anchoring, UTC semantics and rollover round-trip all live in
  // parseSqliteUtcMs — the single owner of this parse.
  const then = parseSqliteUtcMs(sqliteTimestamp);
  if (then === null) return null;
  return (Date.now() - then) / (60 * 60 * 1000);
}

/** "3 hours ago" / "6 days ago" — whichever reads as the plainer sentence. */
function formatHoursAgo(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours) || hours < 0) return 'at an unknown time';
  if (hours < 1) return 'less than an hour ago';
  if (hours < 48) {
    const h = Math.round(hours);
    return `${h} hour${h === 1 ? '' : 's'} ago`;
  }
  const d = Math.round(hours / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

function defaultResolveShellMemesh(): string | null {
  // Use `which` on POSIX and `where` on Windows. Both return the first
  // matching binary on PATH. Return null on any failure (not found,
  // command missing, permission error) — caller treats null as "no
  // shell memesh available".
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    // node:child_process is already imported lazily by other doctor checks;
    // re-use the createRequire chain so we don't add a top-level import
    // just for this seam.
    const localRequire = createRequire(import.meta.url);
    const { execFileSync } = localRequire('child_process');
    const out = execFileSync(cmd, ['memesh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const first = String(out).split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return first || null;
  } catch {
    return null;
  }
}

function defaultNativeBindingProbe(_packageRoot: string): { ok: true } | { ok: false; message: string; nodeTooOld?: boolean } {
  try {
    const probe = new MemeshDatabase(':memory:');
    try { probe.prepare('SELECT 1').get(); } finally { probe.close(); }
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err), nodeTooOld: isUnsupportedNode(err) };
  }
}

/**
 * Compare a running Node version against a `>=X.Y.Z` engines range.
 *
 * Deliberately narrow: it understands exactly the one form this package
 * publishes, and says so when it meets anything else. A looser parser that
 * guessed at `^`, `||` or `<` ranges would answer confidently and sometimes
 * wrongly, and the row it feeds is allowed to FAIL — a wrong answer there
 * tells a healthy install it is broken. Returning `null` makes the caller
 * report "not checked", which is the true statement.
 */
export function satisfiesMinimumNodeRange(
  version: string,
  range: string
): boolean | null {
  const min = /^>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(range.trim());
  const running = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!min || !running) return null;

  const wanted = [Number(min[1]), Number(min[2] ?? 0), Number(min[3] ?? 0)];
  const have = [Number(running[1]), Number(running[2]), Number(running[3])];
  for (let i = 0; i < 3; i++) {
    if (have[i] > wanted[i]) return true;
    if (have[i] < wanted[i]) return false;
  }
  return true;
}

/**
 * Report the runtime MeMesh is actually running on.
 *
 * This is a diagnostic, not a survey. Doctor output reaches the maintainers
 * only when a user files a feedback issue, which samples people already
 * having trouble — so nothing here can tell you what the installed base runs,
 * and no `engines` decision should be taken from it. What it does do is close
 * a real gap: a user below the supported floor currently sees hooks
 * misbehaving with no row anywhere connecting that to their Node version.
 *
 * The `node:sqlite` line is attached because this is the one place that
 * already prints runtime facts, and because the native-binding row two
 * positions down fails for exactly the reason `node:sqlite` would not: it
 * needs no compilation. When that row is red, knowing a compile-free SQLite
 * is sitting in the same runtime is the useful next sentence.
 *
 * Everything reported is a property of the machine — version, ABI, platform,
 * arch — and none of it is personal. That matters because `memesh feedback`
 * copies this summary verbatim into a PUBLIC GitHub issue body.
 */
export function inspectNodeRuntime(
  packageRoot: string,
  existsSyncImpl: typeof fs.existsSync,
  readFileSyncImpl: typeof fs.readFileSync,
  nodeVersion: string = process.version,
  moduleAbi: string = process.versions.modules,
  hasNodeSqliteImpl: () => boolean = hasBuiltInSqlite,
): DoctorCheck {
  const facts =
    `Node ${nodeVersion} (ABI ${moduleAbi}, ${process.platform}/${process.arch}). ` +
    `Built-in node:sqlite: ${hasNodeSqliteImpl() ? 'available' : 'not available'}.`;

  let declared: string | undefined;
  try {
    const pkgPath = path.join(packageRoot, 'package.json');
    if (existsSyncImpl(pkgPath)) {
      const parsed = JSON.parse(String(readFileSyncImpl(pkgPath, 'utf8'))) as {
        engines?: { node?: unknown };
      };
      if (typeof parsed.engines?.node === 'string') declared = parsed.engines.node;
    }
  } catch {
    // Unreadable or unparseable package.json — handled as "not checked"
    // below. The manifest row is where a broken package.json belongs.
  }

  if (!declared) {
    return createInfo(
      'node-runtime',
      'Node runtime',
      `${facts} Supported range not checked: package.json declared no engines.node.`,
    );
  }

  const ok = satisfiesMinimumNodeRange(nodeVersion, declared);
  if (ok === null) {
    return createInfo(
      'node-runtime',
      'Node runtime',
      `${facts} Supported range not checked: engines.node is "${declared}", which this ` +
        `check does not parse (it understands ">=X.Y.Z" only).`,
    );
  }
  if (!ok) {
    return createCheck(
      'node-runtime',
      'Node runtime',
      'fail',
      `${facts} This package requires Node ${declared}, so this runtime is BELOW the ` +
        `supported floor. Native modules and hooks may fail in ways that look unrelated.`,
      `Upgrade Node to ${declared.replace(/^>=\s*/, '')} or newer, then run \`memesh doctor\` again.`,
      { code: 'node-runtime.too-old', params: { detail: facts, required: declared.replace(/^>=\s*/, '') } },
    );
  }
  return createCheck(
    'node-runtime',
    'Node runtime',
    'pass',
    `${facts} Meets the required range ${declared}.`,
  );
}

/**
 * Is `node:sqlite` importable in this runtime?
 *
 * Added in Node 22.13 (behind a flag from 22.5). Resolved rather than imported, so the check costs
 * nothing and — importantly — does not trigger the `ExperimentalWarning`
 * that Node 22 prints to stderr on first use. Seven hooks parse process
 * output; a warning emitted by a diagnostic would be a regression caused by
 * the diagnostic.
 */
export function hasBuiltInSqlite(): boolean {
  try {
    createRequire(import.meta.url).resolve('node:sqlite');
    return true;
  } catch {
    return false;
  }
}
function inspectNativeBinding(
  packageRoot: string,
  _existsSyncImpl: typeof fs.existsSync,
  probeImpl: (packageRoot: string) => { ok: true } | { ok: false; message: string; nodeTooOld?: boolean } = defaultNativeBindingProbe,
): DoctorCheck {
  const result = probeImpl(packageRoot);
  if (result.ok) return createCheck('native-binding', 'SQLite', 'pass', 'node:sqlite opened a database (probe succeeded).');
  const failed = { code: 'native-binding.load-failed', params: { detail: result.message, root: packageRoot } };
  if (result.nodeTooOld) {
    return createCheck('native-binding', 'SQLite', 'fail', 'SQLite is not usable on this Node version (the Database row above says why).', NODE_TOO_OLD_FIX, failed);
  }
  return createCheck('native-binding', 'SQLite', 'fail', `SQLite could not open a database: ${result.message}`, 'Check the Node runtime and reinstall if necessary.', failed);
}

/**
 * Read `version` from the nearest package.json above a resolved binary path.
 *
 * `which`/`where` return the PATH entry, and every packaged install ships
 * `memesh` as a symlink (npm's own bin-linking) — e.g. nvm's
 * `bin/memesh -> ../lib/node_modules/@pcircle/memesh/dist/transports/cli/cli.js`.
 * `realpathSync` follows that, then this walks upward looking for the
 * package.json it belongs to. It only trusts the first one found, and only
 * when its `name` matches this package — otherwise the walk crossed a
 * package boundary (a workspace root, an unrelated wrapper) and the version
 * it would report describes the wrong thing.
 */
function readVersionFromInstalledBinary(
  binaryPath: string,
  existsSyncImpl: typeof fs.existsSync,
  readFileSyncImpl: typeof fs.readFileSync,
  realpathSyncImpl: typeof fs.realpathSync = fs.realpathSync,
): string | null {
  let resolved: string;
  try {
    resolved = realpathSyncImpl(binaryPath);
  } catch {
    // Broken symlink or a fake path injected by a test — fall back to the
    // raw value so the walk below still has somewhere to start from.
    resolved = binaryPath;
  }
  let dir = path.dirname(resolved);
  // Bounded, not unbounded: a real install is at most a handful of
  // directories below its package.json (npm-global: bin -> lib/node_modules/
  // @pcircle/memesh, four levels; source checkout: dist/transports/cli, three).
  // Unbounded walking risks reaching an unrelated package.json near the
  // filesystem root and misreporting its version as memesh's own.
  for (let depth = 0; depth < 8; depth += 1) {
    const pkgPath = path.join(dir, 'package.json');
    if (existsSyncImpl(pkgPath)) {
      const parsed = parseJsonFile(pkgPath, readFileSyncImpl);
      if (!parsed.ok) return null;
      const { name, version } = parsed.value as { name?: unknown; version?: unknown };
      return name === '@pcircle/memesh' && typeof version === 'string' ? version : null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Detect the "plugin without shell CLI" gotcha that confuses every new
 * plugin-marketplace user. Symptom: `/plugin install memesh@pcircle-memesh`
 * gives you MCP tools + hooks + the `/memesh` skill inside Claude Code,
 * but does NOT put `memesh` on the shell `PATH`. Users then try
 * `memesh reindex` in a terminal and see `command not found: memesh`.
 *
 * Resolution: also run `npm install -g @pcircle/memesh` when shell access is
 * wanted. Storage identity depends on each process's configuration.
 *
 * This check fires WARN only on plugin-marketplace installs that lack
 * a separate shell-PATH `memesh`. For npm-global / source-checkout
 * channels the check reports PASS with the resolved path. We don't
 * gate it as FAIL because plugin-only is a valid setup for users who
 * only ever interact with memesh through Claude Code chat.
 *
 * A distinct shell CLI is also a distinct COPY on disk, and nothing keeps
 * the two copies at the same version — the plugin marketplace's own
 * auto-updater only ever touches the plugin cache (see
 * `inspectPluginCacheCurrency`'s docstring on the #247 incident), so an
 * agent using this install and a human typing `memesh` in a terminal can
 * silently run different code for as long as nobody manually updates the
 * global copy. Read the other copy's own package.json (never trust
 * `--version` output — that would mean spawning it) and say so.
 */
function inspectShellCli(
  installChannel: import('./install-channel.js').InstallChannel,
  packageRoot: string,
  packageVersion: string,
  resolveShellMemeshImpl: () => string | null,
  existsSyncImpl: typeof fs.existsSync,
  readFileSyncImpl: typeof fs.readFileSync,
): DoctorCheck {
  const shellPath = resolveShellMemeshImpl();
  // Normalize and compare: a shell `memesh` that points back into the
  // same install we're currently running from isn't a "separate" shell
  // CLI — it's the same one. The common case where this matters is
  // plugin-marketplace, where `which memesh` returns null and the user
  // typed `memesh doctor` via some launcher / npx.
  const isSameAsCurrent = shellPath ? path.resolve(shellPath).startsWith(path.resolve(packageRoot)) : false;
  const hasDistinctShellCli = !!shellPath && !isSameAsCurrent;

  if (installChannel === 'npm-global') {
    return createCheck(
      'shell-cli',
      'Shell CLI on PATH',
      'pass',
      shellPath
        ? `\`memesh\` resolves to ${shellPath} (npm-global install — terminals across the machine pick it up).`
        : 'Running from npm-global install — shell access available in this terminal.',
    );
  }

  if (hasDistinctShellCli) {
    const shellVersion = readVersionFromInstalledBinary(shellPath!, existsSyncImpl, readFileSyncImpl);
    if (shellVersion) {
      // Local version skew does not establish a published update, a broken
      // install, or shared storage. Registry-backed update checks own advice.
      return {
        ...createInfo('shell-cli', 'Shell CLI on PATH',
          `Installed versions: this interface ${packageVersion}; terminal ${shellVersion}.`),
        code: 'shell-cli.versions',
        params: { current: packageVersion, terminal: shellVersion, shellPath: shellPath!, packageRoot },
      };
    }

    return createCheck(
      'shell-cli',
      'Shell CLI on PATH',
      'pass',
      `\`memesh\` resolves to ${shellPath} (separate from this install at ${packageRoot}) — could not read the shell copy's own version to compare.`,
    );
  }

  if (installChannel === 'plugin-marketplace') {
    const host = detectPluginHost(packageRoot) === 'codex' ? 'Codex CLI' : 'Claude Code';
    return createCheck(
      'shell-cli',
      'Shell CLI on PATH',
      'warn',
      'Plugin is installed but `memesh` is not on the shell PATH. Typing `memesh` in a regular terminal will report `command not found`. '
        + `${host} MCP / hooks / \`/memesh\` skill still work — this only affects standalone shell usage and other MCP clients (Cursor, Cline, etc.).`,
      'Run `npm install -g @pcircle/memesh` if you want the separate shell CLI. Its database path depends on its environment and configuration.',
      { code: 'shell-cli.not-on-path' },
    );
  }

  // source-checkout / npm-local / unknown — informational only.
  return createCheck(
    'shell-cli',
    'Shell CLI on PATH',
    'pass',
    shellPath
      ? `\`memesh\` resolves to ${shellPath}.`
      : `No shell-PATH \`memesh\` detected. If you want terminal access, run \`npm install -g @pcircle/memesh\` (this install is a ${installChannel}, so the check is informational only).`,
  );
}

/** Where a plugin host keeps its marketplace checkout and what commit it is at. */
function defaultMarketplaceHeadSha(host: PluginHost): string | null {
  if (host === 'codex') {
    // Codex snapshots the marketplace under $CODEX_HOME/.tmp/marketplaces and
    // records the revision it fetched next to it; the same file is copied
    // into the plugin cache on `codex plugin add`, which is what lets the two
    // be compared without a registry.
    const codexHome = pluginHostConfigRoot('codex');
    return readCodexInstallRevision(path.join(codexHome, '.tmp', 'marketplaces', 'pcircle-memesh'), fs.readFileSync);
  }
  const dir = path.join(pluginHostConfigRoot('claude-code'), 'plugins', 'marketplaces', 'pcircle-memesh');
  try {
    const out = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return /^[0-9a-f]{40}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

function readCodexInstallRevision(root: string, readFileSyncImpl: typeof fs.readFileSync): string | null {
  const parsed = parseJsonFile(path.join(root, '.codex-marketplace-install.json'), readFileSyncImpl);
  if (!parsed.ok) return null;
  const rev = (parsed.value as { revision?: unknown }).revision;
  return typeof rev === 'string' && /^[0-9a-f]{40}$/.test(rev) ? rev : null;
}

function pluginCacheUnverifiable(host: PluginHost, missing: string): DoctorCheck {
  const hostLabel = host === 'codex' ? 'Codex' : 'Claude Code';
  const command = PLUGIN_REFRESH_COMMANDS[host];
  return createCheck(
    'plugin-cache',
    `Plugin cache source record is current (${hostLabel})`,
    'warn',
    `Could not tell whether the plugin cache matches the marketplace: ${missing}. The version alone cannot answer this — two builds can carry the same version.`,
    `Run \`${command}\` — it puts this version back through the same checks an update takes (source check, database backup) and records the commit, after which this check can answer.`,
    { code: 'plugin-cache.unverifiable', params: { host: hostLabel, command } },
    'plugin-cache-refresh',
  );
}

function readClaudePluginEntries(
  registryPath: string,
  readFileSyncImpl: typeof fs.readFileSync,
  existsSyncImpl: typeof fs.existsSync,
): ClaudePluginEntries {
  if (!existsSyncImpl(registryPath)) {
    return { exists: false, readable: false, defined: false, malformed: false, entries: [] };
  }
  const parsed = parseJsonFile(registryPath, readFileSyncImpl);
  if (!parsed.ok) return { exists: true, readable: false, defined: false, malformed: false, entries: [] };
  const raw = (parsed.value as { plugins?: Record<string, unknown> })?.plugins?.['memesh@pcircle-memesh'];
  const entries = Array.isArray(raw)
    ? raw.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
    : [];
  return {
    exists: true,
    readable: true,
    defined: raw !== undefined,
    malformed: raw !== undefined && (!Array.isArray(raw) || entries.length !== raw.length),
    entries,
  };
}

/** Find installed host caches without making a global install pretend to be one. */
function defaultPluginCacheDiscovery(
  readFileSyncImpl: typeof fs.readFileSync,
  existsSyncImpl: typeof fs.existsSync,
): PluginCacheDiscovery[] {
  const discovered: PluginCacheDiscovery[] = [];
  const claudeConfigRoot = pluginHostConfigRoot('claude-code');
  const claudeRegistry = path.join(claudeConfigRoot, 'plugins', 'installed_plugins.json');
  const claudeCacheRoot = path.join(claudeConfigRoot, 'plugins', 'cache', 'pcircle-memesh', 'memesh');
  const registry = readClaudePluginEntries(claudeRegistry, readFileSyncImpl, existsSyncImpl);
  const entries = registry.entries;
  if (registry.malformed) {
    discovered.push({
      host: 'claude-code',
      packageRoot: claudeCacheRoot,
      installedPluginsPath: claudeRegistry,
      unverifiableReason: 'installed_plugins.json has a malformed memesh entry',
    });
  } else if (entries.length > 0) {
    const cachesByRoot = new Map<string, PluginCacheDiscovery>();
    for (const entry of entries) {
      const recordedInstallPath = typeof entry.installPath === 'string' && entry.installPath.length > 0
        ? entry.installPath
        : null;
      const installPath = recordedInstallPath ?? claudeCacheRoot;
      const cache = {
        host: 'claude-code', packageRoot: installPath, installedPluginsPath: claudeRegistry,
        ...(!recordedInstallPath ? { unverifiableReason: 'an installed_plugins.json entry has no usable installPath' }
          : !existsSyncImpl(installPath) ? { unverifiableReason: `the recorded plugin cache does not exist at ${installPath}` } : {}),
      } satisfies PluginCacheDiscovery;
      const rootKey = path.resolve(installPath);
      const existing = cachesByRoot.get(rootKey);
      if (!existing) cachesByRoot.set(rootKey, cache);
      else if (!existing.unverifiableReason && cache.unverifiableReason) {
        existing.unverifiableReason = cache.unverifiableReason;
      }
    }
    discovered.push(...cachesByRoot.values());
  } else if (registry.defined) {
    const cachedRoots = versionedPluginCacheRoots(claudeCacheRoot);
    // An empty array can be a clean uninstall, so report it only when a cache
    // still exists and the registry/cache state contradict each other.
    if (cachedRoots.length > 0) {
      discovered.push({
        host: 'claude-code',
        packageRoot: cachedRoots[cachedRoots.length - 1],
        installedPluginsPath: claudeRegistry,
        unverifiableReason: 'installed_plugins.json records no active memesh install while a versioned plugin cache still exists',
      });
    }
  } else if (!registry.readable) {
    const cachedRoots = versionedPluginCacheRoots(claudeCacheRoot);
    const cachedRoot = cachedRoots[cachedRoots.length - 1];
    // A missing or corrupt registry alone is not evidence that MeMesh is
    // installed; a real cache plus either condition is safely reported as unknown.
    if (cachedRoot) {
      discovered.push({
        host: 'claude-code', packageRoot: cachedRoot, installedPluginsPath: claudeRegistry,
        unverifiableReason: registry.exists
          ? 'installed_plugins.json could not be read or parsed'
          : 'installed_plugins.json does not exist while a versioned plugin cache still exists',
      });
    }
  }

  const codexHome = pluginHostConfigRoot('codex');
  const codexCacheRoot = path.join(codexHome, 'plugins', 'cache', 'pcircle-memesh', 'memesh');
  const codexRoots = versionedPluginCacheRoots(codexCacheRoot);
  if (codexRoots.length === 1) {
    discovered.push({ host: 'codex', packageRoot: codexRoots[0] });
  } else if (codexRoots.length > 1) {
    discovered.push({
      host: 'codex',
      packageRoot: codexRoots[codexRoots.length - 1],
      unverifiableReason: `several versioned Codex plugin cache directories exist under ${codexCacheRoot}`,
    });
  }
  return discovered;
}

/**
 * Both plugin hosts key their cache by VERSION: once
 * `<host>/plugins/cache/pcircle-memesh/memesh/<version>/` exists, later
 * marketplace updates that keep the same version never refresh it (Claude
 * Code skips the copy; Codex only re-copies on an explicit `plugin add`). A machine
 * that auto-updated between the commit that bumped package.json to 4.8.2 and
 * the fix PRs merged under that same version ran a "4.8.2" MCP server with
 * 19 commits missing, and every version check said it was current. Compare
 * the commit the cache was staged from with the one the marketplace has —
 * Claude Code records it in installed_plugins.json, Codex in the
 * `.codex-marketplace-install.json` it copies into the cache.
 *
 * On npm-global installs this same helper is also run once for each installed
 * host cache discovered by `defaultPluginCacheDiscovery`. The caller assigns a
 * host-specific id so Claude Code and Codex never collapse into one result.
 */
function inspectPluginCacheCurrency(
  installChannel: import('./install-channel.js').InstallChannel,
  pluginHost: import('./install-channel.js').PluginHost | null,
  packageRoot: string,
  installedPluginsPath: string | undefined,
  readFileSyncImpl: typeof fs.readFileSync,
  existsSyncImpl: typeof fs.existsSync,
  marketplaceHeadShaImpl: (host: import('./install-channel.js').PluginHost) => string | null,
): DoctorCheck | null {
  if (installChannel !== 'plugin-marketplace') return null;
  // Same rule as inspectShellCli: on a plugin-marketplace channel, anything
  // that is not Codex is Claude Code (the host walk is path-based and a
  // relocated cache reports null).
  const host: import('./install-channel.js').PluginHost = pluginHost === 'codex' ? 'codex' : 'claude-code';
  const hostLabel = host === 'codex' ? 'Codex' : 'Claude Code';
  const command = PLUGIN_REFRESH_COMMANDS[host];

  let installedSha: string | null;
  let installedMissing: string;
  // The version Claude Code's own record says it installed (Codex's revision marker carries none).
  let recordedVersion: string | null = null;
  if (host === 'codex') {
    installedSha = readCodexInstallRevision(packageRoot, readFileSyncImpl);
    installedMissing = 'the plugin cache carries no readable .codex-marketplace-install.json revision';
  } else {
    const registryPath = installedPluginsPath ?? path.join(pluginHostConfigRoot('claude-code'), 'plugins', 'installed_plugins.json');
    const registry = readClaudePluginEntries(registryPath, readFileSyncImpl, existsSyncImpl);
    const entries = registry.entries;
    // One entry per scope (user / project / local). Read the entry for THIS
    // install — entries[0] on a two-scope machine describes another cache.
    const here = path.resolve(packageRoot);
    const matching = entries.filter(e => typeof e?.installPath === 'string' && path.resolve(e.installPath) === here);
    // Exactly one path match identifies this install. Two rows naming the
    // same cache are corrupt/ambiguous registry state: reading matching[0]
    // would let a current row hide a stale duplicate and falsely PASS.
    // This is intentionally stricter than upgrade-plugin.sh's recovery path:
    // that script may repair a sole legacy row with no installPath by writing
    // the canonical cache path, while doctor cannot use that row as evidence
    // that the currently executing cache was built from its recorded commit.
    const soleEntry = entries.length === 1 ? entries[0] : undefined;
    const soleEntryHasPath = typeof soleEntry?.installPath === 'string' && soleEntry.installPath.length > 0;
    const entry = matching.length === 1 ? matching[0] : undefined;
    recordedVersion = typeof entry?.version === 'string' ? entry.version : null;
    installedSha = !registry.malformed
      && typeof entry?.gitCommitSha === 'string'
      && /^[0-9a-f]{40}$/.test(entry.gitCommitSha)
      ? entry.gitCommitSha
      : null;
    if (!registry.exists) {
      installedMissing = `installed_plugins.json does not exist at ${registryPath}`;
    } else if (!registry.readable) {
      installedMissing = 'installed_plugins.json could not be read or parsed';
    } else if (registry.malformed) {
      installedMissing = 'installed_plugins.json has a malformed memesh entry';
    } else if (!registry.defined) {
      installedMissing = 'installed_plugins.json has no memesh@pcircle-memesh entry';
    } else if (entries.length === 0) {
      installedMissing = 'installed_plugins.json records no active memesh install for this cache';
    } else if (matching.length > 1) {
      installedMissing = `installed_plugins.json lists ${matching.length} memesh entries for this install (${packageRoot})`;
    } else if (matching.length === 0 && soleEntryHasPath) {
      installedMissing = `the only memesh entry in installed_plugins.json names another install, not this one (${packageRoot})`;
    } else if (matching.length === 0 && soleEntry) {
      installedMissing = 'the only memesh entry in installed_plugins.json has no usable installPath to identify this cache';
    } else if (entries.length > 1 && matching.length === 0) {
      installedMissing = `installed_plugins.json lists ${entries.length} memesh entries and none of them is this install (${packageRoot})`;
    } else {
      installedMissing = 'installed_plugins.json does not record the commit this plugin was installed from';
    }
  }
  const marketplaceSha = marketplaceHeadShaImpl(host);

  if (!installedSha || !marketplaceSha) {
    const missing = !installedSha ? installedMissing : `the ${hostLabel} marketplace snapshot has no readable commit`;
    return pluginCacheUnverifiable(host, missing);
  }

  if (installedSha === marketplaceSha) {
    return createCheck(
      'plugin-cache',
      `Plugin cache source record is current (${hostLabel})`,
      'pass',
      `The plugin cache records marketplace commit ${marketplaceSha.slice(0, 8)}, which matches the current marketplace snapshot.`,
    );
  }

  const params = { installed: installedSha.slice(0, 8), marketplace: marketplaceSha.slice(0, 8), host: hostLabel, command };
  // Two different things look alike here. The marketplace branch moves ahead of the last release all the time: the plugin stays on the
  // release MeMesh verified, which is how it is meant to work, and there is nothing to do. But when the record of what was installed
  // names another version than the package that is running, the cache and the record disagree: that is damage, and it is repaired.
  let runningVersion: string | null = null;
  try { runningVersion = JSON.parse(readFileSyncImpl(path.join(packageRoot, 'package.json'), 'utf8') as string).version ?? null; } catch { /* unreadable: no claim of a mismatch */ }
  if (recordedVersion !== null && typeof runningVersion === 'string' && recordedVersion !== runningVersion) {
    return createCheck(
      'plugin-cache',
      `Plugin cache source record is current (${hostLabel})`,
      'warn',
      `${hostLabel}'s record says version ${recordedVersion} is installed from commit ${installedSha.slice(0, 8)}, but the plugin running here is ${runningVersion}: the cache and the record disagree.`,
      'Run `memesh update --reinstall`: it puts the verified release back (source check, commit on main, pinned dependencies, read-back) and rewrites the record.',
      { code: 'plugin-cache.stale', params },
    );
  }
  return createCheck(
    'plugin-cache',
    `Plugin cache source record is current (${hostLabel})`,
    'pass',
    `The plugin cache records commit ${installedSha.slice(0, 8)}; the ${hostLabel} marketplace has since moved to ${marketplaceSha.slice(0, 8)}. The installed plugin stays on the release MeMesh verified: the marketplace branch is ahead of the last release, and its newer code has not been checked. Nothing to do; \`memesh update\` moves to the next release when one is published.`,
    undefined,
    { code: 'plugin-cache.behind-marketplace', params },
  );
}


function isClaudeChannelCommand(command: unknown): boolean {
  if (command === 'memesh-host-claude') return true;
  if (typeof command !== 'string' || !path.isAbsolute(command) || path.basename(command) !== 'memesh-host-claude') {
    return false;
  }
  try {
    const target = fs.realpathSync(command);
    const stat = fs.statSync(target);
    if (!stat.isFile()) return false;
    fs.accessSync(target, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Inspect Claude's user-scoped MCP registration without treating transport
 * initialization or router state as channel admission. The user-scope
 * registry lives in ~/.claude.json; only the memesh-channel entry and the
 * config file it names are read.
 */
function inspectClaudeChannelRegistration(
  existsSyncImpl: typeof fs.existsSync,
  readFileSyncImpl: typeof fs.readFileSync,
): DoctorCheck {
  const configPath = path.join(homeDir(), '.claude.json');
  let parsed: JsonObject | null = null;
  if (existsSyncImpl(configPath)) {
    try {
      const value = JSON.parse(readFileSyncImpl(configPath, 'utf8')) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
      parsed = value as JsonObject;
    } catch {
      return createCheck(
        'claude-channel',
        'Claude Channel registration',
        'warn',
        'The canonical Claude user config could not be read as JSON, so the memesh-channel registration is malformed or unverifiable.',
        'Repair the owner-controlled Claude config with `claude mcp remove memesh-channel` and re-run `memesh agent setup claude` to obtain a fresh registration command.',
      );
    }
  }

  const servers = parsed?.mcpServers;
  const server = servers && typeof servers === 'object' && !Array.isArray(servers)
    ? (servers as JsonObject)['memesh-channel']
    : undefined;
  if (server === undefined) {
    return createCheck(
      'claude-channel',
      'Claude Channel registration',
      'warn',
      'No user-scoped memesh-channel registration was found. Durable MCP/inbox messaging can still work, but live Claude Channel notification is inactive. The upstream research-preview channel remains opt-in.',
      'If you want the opt-in channel, run `memesh agent setup claude` and then register the printed user-scoped MCP command.',
      { code: 'claude-channel.unregistered' },
    );
  }

  const record = server && typeof server === 'object' && !Array.isArray(server)
    ? server as JsonObject
    : null;
  const command = record?.command;
  const rawArgs = record?.args;
  const args = Array.isArray(rawArgs) ? rawArgs : null;
  const configIndex = args?.indexOf('--config') ?? -1;
  const target = args && configIndex >= 0 && typeof args[configIndex + 1] === 'string'
    ? args[configIndex + 1] as string
    : null;
  let targetConfigValid = false;
  if (target) {
    try {
      const config = readHostConfigFile<JsonObject>(target);
      // #474: `project` is deliberately absent — the Claude channel host no
      // longer reads it (it derives its routing project from its own
      // working directory), so a config missing it is coherent, not broken.
      const required = ['router_socket', 'token_file', 'principal_id'];
      targetConfigValid = config.server_name === 'memesh-channel'
        && required.every((key) => {
          const value = config[key];
          return typeof value === 'string'
            && value.length > 0
            && Buffer.byteLength(value) <= 4096;
        });
    } catch {
      targetConfigValid = false;
    }
  }
  const commandValid = isClaudeChannelCommand(command);
  const coherent = commandValid
    && args !== null
    && args.length === 2
    && configIndex === 0
    && target !== null
    && targetConfigValid;
  if (!coherent) {
    const reason = !commandValid || args === null || configIndex !== 0 || target === null
      ? 'the command or --config declaration is malformed'
      : 'the declared owner config target is missing, insecure, malformed, or incomplete';
    return createCheck(
      'claude-channel',
      'Claude Channel registration',
      'warn',
      `The user-scoped memesh-channel registration is present but ${reason}. Live Claude Channel notification is not established.`,
      'Remove and re-register the owner-controlled memesh-channel entry with `memesh agent setup claude`; keep its generated config file owner-private.',
    );
  }

  return createInfo(
    'claude-channel',
    'Claude Channel registration',
    'The user-scoped memesh-channel registration and owner-private config target are coherent (CONFIGURED). Development-channel admission and agent surfacing are not verified; durable MCP/inbox messaging remains a separate path.',
  );
}

/**
 * True when the install is younger than the same 24h grace period the
 * hook-wiring check already gives a fresh install (line ~873): "no
 * successful update check yet" is expected for a install a few minutes
 * old and is not evidence of anything.
 *
 * How old it is comes from `install.json`'s `created_at` when that file
 * exists (ISO-8601 from `toISOString()`, NOT the SQLite `YYYY-MM-DD HH:MM:SS`
 * shape `hoursSince` parses). Doctor never creates that file: a diagnostic must
 * not be what leaves state behind on a machine nobody has used. When it is not
 * there, the age is that of the installed package itself: when this version's
 * `package.json` was put on disk (birth time, falling back to the inode change
 * time where the filesystem has no birth time). So the basis is "how long ago
 * was THIS version installed": an automatic update that reinstalls the package
 * starts the 24 hours again, and for that day the row says "installed recently"
 * instead of warning that the update status is unknown.
 *
 * An age that cannot be read (no such file, permissions, a time in the future)
 * is "cannot tell", never "recent": the caller then gives the ordinary warning
 * rather than hiding it.
 */
function isFreshInstall(packageRoot: string, statSyncImpl: typeof fs.statSync): boolean {
  const HOUR_MS = 60 * 60 * 1000;
  try {
    const record = readInstallRecordState();
    if (record.status === 'ok') {
      // A record with no usable creation time, or one in the future, says nothing about the age: cannot tell.
      if (record.created_at === null) return false;
      const ageHours = (Date.now() - new Date(record.created_at).getTime()) / HOUR_MS;
      return ageHours >= 0 && ageHours < 24;
    }
    // A record that is there but unusable is not "no record": its age is unknown, so cannot tell.
    if (record.status === 'unreadable') return false;
    const stat = statSyncImpl(path.join(packageRoot, 'package.json'));
    const installedAt = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.ctimeMs;
    if (!Number.isFinite(installedAt) || installedAt <= 0) return false;
    const ageHours = (Date.now() - installedAt) / HOUR_MS;
    return ageHours >= 0 && ageHours < 24;
  } catch {
    return false;
  }
}

/**
 * What the automatic updater last did, read from the record it writes for every
 * attempt (nothing is inferred). A failed attempt is the only warning: skipped
 * and waiting are the updater doing what its settings say.
 */
function inspectAutoUpdate(installSupport?: import('./install-channel.js').InstallChannelSupport): DoctorCheck {
  const policy = currentPolicy();
  const cannotSelfUpdate = installSupport !== undefined && !installSupport.canSelfUpdate;
  const setting = policy.policy === 'off'
    ? `off (${policy.reason ?? 'policy is off'})`
    : cannotSelfUpdate
      ? `on in the settings, but this install (${installSupport.label}) cannot update itself, so nothing is installed. ${installSupport.guidance}`
      : `on for ${policy.policy === 'major' ? 'every version' : `${policy.policy} versions and below`}; it installs after running sessions end (waiting at most 3 days, after which sessions still open may use the new files before they restart)`;
  const dataDir = getMemeshDirFromDbPath();
  const read = inspectAutoUpdateState(dataDir);
  const installing = readInstalling(dataDir);
  if (installing && !installing.running) {
    return createCheck(
      'auto-update',
      'Automatic updates',
      'warn',
      `Automatic updates are ${setting}. An update from ${installing.marker.from} to ${installing.marker.to} began its install at ${installing.marker.at}, and the process that ran it is gone without recording a result, so the install may be half done.`,
      `Put this version back through the same checks with \`memesh update --reinstall\` (a database backup was made before the install began: see ${path.join(dataDir, 'backups')}). Details: ${path.join(dataDir, 'auto-update.log')}.`,
      { code: 'auto-update.interrupted' },
    );
  }
  const holder = describeLockHolder(dataDir);
  if (holder && !holder.running) {
    return createCheck(
      'auto-update',
      'Automatic updates',
      'warn',
      `Automatic updates are ${setting}. The update lock was left behind by a ${holder.label === 'manual' ? 'manual' : 'automatic'} update (pid ${holder.pid}, started ${holder.startedAt}) that is no longer running.`,
      `Nothing to do: the next update attempt takes the lock over about 2 minutes after its owner is found gone. Details: ${path.join(dataDir, 'auto-update.log')}.`,
      { code: 'auto-update.lock-orphan' },
    );
  }
  const running = installing?.running ? ` An install to ${installing.marker.to} is running now (since ${installing.marker.at}).` : holder?.running ? ` An update is running now (started ${holder.startedAt}, ${holder.label === 'manual' ? 'by hand' : 'automatic'}).` : '';
  if (read.kind === 'unreadable') {
    return createCheck(
      'auto-update',
      'Automatic updates',
      'warn',
      `Automatic updates are ${setting}. The record of the last attempt cannot be read (${read.detail}), so it is not known whether one ran or failed.`,
      `Look at ${path.join(dataDir, 'auto-update-state.json')} and ${path.join(dataDir, 'auto-update.log')}; removing the damaged record (a file, or a directory that is in its place) is safe: the next attempt writes a new one.`,
      { code: 'auto-update.state-unreadable' },
    );
  }
  if (read.kind === 'absent') {
    return createCheck('auto-update', 'Automatic updates', 'pass', `Automatic updates are ${setting}. No attempt has run yet.${running}`);
  }
  const state = read.state;
  const waitedDays = state.outcome === 'waiting' && state.waitingSince ? Math.floor((Date.now() - Date.parse(state.waitingSince)) / 86_400_000) : null;
  // Older state files have no `hermes` field and a run with no copy records null: both mean nothing to list.
  const hermesResults = Array.isArray(state.hermes) ? state.hermes : [];
  const hermesNotes = hermesResults.map((h) => ` Hermes provider at ${h.path}: ${h.outcome} — ${h.reason}.`).join('');
  const what = `Last attempt ${state.at}: ${state.outcome} — ${state.reason}${state.to ? ` (${state.from ?? '?'} → ${state.to})` : ''}${waitedDays !== null && waitedDays >= 0 ? `; waiting for ${waitedDays} day(s) of the 3 allowed` : ''}.${hermesNotes}${state.notice ? ` Note: ${state.notice}.` : ''}${running}`;
  const logPath = path.join(dataDir, 'auto-update.log');
  const hermesAdvice = `To put the Hermes provider in place by hand: \`memesh hermes install\` (add \`--path <dir>\` for a copy outside the default place; a directory MeMesh did not install is only replaced with \`--force\`, and is saved first). Read ${logPath} for the reason.`;
  // The wait has a limit (3 days): past it the updater installs anyway. Still waiting means it is not running or cannot finish.
  if (waitedDays !== null && waitedDays >= 3) {
    return createCheck(
      'auto-update',
      'Automatic updates',
      'warn',
      `Automatic updates are ${setting}. ${what}`,
      `The wait for running sessions is limited to 3 days, so the update should have installed by now: its runner is probably not running. Update now with \`${installSupport?.recommendedCommand ?? 'memesh update'}\` (it does not wait for sessions); read ${logPath} for what the runner said.`,
      { code: 'auto-update.wait-overdue' },
    );
  }
  if (state.reason === AUTO_UPDATE_REASONS.installedAfterWait) {
    return createCheck(
      'auto-update',
      'Automatic updates',
      'warn',
      `Automatic updates are ${setting}. ${what}`,
      `Restart the sessions that were open during the update so they run the new version together with their hooks.${hermesResults.some((h) => h.outcome === 'failed') ? ` ${hermesAdvice}` : ''}`,
      { code: 'auto-update.mixed-versions' },
    );
  }
  if (hermesResults.some((h) => h.outcome === 'failed')) {
    return createCheck(
      'auto-update',
      'Automatic updates',
      'warn',
      `Automatic updates are ${setting}. ${what}`,
      hermesAdvice,
      { code: 'auto-update.hermes-failed' },
    );
  }
  if (state.reason === AUTO_UPDATE_REASONS.codexMarketplaceMissing) {
    return createCheck(
      'auto-update',
      'Automatic updates',
      'warn',
      `Automatic updates are ${setting}. ${what}`,
      'The Codex marketplace pcircle-memesh is not in config.toml, and MeMesh did not remove it, so it is taken as removed on purpose and the Codex plugin is not being updated. If that was on purpose, nothing to do. To get it back, pinned to the verified release: `memesh update --reinstall`.',
      { code: 'auto-update.codex-marketplace-missing' },
    );
  }
  if (state.reason === AUTO_UPDATE_REASONS.codexRestoreFailed) {
    return createCheck(
      'auto-update',
      'Automatic updates',
      'warn',
      `Automatic updates are ${setting}. ${what}`,
      'An update removed the Codex marketplace pcircle-memesh and then failed before it could put it back: it is missing because of that update, not because you removed it. The next automatic run puts it back while config.toml is unchanged; to do it now: `codex plugin marketplace add PCIRCLE-AI/memesh`, then `memesh update --reinstall`.',
      { code: 'auto-update.codex-restore-failed' },
    );
  }
  if (state.reason === AUTO_UPDATE_REASONS.dependencyPinFailed) {
    // The install was undone: the version that was running is still the one that runs, and the next update tries the same release again.
    return createCheck(
      'auto-update',
      'Automatic updates',
      'warn',
      `Automatic updates are ${setting}. ${what}`,
      `The update was undone and ${state.from ?? 'the previous version'} is still what runs: nothing is broken. The next automatic run, or \`memesh update\`, tries again. If it keeps failing, read ${path.join(getMemeshDirFromDbPath(), 'auto-update.log')} for the step that failed (usually the network or the registry).`,
      { code: 'auto-update.pin-undone' },
    );
  }
  if (state.outcome === 'failed') {
    const log = path.join(getMemeshDirFromDbPath(), 'auto-update.log');
    const backup = state.backup ? ` A database backup was made first: ${state.backup}` : '';
    // A package whose source did not check out must not be installed by other means
    // either (a bare npm install skips the check); `memesh update` runs the same check.
    const sourceRejected = state.reason === AUTO_UPDATE_REASONS.sourceNotVerified || state.reason === AUTO_UPDATE_REASONS.tarballMismatch || state.reason === AUTO_UPDATE_REASONS.commitNotOnMain || state.reason === AUTO_UPDATE_REASONS.dependenciesNotPinned;
    const fix = state.reason === AUTO_UPDATE_REASONS.installNotUndone
      ? `Run \`memesh update --reinstall\`: it puts this version back through the same checks and finishes the install. Until then MeMesh may not start (its dependencies are missing). Read ${log} for what happened.${backup}`
      : sourceRejected
      ? `Do not install this version by other means (${installSupport?.channel === 'npm-global' || installSupport === undefined ? 'a bare npm install' : 'installing it from the marketplace yourself'}): that skips the check of where the package came from. \`memesh update\` runs the same check and will refuse too. Read ${log} for the check that failed; if it keeps failing, report it.${backup}`
      : installSupport?.recommendedCommand
        ? `Read ${log} for the step that failed, then update by hand with \`${installSupport.recommendedCommand}\`.${backup}`
        : `Read ${log} for the step that failed, then update the way you installed MeMesh.${backup}`;
    return createCheck('auto-update', 'Automatic updates', 'warn', `Automatic updates are ${setting}. ${what}`, fix, { code: 'auto-update.failed' });
  }
  return createCheck('auto-update', 'Automatic updates', 'pass', `Automatic updates are ${setting}. ${what}`);
}

async function inspectUpdateStatus(
  packageVersion: string,
  getUpdateCheckImpl: typeof getUpdateCheck,
  installSupport: import('./install-channel.js').InstallChannelSupport | undefined,
  packageRoot: string,
  statSyncImpl: typeof fs.statSync,
): Promise<DoctorCheck> {
  const update = await getUpdateCheckImpl(packageVersion, { preferFresh: false });
  if (!update) {
    if (isFreshInstall(packageRoot, statSyncImpl)) {
      return createCheck(
        'update-status',
        'Update status',
        'pass',
        'Installed recently — memesh has not had a chance to check for updates yet. This resolves itself on the first successful check.',
      );
    }
    return createCheck(
      'update-status',
      'Update status',
      'warn',
      'memesh has not been able to check for newer versions yet, so it cannot tell you whether an update exists.',
      'Run `memesh status` once while connected to the internet — that stores the answer and this notice goes away.',
      { code: 'update-status.no-cache' },
    );
  }

  // Deprecation outranks ordinary update-available — a maintainer-
  // flagged version is the only doctor finding that should escalate
  // to `fail` here, because it carries security implications. We
  // route the deprecation message through the same advisory line the
  // session-start banner uses, so the user sees the same string in
  // both surfaces.
  //
  // Codex round 33: this check runs BEFORE the freshness=='unavailable'
  // guard. Round 31's fix made checkForUpdate persist a successful
  // deprecation result even when the latest-version lookup failed —
  // but in that scenario `lastSuccessfulCheckAt` stays null and
  // freshness comes back as 'unavailable'. Bailing on freshness first
  // would suppress the security signal exactly when it just arrived.
  if (update.currentVersionDeprecated && update.deprecationMessage) {
    const target = update.latestVersion && update.latestVersion !== packageVersion
      ? ` -> ${update.latestVersion}`
      : '';
    // Tailor the fix message to the install channel. `memesh
    // update` only works for npm-global self-updatable installs
    // when there's a newer version published; pointing source-
    // checkout / npm-local users at it (or pointing anyone at it
    // when latestVersion is missing or unchanged) sends them at
    // a remediation that won't help.
    const hasUpgradeTarget = update.latestVersion
      && update.latestVersion !== packageVersion;
    // Codex round 39: the previous "confirmedNoUpgradeTarget" branch
    // required `update.freshness === 'fresh'`, but doctor calls
    // `getUpdateCheck(..., { preferFresh: false })`, so the cached
    // data path here can never be 'fresh'. The branch was dead code.
    // Resolution: always recommend `memesh update` (or channel
    // equivalent). When there's truly no upgrade target,
    // `npm install -g @latest` is a harmless no-op; when one ships,
    // the command applies it immediately. The "no upgrade target"
    // message lives only in `memesh status` (which CAN do a fresh
    // lookup) and the dashboard (after a Check now click) — both
    // surfaces where freshness === 'fresh' is reachable.
    let fix: string;
    if (installSupport?.canSelfUpdate) {
      fix = hasUpgradeTarget
        ? `Run \`memesh update\`${target}.`
        : 'Run `memesh update` to refresh the registry lookup and apply any newly-published fix.';
    } else if (installSupport?.guidance) {
      fix = installSupport.guidance + (hasUpgradeTarget
        ? ` Upgrade target: ${update.latestVersion}.`
        : ' Upgrade target uncertain — re-check `memesh status` while online.');
    } else {
      fix = `Upgrade via your install method (see \`memesh status\`).`;
    }
    return createCheck(
      'update-status',
      'Update status',
      'fail',
      `Installed version ${packageVersion} is DEPRECATED by maintainers: ${update.deprecationMessage}`,
      fix,
      { code: 'update-status.deprecated', params: { version: packageVersion, detail: update.deprecationMessage ?? '' } },
    );
  }

  // Now that deprecation has been surfaced, the no-fresh-data path
  // is the right answer for users who haven't completed a successful
  // check yet (and have no security advisory waiting).
  if (update.freshness === 'unavailable') {
    if (isFreshInstall(packageRoot, statSyncImpl) && !update.lastAttemptAt && !update.lastError) {
      return createCheck(
        'update-status',
        'Update status',
        'pass',
        'Installed recently — memesh has not had a chance to check for updates yet. This resolves itself on the first successful check.',
      );
    }
    return createCheck(
      'update-status',
      'Update status',
      'warn',
      'memesh has not been able to check for newer versions yet, so it cannot tell you whether an update exists.',
      'Run `memesh status` once while connected to the internet — that stores the answer and this notice goes away.',
      { code: 'update-status.no-cache' },
    );
  }

  // Partial-failure surfaces with checkSucceeded=true + lastError
  // populated (deprecation sub-call timed out / blocked, version
  // lookup answered). Doctor must NOT report a clean pass in that
  // case — the security signal is genuinely unknown. But the
  // version lookup DID answer, so include the actionable update
  // info if there's a newer version, instead of suppressing
  // the user's clearest path forward.
  if (update.checkSucceeded && update.lastError) {
    const hasUpdate = Boolean(update.updateAvailable && update.latestVersion);
    const summary = hasUpdate
      ? `Deprecation status unknown for ${packageVersion}: ${withoutFinalPeriod(update.lastError)}. Update ${update.latestVersion} is available.`
      : `Deprecation status unknown for ${packageVersion}: ${withoutFinalPeriod(update.lastError)}.`;
    // Tailor the upgrade hint to the install channel — `memesh
    // update` only works for npm-global self-updatable installs.
    let upgradeHint: string;
    if (hasUpdate) {
      if (installSupport?.canSelfUpdate) {
        upgradeHint = `, or \`memesh update\` to apply ${update.latestVersion}`;
      } else if (installSupport?.guidance) {
        upgradeHint = `. Upgrade target ${update.latestVersion} via your install method: ${installSupport.guidance}`;
      } else {
        upgradeHint = `. Upgrade target: ${update.latestVersion}.`;
      }
    } else {
      upgradeHint = '';
    }
    const fix = `Run \`memesh status\` while online to retry the deprecation lookup${upgradeHint}.`;
    return createCheck('update-status', 'Update status', 'warn', summary, fix, {
      code: 'update-status.deprecation-unknown',
      params: { version: packageVersion, detail: update.lastError ?? '' },
    });
  }

  if (update.latestVersion && update.latestVersion !== packageVersion) {
    // F14: User sees confusing "4.1.4 -> 4.1.3" on release branches — the
    // local version (unreleased) is ahead of npm latest. Don't warn unless
    // the update is actually an upgrade.
    //
    // This was a STRING comparison, with a comment conceding that a semantic
    // one "would be more accurate" and asserting the string form "catches
    // 99% of cases". It stops working at the first two-digit component:
    // `'4.6.9' < '4.6.10'` is FALSE, because '9' sorts after '1'. So at
    // 4.6.10 doctor would announce "Running pre-release version (4.6.9), npm
    // latest is 4.6.10" — telling the user they are AHEAD of a release they
    // are behind — while the session banner, which uses a different
    // comparison, urged them to upgrade. `classifyBump` is that comparison,
    // and it already exists: it returns null exactly when `to` is not an
    // upgrade over `from`.
    if (classifyBump(packageVersion, update.latestVersion)) {
      return createCheck(
        'update-status',
        'Update status',
        'warn',
        `Update available: ${update.latestVersion} (current: ${packageVersion})`,
        `Run 'memesh update' to upgrade`,
        { code: 'update-status.update-available', params: { latest: update.latestVersion, current: packageVersion } },
      );
    } else {
      // Local version is ahead (pre-release or release branch) — don't warn
      return createCheck(
        'update-status',
        'Update status',
        'pass',
        `Running pre-release version (${packageVersion}), npm latest is ${update.latestVersion}`,
      );
    }
  }

  // F1 (2026-09-02 dogfood): this branch used to print an unqualified
  // "Version X is current." — a fact doctor cannot actually know, because
  // `getUpdateCheckImpl` is always called with `preferFresh: false` (no
  // network call from doctor — see the module docstring above) and the
  // cache backing it is only refreshed by something ELSE running `memesh
  // status`/`memesh update`. A real npm-global install sat on a cache that
  // was ~23h44m old (inside the 24h STALE_AFTER_MS window, so still
  // 'cached' not 'stale') and doctor printed `[PASS] Version 4.8.2 is
  // current` at the exact moment npm had already published 4.8.3 — true
  // when the cache was written, false when doctor read it, and nothing in
  // the sentence let a reader tell the difference. Naming the check's own
  // age makes the claim falsifiable instead of an assertion doctor cannot
  // back up.
  const checkedHoursAgo = update.lastSuccessfulCheckAt === null
    ? null
    : (Date.now() - Date.parse(update.lastSuccessfulCheckAt)) / 3600_000;
  const checkedAgo = formatHoursAgo(checkedHoursAgo);
  return createCheck(
    'update-status',
    'Update status',
    update.freshness === 'stale' ? 'warn' : 'pass',
    update.freshness === 'stale'
      ? `As of the last check (${checkedAgo}), ${packageVersion} was the latest version — that check is more than 24h old, so a newer release may exist since. Doctor never makes a live registry call itself.`
      : `As of the last check (${checkedAgo}), ${packageVersion} was the latest version.`,
    update.freshness === 'stale'
      ? 'Run `memesh status` while online to refresh cached update metadata.'
      : undefined,
    update.freshness === 'stale'
      ? { code: 'update-status.stale', params: { version: packageVersion } }
      : undefined,
  );
}

async function inspectHttpProbe(
  httpBaseUrl: string,
  fetchImpl: typeof fetch,
): Promise<DoctorCheck> {
  try {
    const response = await fetchImpl(`${httpBaseUrl.replace(/\/$/, '')}/v1/health`);
    if (!response.ok) {
      return createCheck(
        'http-probe',
        'HTTP probe',
        'warn',
        `HTTP server responded with ${response.status} at ${httpBaseUrl}.`,
        'Run `memesh serve` and check the logs, then retry `memesh doctor --probe-http`.',
        { code: 'http-probe.bad-status', params: { status: response.status, url: httpBaseUrl } },
      );
    }

    return createCheck(
      'http-probe',
      'HTTP probe',
      'pass',
      `HTTP server is reachable at ${httpBaseUrl}.`,
    );
  } catch {
    return createCheck(
      'http-probe',
      'HTTP probe',
      'warn',
      `No running HTTP server detected at ${httpBaseUrl}.`,
      'Start the local server with `memesh serve` if you want HTTP API verification.',
      { code: 'http-probe.no-server', params: { url: httpBaseUrl } },
    );
  }
}

/**
 * F4: verify the on-disk skill files + hooks match the SHA-256 manifest
 * generated at publish time. This catches tampering between npm publish
 * and the user's machine — e.g. a malicious overlay copied into
 * node_modules after install — which `npm --provenance` alone cannot
 * detect (provenance attests the tarball, not the unpacked files).
 *
 * Manifest is at dist/skills-manifest.json. If it's missing, we treat
 * that as a `warn` (developer install from source) rather than `fail`,
 * since source checkouts run `npm run build` on demand. A packaged
 * install from npm will always have it.
 */
function verifySkillsManifest(
  packageRoot: string,
  existsSyncImpl: typeof fs.existsSync,
  readFileSyncImpl: typeof fs.readFileSync,
  installSupport: import('./install-channel.js').InstallChannelSupport,
): DoctorCheck {
  // "Reinstall" is not one command. All four fix strings below said
  // `npm install -g @pcircle/memesh`, which is wrong for three of the four
  // channels memesh actually ships through: a plugin-marketplace install
  // reinstalls through Claude Code's `/plugin`, a source checkout rebuilds,
  // and a project-local install reinstalls in that project. Telling a plugin
  // user to run the npm command does not repair their install — it creates a
  // SECOND one beside it, on a different code path, sharing one database.
  // `getInstallChannelSupport` already knows the right sentence per channel
  // and the update-status row already uses it.
  const reinstall = installSupport.guidance;
  const manifestPath = path.join(packageRoot, 'dist', 'skills-manifest.json');
  if (!existsSyncImpl(manifestPath)) {
    // A source checkout builds on demand and may have no manifest yet. Every other install is a packaged one, and a
    // packaged install always ships it: its absence means a file was removed, which is exactly what this check is for.
    if (installSupport.channel === 'source-checkout') {
      return createCheck(
        'skills-manifest',
        'Skills + hooks integrity',
        'warn',
        'No skills-manifest.json found. This is normal for source checkouts — packaged installs ship the manifest.',
        `Run \`npm run build\` to regenerate.`,
        { code: 'skills-manifest.missing-dev' },
      );
    }
    return createCheck(
      'skills-manifest',
      'Skills + hooks integrity',
      'fail',
      'No skills-manifest.json found, and this is not a source checkout: a packaged install always ships it. A file was removed from this install, so the skill and hook files cannot be verified.',
      `Reinstall the package: ${reinstall} If the problem reproduces on a fresh install, open a security issue at https://github.com/PCIRCLE-AI/memesh/security.`,
      { code: 'skills-manifest.missing' },
    );
  }
  let manifest: { entries?: Array<{ path: string; sha256: string }> };
  try {
    manifest = JSON.parse(readFileSyncImpl(manifestPath, 'utf8'));
  } catch (err) {
    return createCheck(
      'skills-manifest',
      'Skills + hooks integrity',
      'fail',
      `skills-manifest.json is unreadable (${err instanceof Error ? err.message : 'parse error'}).`,
      `Reinstall the package: ${reinstall} If the problem persists open an issue.`,
      { code: 'skills-manifest.unreadable', params: { detail: err instanceof Error ? err.message : 'parse error' } },
    );
  }
  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  if (entries.length === 0) {
    return createCheck(
      'skills-manifest',
      'Skills + hooks integrity',
      'fail',
      'skills-manifest.json contains zero entries.',
      `Reinstall the package: ${reinstall}`,
      { code: 'skills-manifest.empty' },
    );
  }
  const mismatches: string[] = [];
  const missing: string[] = [];
  for (const entry of entries) {
    const full = path.join(packageRoot, entry.path);
    if (!existsSyncImpl(full)) { missing.push(entry.path); continue; }
    // Never read what is not a plain file: a named pipe in a published file's place blocks the read for ever, which
    // would hang the diagnostic that is meant to catch the swap. It is not what was published, so it is reported.
    try {
      const kind = fs.lstatSync(full);
      if (!kind.isFile() && !kind.isSymbolicLink()) { mismatches.push(`${entry.path} (not a regular file)`); continue; }
    } catch { /* the read below reports what is wrong */ }
    let actualHash: string;
    try {
      const buf = readFileSyncImpl(full);
      actualHash = createHash('sha256').update(buf).digest('hex');
    } catch (err) {
      mismatches.push(`${entry.path} (read error: ${err instanceof Error ? err.message : 'unknown'})`);
      continue;
    }
    if (actualHash !== entry.sha256) mismatches.push(entry.path);
  }
  // The other direction: the manifest lists what it lists, but what must be listed is decided by the code, from
  // what is on disk. A file in scope that the manifest does not mention (a new SKILL.md, an extra hook, or an entry
  // taken out of the manifest by whoever changed that file) is exactly what this check exists to catch.
  const listed = new Set(entries.map((entry) => entry.path));
  const scope = manifestScope(packageRoot);
  const unlisted = scope.files.filter((file) => !listed.has(file));
  // What the scan could not account for: a location the package must have and does not (a whole `skills/`
  // folder, a wiring file), a symbolic link in a covered place (npm pack ships none), a folder it could not read, a
  // folder named like what npm pack leaves out, an entry that is not a file.
  const unaccounted = [
    ...scope.missingRequired.map((p) => `${p} (required, not found)`),
    ...scope.symlinks.map((p) => `${p} (symbolic link)`),
    ...scope.unreadable.map((p) => `${p} (cannot be read)`),
    ...scope.strayFolders.map((p) => `${p} (a folder npm pack never ships)`),
    ...scope.special.map((p) => `${p} (not a file)`),
  ];
  if (missing.length === 0 && mismatches.length === 0 && unlisted.length === 0 && unaccounted.length === 0) {
    return createCheck(
      'skills-manifest',
      'Skills + hooks integrity',
      'pass',
      `${entries.length} skill / hook files match the published manifest (SHA-256 verified); ${scope.files.length} files are in the covered scope on disk, none unlisted.`,
    );
  }
  const detail = [
    unaccounted.length > 0 ? `${unaccounted.length} not accounted for: ${unaccounted.slice(0, 3).join(', ')}${unaccounted.length > 3 ? ` (+${unaccounted.length - 3} more)` : ''}` : null,
    unlisted.length > 0 ? `${unlisted.length} not in the manifest: ${unlisted.slice(0, 3).join(', ')}${unlisted.length > 3 ? ` (+${unlisted.length - 3} more)` : ''}` : null,
    missing.length > 0 ? `${missing.length} missing: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ` (+${missing.length - 3} more)` : ''}` : null,
    mismatches.length > 0 ? `${mismatches.length} tampered: ${mismatches.slice(0, 3).join(', ')}${mismatches.length > 3 ? ` (+${mismatches.length - 3} more)` : ''}` : null,
  ].filter(Boolean).join('; ');
  return createCheck(
    'skills-manifest',
    'Skills + hooks integrity',
    'fail',
    `Manifest verification failed: ${detail}.`,
    `Reinstall the package: ${reinstall} If the problem reproduces on a fresh install, open a security issue at https://github.com/PCIRCLE-AI/memesh/security.`,
    { code: 'skills-manifest.verify-failed', params: { detail } },
  );
}

function probeInstalledMessageCapability(packageRoot: string): { ok: true } | { ok: false; message: string } {
  const required = [
    'dist/transports/cli/doctor-message-probe.js',
    'dist/mcp/server.js',
    'dist/transports/mcp/handlers.js',
    'dist/host-adapters/codex-app-server.js',
    'dist/host-adapters/claude-channel.js',
    'dist/host-adapters/acp-client.js',
  ];
  const absent = required.filter((relative) => !fs.existsSync(path.join(packageRoot, relative)));
  if (absent.length > 0) return { ok: false, message: `installed runtime is missing ${absent.join(', ')}` };

  const probeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-doctor-message-'));
  try {
    execFileSync(process.execPath, [path.join(packageRoot, 'dist/transports/cli/doctor-message-probe.js'), packageRoot], {
      cwd: packageRoot,
      stdio: 'pipe',
      timeout: 15_000,
      env: { ...process.env, HOME: probeHome, MEMESH_AUTO_CAPTURE: 'false' },
    });
    return { ok: true };
  } catch {
    return { ok: false, message: 'installed MCP or bundled host adapters did not complete the message capability probe' };
  } finally {
    fs.rmSync(probeHome, { recursive: true, force: true });
  }
}

function inspectMessageCapability(
  packageRoot: string,
  enabled: boolean,
  probe: (packageRoot: string) => { ok: true } | { ok: false; message: string },
): DoctorCheck {
  if (!enabled) {
    return createInfo(
      'message-capability',
      'Message adapter imports',
      'Not verified (opt-in). Set MEMESH_DOCTOR_PROBE_MESSAGE_CAPABILITY=1 to start this installed MCP and verify its ten-action message schema plus bundled host-adapter imports. This does not check a live router socket or host registration.',
    );
  }
  const result = probe(packageRoot);
  if (result.ok) return createCheck(
    'message-capability',
    'Message adapter imports',
    'pass',
    'This installed MCP advertised the ten-action message schema and all bundled host adapters imported successfully. No live router socket, host registration, or host acceptance was verified.',
  );
  return createCheck(
    'message-capability',
    'Message adapter imports',
    'fail',
    `Installed message capability probe failed: ${withoutFinalPeriod(result.message)}.`,
    'Reinstall or rebuild this package, then retry with MEMESH_DOCTOR_PROBE_MESSAGE_CAPABILITY=1.',
    { code: 'message-capability.probe-failed', params: { detail: result.message } },
  );
}

function inspectInstallJourney(packageVersion: string): DoctorCheck {
  const record = readJourneyRecord();
  if (record === undefined) {
    return createInfo(
      'install-journey',
      'Install journey',
      'No install journey recorded yet. It runs after `memesh install-hooks` and `memesh setup`; run it now with `memesh doctor --journey`.',
    );
  }
  if ('unreadable' in record) {
    return createCheck('install-journey', 'Install journey', 'warn', `The saved journey result could not be read: ${record.unreadable}.`, `Delete ${journeyRecordPath()}, or re-run \`memesh install-hooks\` or \`memesh setup\`, which write a new one.`, { code: 'install-journey.unreadable', params: { detail: record.unreadable } });
  }
  const stale = record.version !== packageVersion ? ` This result is from v${record.version}; this is v${packageVersion}.` : '';
  if (record.ok) {
    // A pass for another version says nothing about this one: shown as information, not as a green check.
    if (record.version !== packageVersion) {
      return createInfo(
        'install-journey',
        'Install journey',
        `The last journey passed on v${record.version} (${record.at}); this is v${packageVersion}. Run \`memesh doctor --journey\` to check this version.`,
      );
    }
    return createCheck('install-journey', 'Install journey', 'pass', `Store, search, send and read back worked at ${record.at} (v${record.version}).`);
  }
  if (record.failedStep === 'prepare') {
    return createCheck(
      'install-journey',
      'Install journey',
      'warn',
      `The journey could not run at ${record.at}: ${record.reason}. memesh itself was not checked.${stale}`,
      record.fix ?? 'Run `memesh doctor --journey`.',
      { code: 'install-journey.not-run', params: { detail: record.reason ?? '' } },
    );
  }
  return createCheck(
    'install-journey',
    'Install journey',
    'warn',
    `The journey failed at "${record.failedStep}" at ${record.at}: ${record.reason}.${stale}`,
    record.fix ?? 'Run `memesh doctor --journey`.',
    { code: 'install-journey.failed', params: { step: record.failedStep ?? 'unknown', detail: record.reason ?? '' } },
  );
}

async function defaultMessageRouterStatusProbe(): Promise<MessageRouterStatusProbe> {
  const socketPath = process.env.MEMESH_ROUTER_SOCKET ?? getAgentRouterSocketPath();
  // A path over the limit is why `memesh-router` never created the socket —
  // reporting it as plain "missing" sent the owner to restart a router that
  // will fail again on the exact same path, a dead-end (#404). Checked before
  // `lstatSync` so this cause is never masked by an ENOENT for the same path.
  const socketPathBytes = Buffer.byteLength(socketPath);
  if (socketPathBytes > AGENT_ROUTER_SOCKET_PATH_MAX_BYTES) {
    return { socket_path: socketPath, socket: 'path-too-long', detail: `${socketPathBytes} bytes` };
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(socketPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { socket_path: socketPath, socket: 'missing', detail };
  }
  if (!stat.isSocket() || (stat.mode & 0o077) !== 0) {
    return { socket_path: socketPath, socket: 'insecure' };
  }

  const reachable = await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ path: socketPath });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 1_500);
    timer.unref();
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
  return { socket_path: socketPath, socket: reachable ? 'reachable' : 'unreachable' };
}

async function inspectMessageRouterStatus(
  enabled: boolean,
  probe: () => Promise<MessageRouterStatusProbe>,
  lastIdleExit?: string,
): Promise<DoctorCheck> {
  if (!enabled) {
    return createInfo(
      'message-router-status',
      'Live message router / host registration',
      'Not verified (opt-in). Set MEMESH_DOCTOR_PROBE_MESSAGE_ROUTER=1 to check only whether the owner-private Local router socket is live. This check never starts a router, registers a host, sends a message, or wakes a stopped session.',
    );
  }
  const result = await probe();
  switch (result.socket) {
    case 'reachable':
      return createCheck(
        'message-router-status',
        'Live message router / host registration',
        'pass',
        `Owner-private Local router socket is reachable at ${result.socket_path}. This proves only router availability; it does not prove an active host registration, native delivery, host_accept, ACK, or stopped-session wake-up.`,
      );
    case 'missing':
      return createCheck(
        'message-router-status',
        'Live message router / host registration',
        'warn',
        `No Local router socket exists at ${result.socket_path}. No active host is registered through this router, and MeMesh will not wake a stopped or missing session.${lastIdleExit ? ` The router last ended itself for idleness at ${lastIdleExit}.` : ' No idle exit of the router is recorded, so if a session was open a moment ago the router may have stopped for another reason.'}`,
        'The router ends itself after 10 minutes (MEMESH_ROUTER_IDLE_MS) with no host connected and nothing being delivered, so a missing socket is normal while no session is open; a host session or a message send starts it again. To check it now, start a session or the owner-configured router with `memesh-router`, then run this opt-in probe again.',
        { code: 'message-router.socket-missing', params: { path: result.socket_path } },
      );
    case 'path-too-long':
      return createCheck(
        'message-router-status',
        'Live message router / host registration',
        'fail',
        `The router socket path is ${result.detail} — over the ${AGENT_ROUTER_SOCKET_PATH_MAX_BYTES}-byte limit a Unix domain socket allows, so \`memesh-router\` cannot create it at ${result.socket_path}. Starting the router again fails the same way.`,
        process.env.MEMESH_ROUTER_SOCKET !== undefined
          ? 'Set MEMESH_ROUTER_SOCKET to a shorter absolute path in a folder only you can access (owner-private), then start `memesh-router` again. It reaches `memesh-router`, `memesh doctor`, senders and ordinary Claude MCP sessions. Host configs written by `memesh agent setup` (`hosts/codex-session.json` included) keep the default path, and ordinary Codex sessions use the default path, so shorten HOME / MEMESH_DIR instead if they must reach this router.'
          : 'Move HOME / MEMESH_DIR somewhere with a shorter path, then start `memesh-router` again. With MEMESH_DB_PATH set, the default socket sits in that database\'s folder, so move the database; the socket\'s folder must be owner-private. Setting MEMESH_ROUTER_SOCKET alone is not enough: it does not reach host configs written by `memesh agent setup` (`hosts/codex-session.json` included) or ordinary Codex sessions, which use the default path.',
        { code: 'message-router.socket-path-too-long', params: { path: result.socket_path, bytes: result.detail ?? 'unknown' } },
      );
    case 'insecure':
      return createCheck(
        'message-router-status',
        'Live message router / host registration',
        'fail',
        `Router socket at ${result.socket_path} is not an owner-private Unix socket.`,
        'Stop the router, remove the unsafe socket, and restart `memesh-router` under the owning user.',
        { code: 'message-router.socket-insecure', params: { path: result.socket_path } },
      );
    case 'unreachable':
      return createCheck(
        'message-router-status',
        'Live message router / host registration',
        'warn',
        `An owner-private router socket exists at ${result.socket_path}, but it did not accept a local connection. No host registration or native delivery is verified.`,
        'Check the owner-configured `memesh-router` process, then run this opt-in probe again.',
        { code: 'message-router.socket-unreachable', params: { path: result.socket_path } },
      );
  }
}

function summarizeOverallStatus(checks: DoctorCheck[]): DoctorOverallStatus {
  // Informational rows describe state and cannot fail — counting them would
  // pad the verdict with rows that verified nothing. See DoctorCheck.informational.
  const assertions = checks.filter((check) => !check.informational);
  if (assertions.some((check) => check.status === 'fail')) return 'FAIL';
  if (assertions.some((check) => check.status === 'warn')) return 'PASS_WITH_CONCERNS';
  return 'PASS';
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorResult> {
  const {
    packageRoot,
    packageVersion,
    probeHttp = false,
    httpBaseUrl = 'http://127.0.0.1:3737',
    platform = process.platform,
    envImpl = process.env,
    openDatabaseImpl = openDatabaseForDoctor,
    closeDatabaseImpl = closeDatabase,
    isDatabaseOpenImpl = isDatabaseOpen,
    getConfigPathImpl = getConfigPath,
    getUpdateCheckImpl = getUpdateCheck,
    getCurrentInstallChannelImpl = getCurrentInstallChannel,
    installedPluginsPathImpl,
    marketplaceHeadShaImpl = defaultMarketplaceHeadSha,
    pluginCacheDiscoveryImpl,
    getInstallChannelSupportImpl = getInstallChannelSupport,
    existsSyncImpl = fs.existsSync,
    readFileSyncImpl = fs.readFileSync,
    statSyncImpl = fs.statSync,
    fetchImpl = fetch,
    agentMessageStoragePolicy,
    nativeBindingProbeImpl,
    resolveShellMemeshImpl = defaultResolveShellMemesh,
    probeMessageCapability = process.env.MEMESH_DOCTOR_PROBE_MESSAGE_CAPABILITY === '1',
    messageCapabilityProbeImpl = probeInstalledMessageCapability,
    probeMessageRouterStatus = process.env.MEMESH_DOCTOR_PROBE_MESSAGE_ROUTER === '1',
    messageRouterStatusProbeImpl = defaultMessageRouterStatusProbe,
  } = options;

  // F16: If the database is already open before doctor runs (e.g., the
  // HTTP server opened it at startup and is still serving requests), we
  // must NOT close it — that would set the global db = null and break
  // every subsequent /v1/* request. Substitute a noop close so doctor's
  // "best-effort cleanup" is truly best-effort and never destructive.
  // CLI usage (where db starts null) is unaffected: noop only kicks in
  // when the db was already open when we arrived.
  const wasDbOpenBeforeUs = isDatabaseOpenImpl();
  const safeCloseDatabaseImpl: typeof closeDatabase = wasDbOpenBeforeUs
    ? () => undefined
    : closeDatabaseImpl;

  const checks: DoctorCheck[] = [];

  const install = getCurrentInstallChannelImpl({ packageRoot });
  const installSupport = getInstallChannelSupportImpl(install, packageRoot);
  checks.push(
    createCheck(
      'install-channel',
      'Install method',
      install === 'unknown' ? 'warn' : 'pass',
      `Install method detected: ${installSupport.label}.`,
      install === 'unknown'
        ? 'If this is a source checkout, run MeMesh from the repo root. If this is a packaged install, reinstall with `npm install -g @pcircle/memesh`.'
        : undefined,
      install === 'unknown' ? { code: 'install-channel.unknown' } : undefined,
    ),
  );

  const databasePath = resolveDatabasePath();
  // Staged, not pushed directly.
  //
  // The `pass` row used to go into `checks` the moment the entity count came
  // back, before the rest of this block ran. Anything that threw afterwards was
  // caught below and pushed a SECOND row with the same `database` id and status
  // `fail` — so a failing database reported both, and `checks.find(c => c.id
  // === 'database')` returned the passing one. The overall verdict was right
  // and the row a reader looks at was wrong, which is worse than either alone.
  // Staging here means the block emits exactly one `database` row, whichever
  // way it ends.
  const dbChecks: DoctorCheck[] = [];
  let lastRouterIdleExit: string | undefined;
  try {
    const db = openDatabaseImpl(databasePath) as unknown as DatabaseLike;
    // A file can open and count its entities while another table's pages are
    // damaged; briefing, recall and the message inbox then fail on those pages
    // and tell the user to run doctor. quick_check(1) stops at the first
    // problem; it still reads the whole file on a healthy database (about 0.2 s
    // for 470 MB measured) and names the damage on a broken one. Anything but
    // "ok" goes through the catch below as one `database` row, with the
    // advice that fits damage (not "start fresh").
    const integrity = quickIntegrityVerdict(db);
    if (integrity !== 'ok') {
      throw Object.assign(
        new Error(`Database at ${databasePath} opened, but SQLite's quick integrity check failed: ${integrity}`),
        {
          fix: damagedDatabaseFix(databasePath),
        },
      );
    }
    // The pages can be intact while a table lacks a column this version reads
    // (changed outside memesh, or by a newer version): briefing then says the
    // inbox cannot be read and sends the reader here, so run its query.
    try {
      unreadDeliveryCount(db as unknown as MemeshDatabase, '', 'memesh-doctor');
    } catch (err) {
      const reason = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 200);
      throw Object.assign(
        new Error(`Database at ${databasePath} opened, but its message inbox cannot be read: ${reason}`),
        {
          fix: 'This memesh cannot read the message tables, and briefing says the same. If a newer memesh version also uses this database, update this one to match it; otherwise the tables were changed outside memesh: restore a backup you trust, or report the error quoted above.',
        },
      );
    }
    // Only wording in the router row: when it cannot be read the row says no idle exit is recorded.
    try { lastRouterIdleExit = readRouterIdleExit(db as unknown as MemeshDatabase); } catch { lastRouterIdleExit = undefined; }
    const count =
      (db.prepare('SELECT COUNT(*) as c FROM entities').get() as { c?: number } | undefined)?.c ?? 0;
    // #520: a database the owner made read-only opens for reads, so say it
    // here, in the row a reader looks at, with the command that undoes it.
    const writeBack = ownerWriteCommand(databasePath);
    // Opened read-only because the FOLDER cannot be written (no -wal holds pages, so the file is readable as it is).
    const folder = readOnlyFolderState();
    dbChecks.push(
      folder
        ? createCheck(
          'database',
          'Database',
          'warn',
          `Database at ${databasePath} (${count} entities) is open for reads only: ${folder.reason}.`,
          runOrSay(folder.fix),
        )
        : writeBack
        ? createCheck(
          'database',
          'Database',
          'warn',
          `Database at ${databasePath} (${count} entities) is read-only: reads work, writes are refused.`,
          `If it should be writable, ${writeBack}`,
        )
        : createCheck(
          'database',
          'Database',
          'pass',
          `Database opened successfully at ${databasePath} (${count} entities).`,
        ),
    );

    const messageStorage = inspectAgentMessageStorage(
      db as unknown as MemeshDatabase,
      databasePath,
      configuredAgentMessageStoragePolicy(agentMessageStoragePolicy),
    );
    if (messageStorage) dbChecks.push(messageStorage);

    const messageExpiry = inspectAgentMessageExpiry(db as unknown as MemeshDatabase);
    if (messageExpiry) dbChecks.push(messageExpiry);

    const codexQueueDaemon = inspectCodexQueueDaemon(db as unknown as MemeshDatabase);
    if (codexQueueDaemon) dbChecks.push(codexQueueDaemon);

    const heldNotices = inspectHeldNotices(db as unknown as MemeshDatabase);
    if (heldNotices) dbChecks.push(heldNotices);
    const unreadableTranscripts = inspectUnreadableTranscripts(db as unknown as MemeshDatabase);
    if (unreadableTranscripts) dbChecks.push(unreadableTranscripts);

    const projectSplit = inspectProjectIdentitySplit(db as unknown as MemeshDatabase);
    if (projectSplit) dbChecks.push(projectSplit);

    // The stale-keyword-index state, which two comments claimed doctor detected
    // and nothing checked.
    //
    // The segmentation marker only moves FORWARD, which leaves one state it
    // cannot describe: a database migrated by a segmentation-aware build and
    // then written to by an older one. The old build does not know the marker
    // exists, so it indexes new memories with the old rules and leaves the
    // marker alone; re-upgrading short-circuits and those memories stay
    // unreachable by any partial-phrase query, permanently. Users reach it
    // legitimately — an npm-global and a plugin-marketplace install side by
    // side, or a downgrade to recover from a bad release.
    //
    // The message reports a COUNT, never an example term. `memesh feedback` and
    // the dashboard's feedback widget copy every doctor check summary verbatim
    // into a pre-filled PUBLIC GitHub issue body, and diagnostics are opt-OUT —
    // so an example term lifted from `fts_vocab` is a line of the user's own
    // memories staged for publication. A count is just as actionable: run the
    // rebuild, re-run doctor, expect 0.
    //
    // Detected by looking for what the old rules leave behind: an indexed term
    // longer than a bigram that STARTS with an unspaced-script character. The
    // range set is imported from `fts-index.ts` rather than repeated here — it
    // grew from CJK-only to ten ranges, and a hand-written copy would have gone
    // on reporting a healthy index over an unsegmented Thai one. The
    // segmenting build cannot produce one, so its presence means some rows were
    // written by a build that was not segmenting.
    //
    // Deliberately NOT wrapped in `try/catch`. `fts_vocab` is absent only on a
    // database built by a schema older than the view, which `sqlite_master`
    // answers exactly; anything else that makes this query throw is a real
    // fault and belongs in the database check below, loudly. A blanket catch
    // here would also have swallowed the doctor-test stub's own assertion,
    // leaving this check permanently unexercised with the suite green — the
    // failure mode this whole branch exists to remove.
    const hasVocab = db
      .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'fts_vocab'`)
      .get() as { present?: number } | undefined;
    if (hasVocab?.present) {
      const unsegmented = db
        .prepare(
          `SELECT COUNT(*) AS c FROM fts_vocab
            WHERE length(term) > 2
              AND term GLOB ?`
        )
        .get(UNSPACED_SCRIPT_GLOB_RUN3) as { c?: number } | undefined;
      if (unsegmented?.c) {
        dbChecks.push(
          createCheck(
            'fts_segmentation',
            'Keyword index segmentation',
            'warn',
            `The keyword index holds ${unsegmented.c} unsegmented term(s), so some memories are only ` +
              `findable by their exact full text. This happens when an older build wrote to a database ` +
              `that a newer one had already migrated — the version marker only moves forward, so the ` +
              `automatic rebuild cannot notice. Re-run doctor after the rebuild: this count should be 0.`,
            `Run 'memesh reindex --fts' to rebuild the keyword index.`,
            { code: 'fts.unsegmented', params: { count: unsegmented.c } },
            'fts-rebuild',
          ),
        );
      }
    }

    // Guard ROI: has any accepted guard ever fired?
    //
    // `recordGuardFires` increments `metadata.guard.fires` on every match,
    // and `applyProposal` initialises it to 0 with the comment "the field
    // exists so block can arrive per-guard once measured fire accuracy
    // justifies it". Nothing read it. There was no command, no route and no
    // panel that showed a guard at all, so the measurement the escalation
    // was supposed to wait on could not be looked at — the same write-with-
    // no-reader shape as the citation counters above.
    //
    // Informational, not a check: a guard that has never fired is not a
    // fault. It might be a guard for a mistake nobody has repeated.
    try {
      // "Active guard" is decided by `guardFromMetadata`, not by a third SQL
      // predicate of this row's own.
      //
      // `json_extract(metadata, '$.guard.enabled') = 1` is a WIDER set than
      // the hooks load: `loadActiveGuards` also requires the entity to be a
      // lesson/mistake type and `tool`, `pattern` and `message` to all be
      // strings. A row with `enabled: true` and a missing `pattern` would
      // have counted here and been loaded by nothing — so doctor could report
      // "3 active guards, 0 have ever fired" about a set the hooks draw one
      // guard from, and the fire count is precisely the number the block
      // escalation is supposed to wait on. One definition, shared.
      const guardRows = db
        .prepare(
          `SELECT id, name, metadata FROM entities
           WHERE status = 'active'
             AND type IN ('lesson_learned', 'lesson', 'mistake')
             AND metadata LIKE '%"guard"%'`,
        )
        .all() as Array<{ id: number; name: string; metadata: string }>;
      const fired = guardRows
        .filter((r) => guardFromMetadata(r.id, r.metadata) !== null)
        .map((r) => {
          // `guardFromMetadata` decides membership; the counter is not part
          // of its shape, so it is read separately from the row it vouched
          // for.
          let fires = 0;
          try {
            const parsedMeta = JSON.parse(r.metadata) as { guard?: { fires?: unknown } };
            if (typeof parsedMeta.guard?.fires === 'number') fires = parsedMeta.guard.fires;
          } catch { /* vouched-for rows parse; this is belt and braces */ }
          return { name: r.name, fires };
        })
        .sort((a, b) => b.fires - a.fires);
      if (fired.length > 0) {
        const everFired = fired.filter((g) => g.fires > 0);
        const top = everFired.slice(0, 3).map((g) => `${g.name} (${g.fires})`).join(', ');
        dbChecks.push(createInfo(
          'guard_activity',
          'Guard activity',
          `${fired.length} active guard(s); ${everFired.length} have ever fired`
          + (top ? `. Most: ${top}.` : '. None has matched yet.'),
        ));
      }
    } catch {
      // A database without the guard shape (older schema, no json1) simply
      // has no guards to report. Not a fault, and not worth a row.
    }

    // Injection ROI: is anything the hooks inject cited or retrieved by ID?
    //
    // This row exists because the numbers behind it were correct, readable,
    // and seen by nobody. `citation_sessions_total` / `citation_sessions_cited`
    // are written by the Stop hook and read by `analytics.ts`, with tests on
    // both — but the tests seed the values, so the only figures anyone had
    // ever looked at were fixtures. Measured on a real database on
    // 2026-08-24: total=4, cited=0. A metric that has to be gone looking for
    // is a metric that reports nothing.
    const citationTotalRow = db
      .prepare(`SELECT value FROM memesh_metadata WHERE key = 'citation_sessions_total'`)
      .get() as { value?: string } | undefined;
    const citedRow = db
      .prepare(`SELECT value FROM memesh_metadata WHERE key = 'citation_sessions_cited'`)
      .get() as { value?: string } | undefined;
    const citationTotal = Number.parseInt(String(citationTotalRow?.value ?? ''), 10);
    if (Number.isInteger(citationTotal) && citationTotal > 0) {
      // An absent `cited` key is NOT zero — it means the counter predates the
      // unconditional initialisation, so the rate is unknown rather than 0%.
      const citedKnown = citedRow?.value !== undefined;
      const cited = Number.parseInt(String(citedRow?.value ?? ''), 10);
      const rate = citedKnown && Number.isInteger(cited)
        ? Math.round((cited / citationTotal) * 100)
        : null;
      // Read the rule file inside its OWN try. It lives on the filesystem,
      // not in the database, and this block runs inside the database
      // try/catch — so an unreadable rule file (wrong permissions, or a
      // directory at that path) would be reported to the user as
      // `database.broken`, sending them to debug a database that is fine.
      // The scope comes from the install marker, exactly as both WRITERS
      // resolve it (`session-start.js` and `installHooks`). Hardcoding
      // 'user' here made doctor look in `~/.claude/rules/` on a
      // `--scope project` install, where the file is inside the project —
      // so it reported the contract missing on every project install, and
      // its suggested fix pointed at a path nothing would ever write.
      // No marker means a plugin install, which is user-level by
      // construction.
      const ruleScope: CitationRuleScope = readInstallMarker()?.scope === 'project' ? 'project' : 'user';
      let rule: { path: string; state: string };
      try {
        // Only readFileSync now — `citationRuleState` reads first and
        // classifies ENOENT rather than checking existence separately, so
        // there is no existsSync seam left to inject.
        rule = citationRuleState(ruleScope, homeDir(), process.cwd(), {
          readFileSync: readFileSyncImpl,
        } as never);
      } catch {
        rule = { path: citationRulePath(ruleScope, homeDir(), process.cwd()), state: 'unreadable' };
      }

      if (rate === null) {
        dbChecks.push(createInfo(
          'citation_compliance',
          'Memory use rate',
          `${citationTotal} session(s) received injected memories; how many cited or retrieved one is not recorded `
          + `(this database predates the counter that would say). The rate will be measurable from the next session on.`,
        ));
      } else if (rate === 0) {
        dbChecks.push(createCheck(
          'citation_compliance',
          'Memory use rate',
          'warn',
          `${citationTotal} session(s) received injected memories and NONE cited or retrieved one. Every injection is `
          + `costing tokens with no evidence any of it was used — and with no citations or ID retrievals, ranking cannot `
          + `learn which memories are worth injecting.`,
          rule.state === 'current'
            ? `The citation contract is installed at ${rule.path}. If this stays at 0% across several more sessions, the injected memories are not earning their tokens — consider narrowing what is injected.`
            : `The citation contract is ${rule.state} at ${rule.path}. Run 'memesh install-hooks' (or start a new session) to write it, then re-check after a few sessions.`,
          { code: 'citation.none', params: { total: citationTotal } },
        ));
      } else {
        dbChecks.push(createInfo(
          'citation_compliance',
          'Memory use rate',
          `${cited} of ${citationTotal} session(s) with injected memories cited or retrieved at least one (${rate}%).`,
        ));
      }
    }

    try {
      // The automatic archiver (lifecycle.ts, run at session start): what its
      // last run did. Auto-captured commits and session rollups nobody used for
      // two weeks are archived; this is the only place a person can see that it
      // happened, how many, and how to get one back.
      let archiveRun: ReturnType<typeof readLastAutoArchiveRun> = null;
      let archiveUnreadable: string | null = null;
      try {
        archiveRun = readLastAutoArchiveRun(db);
      } catch (err) {
        if (!(err instanceof AutoArchiveRecordUnreadable)) throw err;
        archiveUnreadable = err.message;
      }
      if (archiveUnreadable) {
        dbChecks.push(createCheck(
          'auto_archive',
          'Automatic archive',
          'warn',
          `Cannot tell when it last ran: ${archiveUnreadable}. The record is rewritten the next time the archiver runs (at session start, at most once a day).`,
        ));
      } else if (archiveRun) {
        const byType = Object.entries(archiveRun.byType ?? {}).map(([t, n]) => `${n} ${t}`).join(', ');
        dbChecks.push(createInfo(
          'auto_archive',
          'Automatic archive',
          `Last run ${archiveRun.at}: ${archiveRun.archived} auto-captured memor${archiveRun.archived === 1 ? 'y' : 'ies'} archived`
          + `${byType ? ` (${byType})` : ''}, unused for ${String(archiveRun.unusedDays ?? 14)} days`
          + `${Number(archiveRun.keptCited) > 0 ? `; ${archiveRun.keptCited} old one(s) kept because a session cited them` : ''}. `
          + `Memories an agent wrote are never archived this way. Read an archived one with 'memesh recall --include-archived'; `
          + 'remember the same name again to bring it back.',
        ));
      } else {
        dbChecks.push(createInfo(
          'auto_archive',
          'Automatic archive',
          'Has not run yet. It runs at session start, at most once a day, and archives auto-captured commits and session '
          + 'rollups that nobody used for 14 days.',
        ));
      }
    } catch {
      // A database without the metadata table (older schema): no archiver row to show.
    }

  } catch (err) {
    // Replaces, not appends: whatever was staged before the throw describes a
    // database this function has just concluded it cannot use.
    dbChecks.length = 0;
    if (err instanceof NoDatabaseYetError) {
      // The ordinary state of an install nobody has used yet. Say so, and say what was not looked at and why. If the
      // folder that would hold it exists and cannot be written, MeMesh could not create the database there: say that.
      const folderPath = path.dirname(databasePath);
      const folderLocked = !isWritable(folderPath) && fs.existsSync(folderPath);
      const notChecked = 'Not checked until then: message storage, the keyword index, guard activity, memory use rate, hook activity, capture liveness.';
      dbChecks.push(folderLocked
        ? createCheck(
          'database',
          'Database',
          'warn',
          `No database yet at ${databasePath}, and ${folderPath} cannot be written, so MeMesh cannot create one: memories cannot be saved. ${notChecked}`,
          `chmod u+w ${shellQuote(folderPath)}`,
          { code: 'database.folder-read-only' },
        )
        : createInfo(
          'database',
          'Database',
          `No database yet at ${databasePath}: MeMesh creates it the first time it stores a memory, and doctor never creates it. ${notChecked}`,
        ));
    } else if (isSchemaBehind(err)) {
      dbChecks.push(createCheck('database', 'Database', 'warn',
        `Database at ${databasePath} opened, but its layout is older than this version, so the checks that need the newer layout were skipped.`,
        schemaBehindNote(databasePath),
        { code: 'database.schema-behind' }));
    } else {
      // F15: Provide actionable diagnosis for common database failures
      const { diagnosis, fix } = diagnoseDatabaseFailure(err, databasePath, existsSyncImpl, statSyncImpl);
      dbChecks.push(
        createCheck(
          'database',
          'Database',
          'fail',
          diagnosis,
          fix,
          // fix stays untranslated (it is itself diagnosis-specific text);
          // the dashboard translates the summary frame and shows fix raw.
          { code: 'database.broken', params: { detail: diagnosis } },
        ),
      );
    }
  } finally {
    checks.push(...dbChecks);
    try {
      safeCloseDatabaseImpl();
    } catch {
      // Best-effort cleanup only.
    }
  }

  checks.push(inspectConfigFile(existsSyncImpl, readFileSyncImpl, getConfigPathImpl));
  checks.push(inspectMcpConfig(packageRoot, install, existsSyncImpl, readFileSyncImpl, envImpl));
  checks.push(...inspectHooksConfig(packageRoot, platform, existsSyncImpl, readFileSyncImpl, statSyncImpl));
  // Runtime wiring + activity (#25 — file existence isn't enough;
  // doctor used to PASS for users whose Claude Code never loaded
  // memesh's hooks at all).
  // installedPluginsPathImpl may be undefined — detectPluginRuntime owns the
  // default path; restating it here was a second copy of the same location.
  const pluginHost = detectPluginHost(packageRoot);
  let codexPluginCacheDetected = pluginHost === 'codex';
  let claudePluginCacheDetected = pluginHost === 'claude-code';
  const wiring = inspectHookWiring(existsSyncImpl, readFileSyncImpl, memeshDir(), install, installedPluginsPathImpl, pluginHost);
  const pluginCache = inspectPluginCacheCurrency(install, pluginHost, packageRoot, installedPluginsPathImpl, readFileSyncImpl, existsSyncImpl, marketplaceHeadShaImpl);
  if (pluginCache) checks.push(pluginCache);
  if (install === 'npm-global') {
    const discoveredCounts = new Map<PluginHost, number>();
    const discoveredPluginCaches = pluginCacheDiscoveryImpl
      ? pluginCacheDiscoveryImpl()
      : defaultPluginCacheDiscovery(readFileSyncImpl, existsSyncImpl);
    for (const discovered of discoveredPluginCaches) {
      if (discovered.host === 'codex') codexPluginCacheDetected = true;
      if (discovered.host === 'claude-code') claudePluginCacheDetected = true;
      const check = discovered.unverifiableReason
        ? pluginCacheUnverifiable(discovered.host, discovered.unverifiableReason)
        : inspectPluginCacheCurrency(
          'plugin-marketplace', discovered.host, discovered.packageRoot,
          discovered.installedPluginsPath, readFileSyncImpl, existsSyncImpl, marketplaceHeadShaImpl,
        );
      if (check) {
        const hostName = discovered.host;
        const index = (discoveredCounts.get(discovered.host) ?? 0) + 1;
        discoveredCounts.set(discovered.host, index);
        checks.push({ ...check, id: `plugin-cache-${hostName}${index === 1 ? '' : `-${index}`}` });
      }
    }
  }
  checks.push(wiring);
  if (claudePluginCacheDetected) {
    checks.push(inspectClaudeChannelRegistration(existsSyncImpl, readFileSyncImpl));
  }
  const codexSessionSetup = inspectCodexSessionSetup(codexPluginCacheDetected, existsSyncImpl);
  if (codexSessionSetup) checks.push(codexSessionSetup);
  // hook-activity's never-ran verdict only reds when wiring is actually in
  // place — otherwise the wiring row above already tells the story, and an
  // MCP-only install would carry a permanent unfixable FAIL.
  // never-ran's FAIL claims "capture hooks should be executing" — that needs
  // a capture event (Stop/PostToolUse/PreCompact) confirmed wired, not just
  // any wiring. A plugin-marketplace pass carries no walk result and wires
  // every event through hooks.json, so it counts as capture-wired; a
  // settings-walk pass counts only when the walk saw a capture event.
  const captureWired = wiring.status === 'pass'
    && (wiring.params === undefined || wiring.params.captureWired === 1);
  checks.push(inspectHookActivity(openDatabaseImpl, safeCloseDatabaseImpl, existsSyncImpl, statSyncImpl, captureWired));
  // Next to hook-activity on purpose: "did it run" and "did it write" are
  // read together, and separating them is what let a green heartbeat cover
  // an empty graph for two days (#327).
  const captureLiveness = withRecordedHosts(inspectCaptureLiveness(openDatabaseImpl, safeCloseDatabaseImpl, readFileSyncImpl, getMemeshDirFromDbPath, captureWired));
  checks.push(captureLiveness.check);
  const heldNotes = inspectPrivateNoteHolds();
  if (heldNotes) checks.push(heldNotes);
  // The figures behind the capture-liveness row, surfaced on the result so
  // `--json` carries the evidence and not only the verdict.
  const captureReport = captureLiveness.report;
  // Before the native-binding row, because when that one is red this one is
  // the context that explains it.
  checks.push(inspectNodeRuntime(packageRoot, existsSyncImpl, readFileSyncImpl));
  checks.push(inspectNativeBinding(packageRoot, existsSyncImpl, nativeBindingProbeImpl));
  checks.push(inspectShellCli(install, packageRoot, packageVersion, resolveShellMemeshImpl, existsSyncImpl, readFileSyncImpl));
  checks.push(verifySkillsManifest(packageRoot, existsSyncImpl, readFileSyncImpl, installSupport));
  checks.push(inspectMessageCapability(packageRoot, probeMessageCapability, messageCapabilityProbeImpl));
  checks.push(await inspectMessageRouterStatus(probeMessageRouterStatus, messageRouterStatusProbeImpl, lastRouterIdleExit));
  checks.push(inspectInstallJourney(packageVersion));

  checks.push(await inspectUpdateStatus(packageVersion, getUpdateCheckImpl, installSupport, packageRoot, statSyncImpl));
  checks.push(inspectAutoUpdate(installSupport));

  // Anonymous install ID — surfaced so the user can SEE what's
  // included in feedback issues (transparency). Never sent
  // automatically; only attached to feedback bodies the user
  // explicitly opts into sharing via "Include system info".
  try {
    // Read only: doctor never creates the file. `memesh feedback` is what creates it, the first time it builds a report
    // with diagnostics.
    const record = readInstallRecordState();
    // `createInfo`, not `createCheck(..., 'pass', ...)`. This row reports a
    // value and has no branch that could fail, which is the exact case the
    // `informational` flag was added for: it was rendering as `[PASS]` and
    // counting toward Overall, padding "N/N PASS" with a row that verified
    // nothing.
    const installFile = path.join(memeshDir(), 'install.json');
    const sharing = 'Never transmitted automatically; `memesh feedback` includes it in the report text it prints or opens for you to submit, unless you pass `--no-diagnostics`.';
    checks.push(
      createInfo(
        'install_id',
        'Install ID',
        record.status === 'ok'
          ? `Anonymous install ID: ${record.install_id}${record.created_at ? ` (created ${record.created_at})` : ''}. Stored locally at ${installFile}. ${sharing}`
          : record.status === 'unreadable'
            ? `${installFile} exists but cannot be used (${record.reason}). Doctor does not touch it; the next \`memesh feedback\` with diagnostics replaces it with a new ID. ${sharing}`
            : `No install ID yet: it is created the first time \`memesh feedback\` builds a report with diagnostics (it would be stored locally at ${installFile}). Doctor does not create it. ${sharing}`,
      ),
    );
  } catch {
    // Non-critical — doctor must never fail because of an info check.
  }

  checks.push(inspectLocaleReadmeParity(packageRoot, existsSyncImpl, readFileSyncImpl));

  if (probeHttp) {
    checks.push(await inspectHttpProbe(httpBaseUrl, fetchImpl));
  }

  // Every row that would prescribe `memesh install-hooks` is judged by the same
  // host state, in this one pass: a row added later (or one built before the
  // wiring row existed, like the citation rate) cannot keep a second copy.
  const hostState = hostFixState(wiring.code, codexPresent(existsSyncImpl, isOnPath));
  const finalChecks = checks.map((check) => withHostFix(check, hostState));

  return {
    status: summarizeOverallStatus(finalChecks),
    checks: finalChecks,
    ...(captureReport ? { capture: captureReport } : {}),
  };
}

function iconForStatus(status: DoctorCheckStatus): string {
  switch (status) {
    case 'pass':
      return 'PASS';
    case 'warn':
      return 'WARN';
    default:
      return 'FAIL';
  }
}

export function formatDoctorReport(result: DoctorResult, packageVersion: string): string[] {
  const lines = [`MeMesh doctor v${packageVersion}`, `Overall: ${result.status}`];

  for (const check of result.checks) {
    lines.push('');
    // Informational rows must NOT read as [PASS] — that is the whole bug
    // this flag exists to prevent (a row that verified nothing looking
    // identical to one that did).
    lines.push(`[${check.informational ? 'INFO' : iconForStatus(check.status)}] ${check.label}`);
    lines.push(`  ${check.summary}`);
    if (check.fix) {
      lines.push(`  Fix: ${check.fix}`);
    }
  }

  return lines;
}
