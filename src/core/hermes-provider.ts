/**
 * The Hermes Agent memory provider that ships in `extensions/hermes-memesh/`,
 * and how a copy of it is installed, recognised and refreshed.
 *
 * Hermes runs a provider from a directory it discovers itself
 * (`$HERMES_HOME/plugins/<name>/`, or `plugins/memory/<name>/` inside a Hermes
 * checkout). Nothing in Hermes updates that directory when MeMesh updates, so
 * a fix that lives in the provider never reached anyone who had copied it by
 * hand. This module is the one place that writes such a copy:
 *
 *   - `memesh hermes install` puts the provider in place and records, in a
 *     marker file inside the copy, which version and which file contents it
 *     wrote. The marker is how a copy is known to be MeMesh's own.
 *   - The automatic updater refreshes every copy that carries a marker, from
 *     the package version it just verified. A copy without a marker was not
 *     installed by MeMesh and is left alone; a marked copy whose files no
 *     longer match the marker was edited by its owner and is left alone too.
 *   - A directory that is NOT MeMesh's own unmodified copy (one the owner
 *     edited, one MeMesh did not install, an unreadable marker) is only ever
 *     replaced with `--force`, and is saved first under
 *     `<memesh dir>/backups/hermes-provider-<time>-<id>`. Those backups are
 *     the owner's files: they are never rotated away, whatever happens later.
 *     Refreshing MeMesh's own unmodified copy needs no backup (every byte of it
 *     is in the package it came from) and makes none.
 *   - A refresh that is killed half way (power loss, OOM) leaves the old copy in a hidden directory beside the copy,
 *     `.memesh-old-<name>-<pid>-<tag>/copy` (the new one in `.memesh-new-<name>-<pid>-<tag>/copy`); the next run puts it back
 *     before doing anything else. Only names of exactly that shape, for exactly this copy's name, are looked at.
 *   - Two refreshes of one copy never run at once: a lock directory `.memesh-lock-<name>` beside it, owned by a process (pid and
 *     start time), keeps the second out until the first is done (or gone).
 */
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { processStartTag } from './process-identity.js';

export const MARKER_FILE = '.memesh-install.json';
export const REGISTRY_FILE = 'hermes-installs.json';

export const HERMES_REASONS = {
  installed: 'installed',
  refreshed: 'refreshed to the verified version',
  unchanged: 'already the verified version',
  notOurs: 'left alone: this directory was not installed by MeMesh (it has no install marker)',
  modified: 'left alone: files in this copy were changed after MeMesh installed it',
  markerUnreadable: 'left alone: the install marker could not be read',
  unsafeSource: 'not installed: the provider source holds something other than plain files',
  failed: 'failed',
  linked: 'left alone: it is a symbolic link, somebody pointed it somewhere on purpose, and MeMesh writes neither through it nor over it',
  unreadable: 'left alone: something in this directory cannot be read, so it cannot be told whether it is MeMesh\'s copy or whether it was edited',
  gone: 'a copy MeMesh installed here is no longer there; run `memesh hermes install` (add --path for a copy outside the default place) to put it back',
  restored: 'the copy had been lost to an update that was interrupted; it was put back first',
  busy: 'left alone: another refresh of this copy is running (the next run tries again)',
  linkedHint: 'MeMesh never changes a symbolic link, with or without --force: point --path at a real directory, or remove the link yourself',
} as const;

export interface InstallMarker {
  source: 'memesh';
  version: string;
  installedAt: string;
  files: Record<string, string>;
}

export type InstallState =
  | { state: 'absent' }
  | { state: 'foreign' }
  | { state: 'marker-unreadable' }
  | { state: 'linked'; to: string }
  | { state: 'unreadable'; why: string }
  | { state: 'managed'; marker: InstallMarker; modified: boolean };

export interface InstallResult {
  path: string;
  outcome: 'installed' | 'refreshed' | 'unchanged' | 'skipped' | 'failed';
  reason: string;
  backup: string | null;
}

