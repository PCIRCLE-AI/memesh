// =============================================================================
// install-hooks — wire memesh's session hooks into Claude Code
// =============================================================================
//
// PROBLEM
// ───────
// memesh ships `.claude-plugin/plugin.json` + `hooks/hooks.json` so it
// can run as a Claude Code plugin. But `npm install -g @pcircle/memesh`
// only puts
// the CLI binary on PATH — Claude Code's plugin runtime never reads
// memesh's hooks.json. Result: memesh's auto-capture (session-summary,
// pre-edit-recall, etc.) silently does nothing on every npm install.
//
// FIX
// ───
// Inject memesh's hook entries directly into `~/.claude/settings.json`
// (or `<project>/.claude/settings.json` with --scope project), with
// `${CLAUDE_PLUGIN_ROOT}` substituted to memesh's absolute install
// path. Claude Code merges hook arrays across user-global and
// project-local settings, so this coexists cleanly with whatever
// custom hooks the user has at `~/.claude/hooks/*.js`.
//
// IDEMPOTENT
// ──────────
// Each memesh-installed hook entry carries `_memesh: true` so we can
// detect existing installs, skip writing duplicates, and uninstall
// cleanly later. Re-running with a different memesh version updates
// the absolute paths in place.
//
// SAFETY
// ──────
// Always writes a `<settings>.bak-pre-memesh-<ts>` before modifying.
// Reports conflicts (existing matcher patterns that overlap) without
// blocking — users with their own hooks should know they coexist.

import fs from 'fs';
import path from 'path';
import { homeDir, memeshDir } from './paths.js';
import { CITATION_RULE_BODY, citationRulePath, citationRuleState, type CitationRuleResult } from './citation-rule.js';
import { pluginHostConfigRoot } from './install-channel.js';
import { assertCanDelete, assertCanWrite, assertFolderWritable, Changes, refuse, whyFailed } from './safe-write.js';

type HookCommand = { type: 'command'; command: string; timeout?: number; _memesh?: boolean };
type HookEntry = { matcher?: string; hooks: HookCommand[] };
type HooksByEvent = Record<string, HookEntry[]>;
interface ClaudeSettings {
  hooks?: HooksByEvent;
  [key: string]: unknown;
}

/**
 * Does this Claude Code settings file carry any hook entry stamped with the
 * `_memesh: true` marker this module writes? Exported so `memesh setup` asks
 * the module that OWNS the stamped shape, instead of keeping a third private
 * walker that drifts when the shape moves (doctor has the second, richer
 * walk — it classifies per event and checks script existence, so it stays).
 */
export function settingsHaveMemeshHooks(settingsPath: string): boolean {
  try {
    // readSettings checks the shape of every entry, so the walk below needs no guards of its own.
    const parsed = readSettings(settingsPath);
    return Object.values(parsed?.hooks ?? {}).some((entries) => entries.some((entry) => entry.hooks.some((hook) => hook._memesh === true)));
  } catch { return false; /* missing, unreadable or malformed settings — not wired */ }
}

export interface InstallOptions {
  pluginRoot: string;
  pluginVersion: string;
  scope: 'user' | 'project';
  cwd?: string;
  dryRun?: boolean;
  // Force-write even when Claude Code's plugin runtime already wires the
  // same hooks via `/plugin install memesh@pcircle-memesh`. Without this
  // flag, install-hooks bails on plugin-runtime detection to avoid
  // double-firing every hook every event. Set to true when you genuinely
  // want both paths (rare).
  forceOverPlugin?: boolean;
  // Test seam: override the path used to detect a Claude Code plugin
  // install. Default is `<claude-config>/plugins/installed_plugins.json`.
  installedPluginsPathImpl?: string;
}

