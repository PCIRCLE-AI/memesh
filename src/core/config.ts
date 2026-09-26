import fs from 'fs';
import path from 'path';
import { memeshDir } from './paths.js';
// #431 — the sessionLimit range, the integer check and the effective-value
// resolver live in the zero-import leaf below (mirrored verbatim for the
// hooks by scripts/generate-hook-core.mjs); this file is not itself a leaf
// (it touches fs/paths.ts), so a hook imports the generated copy directly,
// never through this re-export.
export { SESSION_LIMIT_MIN, SESSION_LIMIT_MAX, isSessionLimitInRange } from './session-limit.js';

export interface MeMeshConfig {
  autoCapture?: boolean;
  /** The SessionStart top-N memory-injection limit (#431) — see
   * `core/session-limit.ts` for the range and what an out-of-range stored
   * value resolves to. Enforced on write only; a read passes it through
   * unfiltered, like `briefing` below. */
  sessionLimit?: number;
  autoUpdate?: 'off' | 'patch' | 'minor' | 'major';
  /** false = "never ask again": no first-use update notice, no refresh spawn. Default true. */
  updateCheck?: boolean;
  setupCompleted?: boolean;
  /**
   * #360 — how much of the injected briefing to assemble: 'minimal' |
   * 'standard' | 'full' (`core/briefing-level.ts`). Typed as `unknown`, not
   * even `string`: an invalid stored value — a hand-edited config.json with
   * `"briefing": 42`, an older/newer memesh writing a value this version
   * does not know, ANY JSON type — must still reach `resolveBriefingLevel`,
   * which is where "unknown value" is validated AND reported. Round 3 of
   * #360's review found that `selectConfig` below used to gate this field
   * on `typeof === 'string'` (the way `autoUpdate` gates on its own enum),
   * which silently dropped a non-string value before the resolver ever saw
   * it — the hook (which reads raw JSON directly, never through this file)
   * reported it invalid; `assembleBriefing`, the CLI, the MCP tool and
   * `GET /v1/config` all silently used the default instead, with no
   * recorded reason anywhere. The value now survives this file unfiltered,
   * whatever its type, and `resolveBriefingLevel`'s own `isBriefingLevel`
   * check is what rejects it — the SAME check for every surface.
   */
  briefing?: unknown;
}

const CONFIG_KEYS = ['autoCapture', 'sessionLimit', 'autoUpdate', 'updateCheck', 'setupCompleted', 'briefing'] as const;
export const RETIRED_CONFIG_KEYS = [
  'llm',
  'llmFallbacks',
  'embedder',
  'language',
  'transcriptMining',
] as const;
export type RetiredConfigKey = typeof RETIRED_CONFIG_KEYS[number];
type RawConfig = Record<string, unknown>;

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function configDir(): string {
  return memeshDir();
}

function configFilePath(): string {
  return path.join(configDir(), 'config.json');
}

let lastConfigReadWarning: string | null = null;

export type ConfigReadState = 'ok' | 'absent' | 'unreadable';

export interface ConfigReadResult {
  config: MeMeshConfig;
  state: ConfigReadState;
}

interface RawConfigReadResult {
  raw: RawConfig;
  state: ConfigReadState;
}

function warnUnreadable(p: string, detail: string): void {
  const key = `${p}::${detail}`;
  if (key === lastConfigReadWarning) return;
  lastConfigReadWarning = key;
  try {
    process.stderr.write(
      `[memesh config] ${p} exists but could not be read as a settings object (${detail}). ` +
        'Existing settings are ignored and will not be overwritten until the file is fixed.\n',
    );
  } catch {
    // Diagnostics must never break a caller.
  }
}

function readRawConfigResult(): RawConfigReadResult {
  const p = configFilePath();
  if (!fs.existsSync(p)) return { raw: {}, state: 'absent' };
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('top-level JSON value is not an object');
    }
    return { raw: parsed as RawConfig, state: 'ok' };
  } catch (error) {
    warnUnreadable(p, error instanceof Error ? error.message : String(error));
    return { raw: {}, state: 'unreadable' };
  }
}