/** Where Hermes keeps its state: `HERMES_HOME`, else `~/.hermes` of the account. */
export function hermesHome(env: NodeJS.ProcessEnv, accountHome?: string | null): string {
  if (env.HERMES_HOME) return path.resolve(env.HERMES_HOME); // a relative HERMES_HOME means a directory of the current one, made absolute here
  // No passwd entry for this uid is not a reason to fail: fall back to HOME. With neither there is no home to put it in:
  // there is no guessing at a shared directory such as /tmp, where anyone could plant a provider.
  const home = accountHome ?? env.HOME;
  if (!home) throw new Error('the Hermes home cannot be worked out: HERMES_HOME is not set and neither is a home directory (pass --path)');
  return path.join(home, '.hermes');
}

/** The default target, or null when there is no home to put it in (the registered copies are still looked after). */
export function defaultInstallTargetOrNull(env: NodeJS.ProcessEnv, accountHome?: string | null): string | null {
  try { return defaultInstallTarget(env, accountHome); } catch { return null; }
}

/** The directory `memesh hermes install` uses when no path is given. */
export function defaultInstallTarget(env: NodeJS.ProcessEnv, accountHome?: string | null): string {
  return path.join(hermesHome(env, accountHome), 'plugins', 'memesh');
}

const SKIPPED = new Set(['__pycache__', '.DS_Store']);

/** Relative paths (posix) of every file in a provider directory; throws on anything that is not a plain file or directory. */
function listFiles(root: string, dir: string = root, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name) || entry.name.endsWith('.pyc')) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (rel === MARKER_FILE) continue;
    if (entry.isDirectory()) listFiles(root, full, out);
    else if (entry.isFile()) out.push(rel);
    else throw new Error(`not a plain file: ${rel}`);
  }
  return out.sort();
}

function hashFiles(root: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const rel of listFiles(root)) hashes[rel] = createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex');
  return hashes;
}

function sameHashes(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a);
  return ak.length === Object.keys(b).length && ak.every((k) => a[k] === b[k]);
}

export function inspectInstall(target: string): InstallState {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'absent' } : { state: 'unreadable', why: errorText(err) };
  }
  // A link is somebody's arrangement (a plugin directory pointed at a checkout, say). MeMesh does not write through
  // it and does not replace it: it says so and leaves it as it is.
  if (stat.isSymbolicLink()) {
    let to = '?';
    try { to = fs.readlinkSync(target); } catch { /* shown as ? */ }
    return { state: 'linked', to };
  }
  if (!stat.isDirectory()) return { state: 'foreign' };
  const markerPath = path.join(target, MARKER_FILE);
  let markerText: string;
  try {
    markerText = fs.readFileSync(markerPath, 'utf8');
  } catch (err) {
    // No marker file is "not ours"; a marker that cannot be read says nothing about who owns the copy.
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'foreign' } : { state: 'unreadable', why: errorText(err) };
  }
  let marker: InstallMarker;
  try {
    const parsed = JSON.parse(markerText) as Partial<InstallMarker>;
    if (parsed.source !== 'memesh' || typeof parsed.version !== 'string' || !parsed.files || typeof parsed.files !== 'object') {
      return { state: 'marker-unreadable' };
    }
    marker = parsed as InstallMarker;
  } catch {
    return { state: 'marker-unreadable' };
  }
  let modified: boolean;
  try {
    modified = !sameHashes(marker.files, hashFiles(target));
  } catch (err) {
    // A file that cannot be read is not an edit: say what failed instead of calling the copy modified.
    return { state: 'unreadable', why: errorText(err) };
  }
  return { state: 'managed', marker, modified };
}

function errorText(err: unknown): string {
  const e = err as NodeJS.ErrnoException;
  return `${e?.code ?? 'error'}${e?.message ? `: ${e.message.replace(/\s+/g, ' ').slice(0, 140)}` : ''}`;
}