export interface InstallResult {
  settingsPath: string;
  backupPath: string | null;
  scope: 'user' | 'project';
  added: number;
  skipped: number;
  /** Memesh entries removed because the manifest no longer declares their
   * (event, matcher) — the upgrade path for retired hooks. User entries are
   * never counted here; they are never touched. */
  pruned: number;
  conflicts: Array<{ event: string; matcher: string; existingCount: number }>;
  markerPath: string;
  /** Whether settings.json was written by this run (false when nothing needed to change). */
  settingsWritten: boolean;
  /** Whether the install marker was written by this run. */
  markerWritten: boolean;
  // When non-null, install-hooks detected an active plugin-runtime install
  // and refused to write. Callers (CLI / dashboard) should surface this
  // to the user with the `--force-over-plugin` escape hatch. `null` means
  // the install either proceeded or was a dry-run.
  pluginRuntimeDetected?: {
    installPath: string;
    version: string;
  } | null;
  /** Where the citation contract landed, and whether it changed. Written on
   *  the plugin path too — see the note in `installHooks`. */
  citationRule: CitationRuleResult;
}

export interface UninstallResult {
  settingsPath: string;
  backupPath: string | null;
  removed: number;
  /** `foreign-file` means a file exists at that path that memesh did not
   *  write, so it was left alone rather than deleted. */
  citationRule: { path: string; action: 'removed' | 'absent' | 'foreign-file' };
}

const MARKER_FILE = 'install-hooks.json';

/**
 * Inspect Claude Code's `installed_plugins.json` for an active memesh
 * plugin install. When present, Claude Code's plugin runtime is already
 * loading memesh's hooks via `<plugin>/hooks/hooks.json`, and writing
 * the same hooks into Claude Code's user settings would double-fire every
 * event. Returns the install metadata when found, else null.
 *
 * Used by `installHooks` as a guard. The default lookup path is
 * `<claude-config>/plugins/installed_plugins.json` but tests can inject
 * an alternate path via `installedPluginsPathImpl`.
 */
export function detectPluginRuntime(
  installedPluginsPathImpl?: string,
): { installPath: string; version: string } | null {
  const defaultPath = path.join(pluginHostConfigRoot('claude-code'), 'plugins', 'installed_plugins.json');
  const targetPath = installedPluginsPathImpl ?? defaultPath;
  if (!fs.existsSync(targetPath)) return null;
  try {
    const raw = fs.readFileSync(targetPath, 'utf8');
    const j = JSON.parse(raw);
    const entries = j?.plugins?.['memesh@pcircle-memesh'];
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const active = entries.find((entry: unknown): entry is { installPath: string; version?: unknown } =>
      typeof entry === 'object'
      && entry !== null
      && typeof (entry as { installPath?: unknown }).installPath === 'string'
      && (entry as { installPath: string }).installPath.length > 0);
    if (!active) return null;
    return {
      installPath: active.installPath,
      version: typeof active.version === 'string' ? active.version : 'unknown',
    };
  } catch {
    return null;
  }
}

// homeDir() and memeshDir() now live in src/core/paths.ts as the single
// canonical source. Imported above. Earlier this file had private copies;
// the reasoning (HOME-first for hermetic tests on Windows) is preserved
// in the JSDoc on `homeDir()` in paths.ts.

function settingsPathFor(scope: 'user' | 'project', cwd: string): string {
  if (scope === 'project') {
    return path.join(cwd, '.claude', 'settings.json');
  }
  return path.join(pluginHostConfigRoot('claude-code'), 'settings.json');
}

const isJsonObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** A settings file memesh will not touch because of what is IN it. */
const settingsRefusal = (p: string, what: string): Error => refuse('settings file', p, what, 'refusing to modify');

/**
 * The merge below reads `{ matcher?, hooks: [{ _memesh? }] }` per event, and a file of any other shape
 * would fail there with a TypeError. Nothing has been written when this throws. `fail` builds the
 * error, so settings.json and memesh's own manifest are judged by one walk and each says its own name.
 */
function assertHooksShape(hooks: unknown, fail: (what: string) => Error): void {
  if (!isJsonObject(hooks)) throw fail('"hooks" is not an object');
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) throw fail(`hooks.${event} is not a list`);
    entries.forEach((entry, i) => {
      const where = `hooks.${event}[${i}]`;
      if (!isJsonObject(entry)) throw fail(`${where} is not an object`);
      if (!Array.isArray(entry.hooks)) throw fail(`${where}.hooks is not a list`);
      entry.hooks.forEach((h: unknown, j: number) => {
        if (!isJsonObject(h)) throw fail(`${where}.hooks[${j}] is not an object`);
      });
    });
  }
}

