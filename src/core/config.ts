import fs from 'fs';
import path from 'path';
import { memeshDir } from './paths.js';

export interface MeMeshConfig {
  autoCapture?: boolean;
  sessionLimit?: number;
  autoUpdate?: 'off' | 'patch' | 'minor' | 'major';
  setupCompleted?: boolean;
}

const CONFIG_KEYS = ['autoCapture', 'sessionLimit', 'autoUpdate', 'setupCompleted'] as const;
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
  if (typeof raw.setupCompleted === 'boolean') config.setupCompleted = raw.setupCompleted;
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