/** True when anything is at `p`, a dangling symbolic link included (`existsSync` follows the link and says no). */
function exists(p: string): boolean {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

function copyDir(from: string, to: string): void {
  fs.cpSync(from, to, { recursive: true, filter: (src) => !SKIPPED.has(path.basename(src)) && !src.endsWith('.pyc') });
}

/**
 * Save what is about to be replaced, under a name that tells the targets apart (two copies refreshed in the
 * same second must not share one directory). Never deleted by MeMesh. A backup that fails half way is removed:
 * a partial directory must not sit there looking like a backup.
 */
function backUp(target: string, backupRoot: string, now: Date): string {
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const id = createHash('sha256').update(path.resolve(target)).digest('hex').slice(0, 8);
  const stem = path.join(backupRoot, `hermes-provider-${now.toISOString().replace(/[:.]/g, '-')}-${id}`);
  // A copy a killed run left half made (named .partial-<pid>) is not a backup: it is swept once its writer is gone.
  try {
    for (const name of fs.readdirSync(backupRoot)) {
      const m = /^hermes-provider-.*\.partial-(\d+)$/.exec(name);
      if (m && !ownerAlive(Number(m[1]), 'x')) fs.rmSync(path.join(backupRoot, name), { recursive: true, force: true });
    }
  } catch { /* the sweep is a courtesy */ }
  let dest = stem;
  for (let n = 2; exists(dest); n += 1) dest = `${stem}-${n}`;
  const partial = `${dest}.partial-${process.pid}`;
  try {
    fs.cpSync(target, partial, { recursive: true });
    fs.renameSync(partial, dest);
  } catch (err) {
    try { fs.rmSync(partial, { recursive: true, force: true }); } catch { /* nothing more can be done */ }
    throw err;
  }
  return dest;
}

// ─── half-finished updates ─────────────────────────────────────────────────

// The staging and the aside directories sit in the plugins directory, where Hermes looks for plugins. The copy
// inside them is one level down (`<root>/copy`), so the directory Hermes would see has no plugin.yaml of its own
// and is not mistaken for a second MeMesh provider.
const NEW_PREFIX = '.memesh-new-';
const OLD_PREFIX = '.memesh-old-';
const COPY = 'copy';

const hashTag = (start: string) => createHash('sha256').update(start).digest('hex').slice(0, 10);

/** Names a refresh gives its temporary directories: the process that owns one is told by pid AND start time. */
function ownerTag(pid: number): string {
  const start = processStartTag(pid);
  return start === null ? 'x' : hashTag(start);
}

function ownerAlive(pid: number, tag: string): boolean {
  try { process.kill(pid, 0); } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false; }
  if (tag === 'x') return true;
  const now = processStartTag(pid);
  // A live pid that started at another time is a different program: the owner is gone.
  return now === null ? true : hashTag(now) === tag;
}