/** The parsed settings, or null when there is no such file. A file that is there but cannot be used is refused. */
function readSettings(p: string): ClaudeSettings | null {
  if (!fs.existsSync(p)) return null;
  let text: string;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch (err) {
    throw refuse('settings file', p, ` cannot be read (${whyFailed(err)})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // We refuse to overwrite a file we can't parse: the user's existing config
    // matters more than our convenience.
    throw settingsRefusal(p, ' is not valid JSON');
  }
  if (!isJsonObject(parsed)) throw settingsRefusal(p, ' is not a JSON object');
  if (parsed.hooks !== undefined) assertHooksShape(parsed.hooks, (what) => settingsRefusal(p, `: ${what}`));
  return parsed as ClaudeSettings;
}

/** The citation rule's state, or a refusal when the file is there and cannot be read. */
function readRuleState(scope: 'user' | 'project', cwd: string): ReturnType<typeof citationRuleState> {
  try {
    return citationRuleState(scope, homeDir(), cwd);
  } catch (err) {
    throw refuse('citation rule file', citationRulePath(scope, homeDir(), cwd), ` cannot be read (${whyFailed(err)})`);
  }
}

/**
 * Read memesh's plugin manifest and substitute ${CLAUDE_PLUGIN_ROOT}
 * with the absolute path to the memesh install. Returned hooks are
 * marked `_memesh: true` so we can identify and remove them later
 * without disturbing the user's other hooks.
 */
function loadPluginHooks(pluginRoot: string): HooksByEvent {
  const manifestPath = path.join(pluginRoot, 'hooks', 'hooks.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`plugin hooks manifest not found at ${manifestPath}`);
  }
  const damaged = (why: string) => refuse(
    "memesh's own hooks file", manifestPath, ` is damaged (${why}) and cannot be used`,
    'nothing was changed; reinstall memesh and run install-hooks again',
  );
  let manifest: unknown;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw damaged(err instanceof SyntaxError ? 'it is not valid JSON' : whyFailed(err));
  }
  if (!isJsonObject(manifest)) throw damaged('it is not a JSON object');
  assertHooksShape(manifest.hooks, damaged);
  const declared = manifest.hooks as HooksByEvent;
  // An empty manifest would read as "memesh retired every hook" and delete the ones already installed.
  if (Object.values(declared).every((entries) => entries.length === 0)) throw damaged('it declares no hooks');
  const out: HooksByEvent = {};
  for (const [event, entries] of Object.entries(declared)) {
    out[event] = entries.map((entry) => ({
      matcher: entry.matcher,
      hooks: entry.hooks.map((h, j) => {
        if (typeof h.command !== 'string') throw damaged(`hooks.${event}[].hooks[${j}].command is not a string`);
        return {
          type: h.type,
          command: h.command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot),
          ...(h.timeout !== undefined ? { timeout: h.timeout } : {}),
          _memesh: true,
        };
      }),
    }));
  }
  return out;
}

/**
 * Detect whether a settings entry is one we previously installed.
 * Identity test: every command in `hooks[]` carries `_memesh: true`.
 * If the user has manually added `_memesh: true` they are explicitly
 * opting that hook into our lifecycle — defensible behaviour.
 */
function isMemeshEntry(entry: HookEntry): boolean {
  return entry.hooks.length > 0 && entry.hooks.every((h) => h._memesh === true);
}

/**
 * Match desired entry against existing memesh entries on the same
 * event. Same-shape match: matcher equal AND command set equal.
 */
function entryAlreadyPresent(existing: HookEntry[], desired: HookEntry): boolean {
  return existing.some((e) => {
    if (e.matcher !== desired.matcher) return false;
    if (!isMemeshEntry(e)) return false;
    if (e.hooks.length !== desired.hooks.length) return false;
    const cmds = new Set(e.hooks.map((h) => h.command));
    return desired.hooks.every((h) => cmds.has(h.command));
  });
}

/** Runs `fn` with a `Changes` log; when it throws, whatever it changed so far is put back before the error goes on. */
function withRollback<T>(fn: (changes: Changes) => T): T {
  const changes = new Changes();
  try {
    return fn(changes);
  } catch (err) {
    changes.rollBack();
    throw err;
  }
}

const BACKUP_SUFFIX = () => `.bak-pre-memesh-${new Date().toISOString().replace(/[:.]/g, '-')}`;

const RULE_ACTION = { missing: 'created', stale: 'updated', current: 'unchanged', 'foreign-file': 'foreign-file' } as const;

/**
 * Installs the hooks. Every file this run will touch is checked BEFORE the first write (see
 * safe-write.ts), and the writes go settings → marker → citation rule, so a run that cannot finish
 * reports it in one sentence with the machine as it was. A failure the checks could not foresee
 * puts back what the run changed.
 */
export function installHooks(opts: InstallOptions): InstallResult {
  const cwd = opts.cwd ?? process.cwd();
  return withRollback((changes) => installHooksUnguarded(opts, cwd, changes));
}

function installHooksUnguarded(opts: InstallOptions, cwd: string, changes: Changes): InstallResult {
  const settingsPath = settingsPathFor(opts.scope, cwd);
  const markerPath = path.join(memeshDir(), MARKER_FILE);
  const write = !opts.dryRun;

  // The citation rule is handled on the plugin path too. Those are different problems with different
  // owners: the plugin runtime loads `hooks/hooks.json`, so hooks must not be written twice — but
  // nothing in the plugin runtime writes a rules file, so a plugin user would never get the citation
  // contract at all. Skipping it there is how the whole ROI signal stayed at zero for plugin installs.
  const rule = readRuleState(opts.scope, cwd);
  const ruleWritten = write && (rule.state === 'missing' || rule.state === 'stale');
  const citationRule: CitationRuleResult = { path: rule.path, action: write ? RULE_ACTION[rule.state] : 'unchanged' };
  const writeRule = () => {
    if (!ruleWritten) return;
    changes.mkdir(path.dirname(rule.path));
    changes.write(rule.path, CITATION_RULE_BODY);
  };

  // Detect existing Claude Code plugin install BEFORE doing any work.
  // If `/plugin install memesh@pcircle-memesh` already wired the hooks
  // through the plugin runtime, writing user-level hooks here would
  // double-fire every event (plugin runtime + user settings both invoke
  // the same hook scripts → two `session-summary` entities per session,
  // two `pre-edit-recall` injections per Edit, etc.). Bail by default;
  // `forceOverPlugin` is the escape hatch for the rare user who knows
  // they want both surfaces.
  const pluginRuntime = detectPluginRuntime(opts.installedPluginsPathImpl);
  if (pluginRuntime && !opts.forceOverPlugin) {
    if (ruleWritten) assertCanWrite(rule.path, 'citation rule file');
    writeRule();
    return {
      settingsPath,
      backupPath: null,
      scope: opts.scope,
      added: 0,
      skipped: 0,
      pruned: 0,
      conflicts: [],
      markerPath,
      pluginRuntimeDetected: pluginRuntime,
      citationRule,
      settingsWritten: false,
      markerWritten: false,
    };
  }

  const desired = loadPluginHooks(opts.pluginRoot);
  // Read (and validated, down to each entry's shape) BEFORE anything is written:
  // a refusal must leave every file as it was, the citation rule included.
  const settings = readSettings(settingsPath) ?? {};
  const existing = settings.hooks ?? {};

  let added = 0;
  let skipped = 0;
  let pruned = 0;
  const conflicts: InstallResult['conflicts'] = [];

  // Prune memesh entries the manifest no longer declares — BEFORE merging.
  // The merge loop below only iterates DESIRED events/matchers, so a memesh
  // entry under an (event, matcher) the manifest dropped survived every
  // re-install forever, pointing at a script the upgrade deleted: Claude
  // Code then invoked a nonexistent file on every matching tool call, and
  // `memesh install-hooks` — the documented fix for wiring problems — could
  // not heal it. Only memesh's own entries are swept; user hooks are never
  // touched, which is the same boundary uninstallHooks draws.
  //
  // The key joins on U+0000 because it is the one code point a Claude Code
  // event name or matcher pattern cannot contain — a printable separator
  // would let ("PostToolUse Bash", "*") and ("PostToolUse", "Bash *") produce
  // the same key, and that key decides whether a live hook entry is pruned.
  //
  // Written as the ESCAPE, never as a literal NUL byte. It was a literal one,
  // and a text file carrying a NUL is a BINARY file to `grep` and `rg`: both
  // suppress every match in it and exit 1 exactly as they would for a clean
  // file. So this file — the one that edits the user's `settings.json` —
  // answered "no matches" to every pattern any grep-based reviewer ran
  // against it. Identical runtime value; the file is text again.
  const desiredKeys = new Set(
    Object.entries(desired).flatMap(([event, entries]) =>
      entries.map((e) => `${event}\u0000${e.matcher ?? '*'}`)),
  );
  for (const [event, entries] of Object.entries(existing)) {
    const kept = entries.filter(
      (e) => !(isMemeshEntry(e) && !desiredKeys.has(`${event}\u0000${e.matcher ?? '*'}`)),
    );
    pruned += entries.length - kept.length;
    if (kept.length === 0) delete existing[event];
    else existing[event] = kept;
  }

  for (const [event, desiredEntries] of Object.entries(desired)) {
    if (!existing[event]) existing[event] = [];
    for (const desiredEntry of desiredEntries) {
      // Read live state each iteration — earlier passes through this
      // inner loop may have already appended to existing[event].
      const live = existing[event];
      if (entryAlreadyPresent(live, desiredEntry)) {
        skipped++;
        continue;
      }
      // Detect overlap: same-event, same-matcher, but NOT a memesh
      // entry. We coexist by appending — flag for the user.
      const overlap = live.filter(
        (e) => e.matcher === desiredEntry.matcher && !isMemeshEntry(e),
      );
      if (overlap.length > 0) {
        conflicts.push({
          event,
          matcher: desiredEntry.matcher ?? '*',
          existingCount: overlap.reduce((n, e) => n + e.hooks.length, 0),
        });
      }
      // Replace any stale memesh entry with the same matcher (so
      // re-running after a memesh upgrade picks up new paths).
      existing[event] = [
        ...live.filter((e) => !(e.matcher === desiredEntry.matcher && isMemeshEntry(e))),
        desiredEntry,
      ];
      added++;
    }
  }

  const marker = {
    version: opts.pluginVersion,
    plugin_root: opts.pluginRoot,
    scope: opts.scope,
    settings_path: settingsPath,
  };
  const current = readInstallMarker();
  const markerCurrent = current !== null
    && (Object.keys(marker) as Array<keyof typeof marker>).every((key) => current[key] === marker[key]);

  // An install that changes nothing writes nothing: no new settings backup, no rewrite of
  // settings.json, and no new marker — the marker's mtime is what doctor's "hooks were just wired"
  // grace period is measured from, so refreshing it on every run kept extending that grace. The
  // marker says "hooks are wired here": it is written when settings.json was changed, or when it is
  // missing or describes a different install.
  const settingsNeeded = write && (added > 0 || pruned > 0);
  const markerNeeded = write && (settingsNeeded || !markerCurrent);

  // Everything this run will write is checked before the first write.
  if (settingsNeeded) {
    assertCanWrite(settingsPath, 'settings file');
    if (fs.existsSync(settingsPath)) assertFolderWritable(path.dirname(settingsPath)); // the backup is a new file beside it
  }
  if (markerNeeded) assertCanWrite(markerPath, 'install marker file');
  if (ruleWritten) assertCanWrite(rule.path, 'citation rule file');

  let backupPath: string | null = null;
  if (settingsNeeded) {
    if (fs.existsSync(settingsPath)) backupPath = changes.copyNew(settingsPath, BACKUP_SUFFIX());
    settings.hooks = existing;
    changes.mkdir(path.dirname(settingsPath));
    changes.write(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }
  if (markerNeeded) {
    // Marker — doctor reads this to confirm hooks are wired AND
    // know which scope/path so it can verify they still match.
    changes.mkdir(path.dirname(markerPath));
    changes.write(markerPath, JSON.stringify({ installed_at: new Date().toISOString(), ...marker }, null, 2) + '\n');
  }
  writeRule();

  return {
    citationRule,
    settingsPath,
    backupPath,
    scope: opts.scope,
    added,
    skipped,
    pruned,
    conflicts,
    markerPath,
    settingsWritten: settingsNeeded,
    markerWritten: markerNeeded,
  };
}

export interface UninstallOptions {
  scope: 'user' | 'project';
  cwd?: string;
  dryRun?: boolean;
}

/**
 * Removes memesh's hook entries. Like the install, every file it will touch is checked before the
 * first change, and the order is settings → marker → citation rule: the rule file is only removed
 * once the settings have been written back, and a run that cannot finish leaves everything as it was.
 */
export function uninstallHooks(opts: UninstallOptions): UninstallResult {
  const cwd = opts.cwd ?? process.cwd();
  return withRollback((changes) => uninstallHooksUnguarded(opts, cwd, changes));
}

function uninstallHooksUnguarded(opts: UninstallOptions, cwd: string, changes: Changes): UninstallResult {
  const settingsPath = settingsPathFor(opts.scope, cwd);
  const markerPath = path.join(memeshDir(), MARKER_FILE);
  const write = !opts.dryRun;

  // Everything is read BEFORE anything is changed: a refusal has to mean nothing was modified.
  const settings = readSettings(settingsPath);
  const rule = readRuleState(opts.scope, cwd);

  let removed = 0;
  if (settings) {
    const existing = settings.hooks ?? {};
    for (const [event, entries] of Object.entries(existing)) {
      const before = entries.length;
      existing[event] = entries.filter((e) => !isMemeshEntry(e));
      removed += before - existing[event].length;
      if (existing[event].length === 0) {
        delete existing[event];
      }
    }
    if (Object.keys(existing).length === 0) {
      delete settings.hooks;
    } else {
      settings.hooks = existing;
    }
  }

  // The rule file goes on EVERY exit, including the one where settings.json does not exist: a plugin
  // install never writes settings.json but does get the rule file, so returning early without this
  // would leave the contract behind on exactly the install shape that owns it.
  const ruleRemoved = write && (rule.state === 'current' || rule.state === 'stale');
  const settingsWritten = write && settings !== null && removed > 0;
  const markerRemoved = settingsWritten && fs.existsSync(markerPath);

  if (settingsWritten) {
    assertCanWrite(settingsPath, 'settings file');
    assertFolderWritable(path.dirname(settingsPath)); // the backup is a new file beside it
  }
  if (markerRemoved) assertCanDelete(markerPath, 'install marker file');
  if (ruleRemoved) assertCanDelete(rule.path, 'citation rule file');

  let backupPath: string | null = null;
  if (settingsWritten) {
    backupPath = changes.copyNew(settingsPath, BACKUP_SUFFIX());
    changes.write(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }
  if (markerRemoved) changes.remove(markerPath);
  if (ruleRemoved) changes.remove(rule.path);

  const action = !write ? 'absent' : ruleRemoved ? 'removed' : rule.state === 'foreign-file' ? 'foreign-file' : 'absent';
  return { settingsPath, backupPath, removed, citationRule: { path: rule.path, action } };
}

/**
 * Read the install marker if present. doctor uses this to verify
 * hooks were installed by `memesh install-hooks` (not just present
 * on disk by happenstance) and that the recorded paths still exist.
 */
export interface InstallMarker {
  installed_at: string;
  version: string;
  plugin_root: string;
  scope: 'user' | 'project';
  settings_path: string;
}

export function readInstallMarker(): InstallMarker | null {
  const markerPath = path.join(memeshDir(), MARKER_FILE);
  if (!fs.existsSync(markerPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(markerPath, 'utf8')) as InstallMarker;
  } catch {
    return null;
  }
}