function selectConfig(raw: RawConfig): MeMeshConfig {
  const config: MeMeshConfig = {};
  if (typeof raw.autoCapture === 'boolean') config.autoCapture = raw.autoCapture;
  if (typeof raw.sessionLimit === 'number' && Number.isFinite(raw.sessionLimit)) {
    config.sessionLimit = raw.sessionLimit;
  }
  if (
    raw.autoUpdate === 'off' ||
    raw.autoUpdate === 'patch' ||
    raw.autoUpdate === 'minor' ||
    raw.autoUpdate === 'major'
  ) {
    config.autoUpdate = raw.autoUpdate;
  }
  if (typeof raw.updateCheck === 'boolean') config.updateCheck = raw.updateCheck;
  if (typeof raw.setupCompleted === 'boolean') config.setupCompleted = raw.setupCompleted;
  // Passed through UNVALIDATED and UNFILTERED on purpose, whatever its JSON
  // type — see the field comment on MeMeshConfig.briefing. `!== undefined`
  // only (not a `typeof` gate): `null` is deliberately preserved too — this
  // file's job is only to not discard it before `resolveBriefingLevel` (the
  // one owner of what counts as valid) can see it. Round 5 (Codex round 4
  // re-review, item 2): that resolver used to treat an explicit `null` the
  // same as "not set"; it now treats it as an invalid stored value like any
  // other (checked against the product: `memesh config unset briefing`
  // deletes the key, never writes `null` — nothing in this codebase does),
  // so a hand-written `null` gets the default level AND a recorded reason,
  // the same as `42` or `"banana"` would.
  if (raw.briefing !== undefined) config.briefing = raw.briefing;
  return config;
}

/**
 * Return only known retired top-level key names. Object.keys deliberately
 * avoids reading their values: legacy provider objects can still contain
 * credentials, and diagnostics must never inspect or print them.
 */
export function findRetiredConfigKeys(raw: object): RetiredConfigKey[] {
  const present = new Set(Object.keys(raw));
  return RETIRED_CONFIG_KEYS.filter((key) => present.has(key));
}

export function readConfigResult(): ConfigReadResult {
  const result = readRawConfigResult();
  return { config: selectConfig(result.raw), state: result.state };
}

export function readConfig(): MeMeshConfig {
  return readConfigResult().config;
}

function writeRawConfig(raw: RawConfig): void {
  const dir = configDir();
  const p = configFilePath();
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    fs.chmodSync(dir, PRIVATE_DIR_MODE);
  } catch {
    // Best-effort hardening only.
  }
  fs.writeFileSync(p, JSON.stringify(raw, null, 2), { mode: PRIVATE_FILE_MODE });
  try {
    fs.chmodSync(p, PRIVATE_FILE_MODE);
  } catch {
    // Best-effort hardening only.
  }
}

export class ConfigUnreadableError extends Error {
  constructor(p: string) {
    super(
      `Refusing to modify ${p}: the existing config could not be read, so saving ` +
        'would silently delete settings already in it. Fix or remove the file, then retry.',
    );
    this.name = 'ConfigUnreadableError';
  }
}

/**
 * Update retained settings without deleting retired provider, credential,
 * vector, transcript-mining, or unknown extension data. Active configuration
 * selection continues to ignore retired keys.
 */
export function updateConfig(partial: Partial<MeMeshConfig>): MeMeshConfig {
  const result = readRawConfigResult();
  if (result.state === 'unreadable') throw new ConfigUnreadableError(configFilePath());
  const raw: RawConfig = { ...result.raw };
  for (const key of CONFIG_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(partial, key)) continue;
    const value = partial[key];
    if (value === undefined) delete raw[key];
    else raw[key] = value;
  }
  writeRawConfig(raw);
  return selectConfig(raw);
}

export function getConfigDir(): string {
  return configDir();
}

export function getConfigPath(): string {
  return configFilePath();
}