function stagingPaths(target: string, owner: string): { newRoot: string; fresh: string; oldRoot: string; old: string } {
  const dir = path.dirname(target);
  const base = path.basename(target);
  const newRoot = path.join(dir, `${NEW_PREFIX}${base}-${owner}`);
  const oldRoot = path.join(dir, `${OLD_PREFIX}${base}-${owner}`);
  return { newRoot, fresh: path.join(newRoot, COPY), oldRoot, old: path.join(oldRoot, COPY) };
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Temporary directories next to `target` that an earlier refresh of THIS copy left, with the kind and owner they name.
 * The whole name is matched (`<prefix><name>-<pid>-<tag>`): a sibling whose name merely starts with this one (memesh-dev
 * beside memesh) has leftovers of its own, which are not this copy's to restore or to delete. A name that looks like a
 * leftover of this copy but not of this shape is left alone and said.
 */
function leftovers(target: string, log?: (line: string) => void): Array<{ root: string; kind: 'new' | 'old'; pid: number; tag: string }> {
  const dir = path.dirname(target);
  const base = path.basename(target);
  let names: string[];
  try { names = fs.readdirSync(dir); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log?.(`hermes: could not list ${dir} for the leftovers of an interrupted refresh (${errorText(err)})`);
    return [];
  }
  const found: Array<{ root: string; kind: 'new' | 'old'; pid: number; tag: string }> = [];
  for (const name of names) {
    for (const [prefix, kind] of [[NEW_PREFIX, 'new'], [OLD_PREFIX, 'old']] as const) {
      if (!name.startsWith(prefix)) continue;
      const m = new RegExp(`^${escapeRegExp(prefix)}${escapeRegExp(base)}-(\\d+)-([0-9a-f]{10}|x)$`).exec(name);
      if (m) found.push({ root: path.join(dir, name), kind, pid: Number(m[1]), tag: m[2] });
    }
  }
  return found;
}

/**
 * Deal with what an interrupted refresh left. The old copy is moved aside before the new one is moved in,
 * so a kill between the two renames leaves the target missing and the old copy aside: it is put back.
 * Leftovers of a process that is gone are removed; those of a live one are not touched.
 * Returns true when the target was restored.
 */
function recoverInterrupted(target: string, log?: (line: string) => void): boolean {
  const left = leftovers(target, log).filter((l) => !ownerAlive(l.pid, l.tag));
  let restored = false;
  if (!exists(target)) {
    const olds = left
      .filter((l) => l.kind === 'old' && exists(path.join(l.root, COPY)))
      .sort((a, b) => { try { return fs.statSync(b.root).mtimeMs - fs.statSync(a.root).mtimeMs; } catch { return 0; } });
    if (olds.length > 0) {
      fs.renameSync(path.join(olds[0].root, COPY), target);
      restored = true;
    }
  }
  for (const l of left) {
    if (exists(l.root)) fs.rmSync(l.root, { recursive: true, force: true });
  }
  return restored;
}

/** True when an interrupted refresh left an old copy behind and the target itself is missing. */
function hasRestorableLeftover(target: string): boolean {
  if (exists(target)) return false;
  return leftovers(target).some((l) => l.kind === 'old' && !ownerAlive(l.pid, l.tag) && exists(path.join(l.root, COPY)));
}

/**
 * Run `fn` while holding the lock of this copy: a directory `.memesh-lock-<name>` beside it, made atomically, with its owner
 * (pid and start time) written inside. A lock whose owner is gone is taken over; one whose owner runs keeps the second
 * refresh out (it is told so, and tries again at its next run). `memesh hermes install` takes no other lock than this one,
 * and the automatic update's own lock does not cover it, so two refreshes of one copy could otherwise move it under each other.
 */
function withCopyLock<T>(target: string, busy: () => T, fn: () => T): T {
  const lockDir = path.join(path.dirname(target), `.memesh-lock-${path.basename(target)}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const take = (): boolean => {
    try { fs.mkdirSync(lockDir); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, tag: ownerTag(process.pid) }));
    return true;
  };
  let held = take();
  if (!held) {
    let owner: { pid?: unknown; tag?: unknown } | null = null;
    try { owner = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8')); } catch { /* no owner record: a lock being made, or damaged */ }
    const running = owner !== null && typeof owner.pid === 'number' && ownerAlive(owner.pid, typeof owner.tag === 'string' ? owner.tag : 'x');
    // No owner record is judged by age: a lock somebody is making right now is a second old at most.
    let youngNoOwner = false;
    if (owner === null) { try { youngNoOwner = Date.now() - fs.statSync(lockDir).mtimeMs < 60_000; } catch { /* gone */ } }
    if (running || youngNoOwner) return busy();
    fs.rmSync(lockDir, { recursive: true, force: true });
    held = take();
    if (!held) return busy();
  }
  try { return fn(); } finally { try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* the next run takes it over: its owner is gone */ } }
}

interface WriteInput {
  sourceDir: string;
  target: string;
  version: string;
  backupRoot: string;
  now: Date;
  /** Where a note about something that was skipped or could not be done goes (the update log). */
  log?: (line: string) => void;
}

/**
 * Replace (or create) `target` with the provider from `sourceDir`. `keep` is true when what is there is not MeMesh's
 * own unmodified copy: it is saved first. Returns the backup, and `residue`: the aside directory when the new copy
 * is in place but the old one could not be removed (the refresh itself succeeded).
 */
function writeCopy(input: WriteInput, replacing: boolean, keep: boolean): { backup: string | null; residue: string | null } {
  const { sourceDir, target, version, backupRoot, now } = input;
  const files = hashFiles(sourceDir); // throws on symlinks and other non-plain files
  const owner = `${process.pid}-${ownerTag(process.pid)}`;
  const { newRoot, fresh, oldRoot, old } = stagingPaths(target, owner);
  fs.rmSync(newRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(newRoot, { recursive: true });
  let backup: string | null = null;
  let residue: string | null = null;
  try {
    copyDir(sourceDir, fresh);
    const marker: InstallMarker = { source: 'memesh', version, installedAt: now.toISOString(), files };
    fs.writeFileSync(path.join(fresh, MARKER_FILE), JSON.stringify(marker, null, 2) + '\n');
    if (replacing) {
      if (keep) backup = backUp(target, backupRoot, now);
      fs.rmSync(oldRoot, { recursive: true, force: true });
      fs.mkdirSync(oldRoot, { recursive: true });
      fs.renameSync(target, old);
      try {
        fs.renameSync(fresh, target);
      } catch (err) {
        fs.renameSync(old, target); // put the user's copy back
        fs.rmSync(oldRoot, { recursive: true, force: true });
        throw err;
      }
      try { fs.rmSync(oldRoot, { recursive: true, force: true }); } catch { residue = oldRoot; }
    } else {
      fs.renameSync(fresh, target);
    }
  } finally {
    try { fs.rmSync(newRoot, { recursive: true, force: true }); } catch { /* it is a leftover the next refresh cleans up */ }
  }
  return { backup, residue };
}

export interface InstallProviderInput extends WriteInput {
  /** Replace a directory MeMesh did not install, or one its owner edited (after backing it up). */
  force: boolean;
}

/** `memesh hermes install`: one explicit target. */
export function installProvider(input: InstallProviderInput): InstallResult {
  const { target } = input;
  return withCopyLock<InstallResult>(target, () => ({ path: target, outcome: 'skipped', reason: HERMES_REASONS.busy, backup: null }), () => installLocked(input));
}

function installLocked(input: InstallProviderInput): InstallResult {
  const { target, sourceDir, version } = input;
  let restored: boolean;
  try { restored = recoverInterrupted(target, input.log); } catch (err) {
    return { path: target, outcome: 'failed', reason: `${HERMES_REASONS.failed}: could not clean up after an interrupted update: ${errorText(err)}`, backup: null };
  }
  const state = inspectInstall(target);
  // These two are never replaced, not even with --force: a link is somebody's arrangement, and a directory MeMesh cannot read
  // cannot be saved first.
  if (state.state === 'linked') return { path: target, outcome: 'skipped', reason: `${HERMES_REASONS.linked} (it points to ${state.to})`, backup: null };
  if (state.state === 'unreadable') return { path: target, outcome: 'failed', reason: `${HERMES_REASONS.unreadable} (${state.why})`, backup: null };
  try {
    if (state.state === 'absent') {
      writeCopy(input, false, false);
      return { path: target, outcome: 'installed', reason: HERMES_REASONS.installed, backup: null };
    }
    if (state.state === 'managed' && !state.modified && state.marker.version === version
      && sameHashes(state.marker.files, hashFiles(sourceDir))) {
      return { path: target, outcome: 'unchanged', reason: HERMES_REASONS.unchanged, backup: null };
    }
    if (!input.force) {
      if (state.state === 'foreign') return { path: target, outcome: 'skipped', reason: HERMES_REASONS.notOurs, backup: null };
      if (state.state === 'marker-unreadable') return { path: target, outcome: 'skipped', reason: HERMES_REASONS.markerUnreadable, backup: null };
      if (state.state === 'managed' && state.modified) return { path: target, outcome: 'skipped', reason: HERMES_REASONS.modified, backup: null };
    }
    // Only what is not MeMesh's own unmodified copy is saved: that is the owner's, and it is kept for good.
    const keep = !(state.state === 'managed' && !state.modified);
    const { backup, residue } = writeCopy(input, true, keep);
    const notes: string[] = [HERMES_REASONS.refreshed];
    if (restored) notes.push(HERMES_REASONS.restored);
    if (residue) notes.push(`the old copy could not be removed and is still at ${residue}; delete it by hand`);
    return { path: target, outcome: 'refreshed', reason: notes.join('; '), backup };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('not a plain file')) return { path: target, outcome: 'failed', reason: `${HERMES_REASONS.unsafeSource} (${message})`, backup: null };
    return { path: target, outcome: 'failed', reason: `${HERMES_REASONS.failed}: ${message.slice(0, 160)}`, backup: null };
  }
}

// ─── the places MeMesh has put a copy ──────────────────────────────────────

type Registry = { ok: true; installs: string[] } | { ok: false; why: string };

/** The list of registered copies: no file is an empty list; a file that cannot be read or parsed is a problem, never an empty list. */
function readRegistryState(memeshDir: string): Registry {
  let text: string;
  try {
    text = fs.readFileSync(path.join(memeshDir, REGISTRY_FILE), 'utf8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { ok: true, installs: [] } : { ok: false, why: errorText(err) };
  }
  try {
    const parsed = JSON.parse(text) as { installs?: unknown };
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.installs)) return { ok: false, why: 'it has no "installs" list' };
    return { ok: true, installs: parsed.installs.filter((p): p is string => typeof p === 'string' && path.isAbsolute(p)) };
  } catch (err) {
    return { ok: false, why: `it is not valid JSON (${errorText(err)})` };
  }
}

function readRegistry(memeshDir: string): string[] {
  const state = readRegistryState(memeshDir);
  return state.ok ? state.installs : [];
}

/** What is wrong with the list of registered copies, or null. */
export function registryProblem(memeshDir: string): string | null {
  const state = readRegistryState(memeshDir);
  return state.ok ? null : state.why;
}

/** The result a refresh reports when the list of registered copies cannot be read (null when it can): the copies it names are not being updated. */
export function registryProblemResult(memeshDir: string): InstallResult | null {
  const why = registryProblem(memeshDir);
  if (why === null) return null;
  return { path: path.join(memeshDir, REGISTRY_FILE), outcome: 'failed', reason: `the list of installed copies cannot be read (${why}): the copies it names are not being updated until it is fixed or removed`, backup: null };
}

/**
 * Remember a directory MeMesh installed into, so a later update can find it (e.g. inside a Hermes checkout).
 * A list that cannot be read is never rewritten: that would erase every other copy it names. The write goes to a
 * temporary file that is then renamed, so a crash cannot leave half a list.
 */
export function registerInstall(memeshDir: string, target: string): void {
  const state = readRegistryState(memeshDir);
  if (!state.ok) {
    throw new Error(`${path.join(memeshDir, REGISTRY_FILE)} cannot be read (${state.why}), so it was not changed: fix or remove it, then run the command again`);
  }
  const installs = new Set(state.installs);
  installs.add(path.resolve(target));
  fs.mkdirSync(memeshDir, { recursive: true, mode: 0o700 });
  const file = path.join(memeshDir, REGISTRY_FILE);
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify({ installs: [...installs].sort() }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}

/** Every directory that may hold a MeMesh-installed copy: the default user plugin directory and the registered ones. */
export function candidateInstalls(memeshDir: string, env: NodeJS.ProcessEnv, accountHome?: string | null): string[] {
  // With no home there is no DEFAULT place; the copies that were registered are still looked after.
  const fallback = defaultInstallTargetOrNull(env, accountHome);
  return [...new Set([...(fallback === null ? [] : [fallback]), ...readRegistry(memeshDir)])];
}

export interface RefreshInput {
  /** Where a note about something skipped or not possible goes (the update log). */
  log?: (line: string) => void;
  sourceDir: string;
  version: string;
  memeshDir: string;
  env: NodeJS.ProcessEnv;
  accountHome?: string | null;
  now: Date;
}

/**
 * Every directory a refresh has to look at: where a copy is, where one was registered (so that a copy that
 * vanished is reported, not forgotten) and where an interrupted refresh left an old copy to restore.
 */
export function refreshTargets(memeshDir: string, env: NodeJS.ProcessEnv, accountHome?: string | null): string[] {
  const registered = readRegistry(memeshDir);
  return candidateInstalls(memeshDir, env, accountHome).filter((t) => inspectInstall(t).state !== 'absent' || registered.includes(t) || hasRestorableLeftover(t));
}

/**
 * Bring every copy MeMesh installed to `version`. A copy that was not installed
 * by MeMesh, or was edited by its owner, is reported and left exactly as it is.
 * A copy MeMesh registered that is no longer there is reported as failed. A list of
 * registered copies that cannot be read is reported as failed too: the copies it names are
 * not being updated, and saying nothing would look like "nothing to do".
 */
export function refreshInstalls(input: RefreshInput): InstallResult[] {
  const results: InstallResult[] = [];
  const registry = readRegistryState(input.memeshDir);
  const problem = registryProblemResult(input.memeshDir);
  if (problem) results.push(problem);
  if (defaultInstallTargetOrNull(input.env, input.accountHome) === null) input.log?.('hermes: there is no home directory and HERMES_HOME is not set, so there is no default place for the provider; only the registered copies are looked at');
  const registered = registry.ok ? registry.installs : [];
  for (const target of refreshTargets(input.memeshDir, input.env, input.accountHome)) {
    const backupRoot = path.join(input.memeshDir, 'backups');
    let restored: boolean;
    try { restored = recoverInterrupted(target, input.log); } catch (err) {
      results.push({ path: target, outcome: 'failed', reason: `${HERMES_REASONS.failed}: could not clean up after an interrupted update: ${errorText(err)}`, backup: null });
      continue;
    }
    const state = inspectInstall(target);
    if (state.state === 'absent') {
      if (registered.includes(target)) results.push({ path: target, outcome: 'failed', reason: HERMES_REASONS.gone, backup: null });
      continue;
    }
    if (state.state === 'foreign') {
      // Only a copy MeMesh registered, or one that was just put back, is worth a line; the default location may be someone else's plugin.
      if (registered.includes(target) || restored) results.push({ path: target, outcome: 'skipped', reason: restored ? `${HERMES_REASONS.restored}; ${HERMES_REASONS.notOurs}` : HERMES_REASONS.notOurs, backup: null });
      continue;
    }
    const result = installProvider({ sourceDir: input.sourceDir, target, version: input.version, force: false, backupRoot, now: input.now, ...(input.log ? { log: input.log } : {}) });
    // Said in the result, whatever else happened: the copy had been lost, and it is back.
    if (restored) {
      results.push({ ...result, reason: result.outcome === 'unchanged' ? HERMES_REASONS.restored : `${HERMES_REASONS.restored}; ${result.reason}` });
    } else {
      results.push(result);
    }
  }
  return results;
}

/**
 * Copies a refresh to `version` would change: MeMesh's own, unmodified, at another version (a copy its owner
 * edited is left alone, so it is not "stale": counting it would make every attempt download the package and
 * skip it again), and copies an interrupted refresh lost.
 */
export function staleInstalls(memeshDir: string, env: NodeJS.ProcessEnv, version: string, accountHome?: string | null): string[] {
  return candidateInstalls(memeshDir, env, accountHome).filter((target) => {
    if (hasRestorableLeftover(target)) return true;
    const state = inspectInstall(target);
    return state.state === 'managed' && !state.modified && state.marker.version !== version;
  });
}
