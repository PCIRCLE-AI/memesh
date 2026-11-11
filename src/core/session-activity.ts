import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ClaudeTranscriptReader } from '../host-runtime/claude-transcript.js';
import { projectTranscriptSlug } from './transcript-source.js';
import { homeDir } from './paths.js';

const MAX_BYTES = 1024 * 1024;
/** A session registry file is a few hundred bytes; anything larger is not one. */
const MAX_REGISTRY_BYTES = 64 * 1024;

function readTail(file: string, forbiddenModeBits = 0, refuseOverBytes = Infinity): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const stat = fs.fstatSync(fd); const named = fs.lstatSync(file);
    if (!stat.isFile() || named.dev !== stat.dev || named.ino !== stat.ino || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (process.platform !== 'win32' && (stat.mode & forbiddenModeBits) !== 0) || stat.size > refuseOverBytes) return undefined;
    const start = Math.max(0, stat.size - MAX_BYTES); const bytes = Buffer.alloc(stat.size - start);
    const n = fs.readSync(fd, bytes, 0, bytes.length, start);
    const text = bytes.subarray(0, n).toString('utf8');
    return start ? text.slice(text.indexOf('\n') + 1) : text;
  } catch { return undefined; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function formatSessionActivity(fields: { repo?: string; status?: string; title?: string; task?: string }): string | undefined {
  const parts = [fields.repo, fields.status, fields.title, fields.task ? `進行中：${fields.task}` : undefined].filter((v): v is string => Boolean(v));
  const result = Array.from(parts.join(' · '), char => char.charCodeAt(0) < 32 ? ' ' : char).join('').trim();
  if (!result) return undefined;
  return result.slice(0, 200).replace(/[\uD800-\uDBFF]$/, '');
}

export function readCodexTitle(codexHome: string, session: string): string | undefined {
  const text = readTail(path.join(codexHome, 'session_index.jsonl'));
  if (!text) return undefined;
  for (const line of text.split('\n').reverse()) {
    try { const value = JSON.parse(line); if (value.id === session && typeof value.thread_name === 'string' && value.thread_name.trim()) return value.thread_name.trim(); } catch { /* partial or invalid line */ }
  }
  return undefined;
}

export function readCodexPlanActivity(dataDir: string, session: string, workspace: string): string | undefined {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(session)) return undefined;
  const text = readTail(path.join(dataDir, 'codex-plan-activity', `${session}.json`), 0o077);
  try {
    const state = JSON.parse(text ?? '');
    if (state.session !== session || typeof state.workspace !== 'string' || fs.realpathSync(state.workspace) !== fs.realpathSync(workspace)) return undefined;
    return typeof state.task === 'string' && state.task.trim() ? state.task.trim() : undefined;
  } catch { return undefined; }
}

function repoLabel(workspace: string): string | undefined {
  try {
    const value = execFileSync('git', ['rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD'], { cwd: workspace, encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n');
    return value.length === 2 && value[0] && value[1] ? `${path.basename(value[0])}@${value[1]}` : undefined;
  } catch { return undefined; }
}

export const defaultClaudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(homeDir(), '.claude');

const startByPid = new Map<number, string>();
const unreadableLogged = new Set<number>();
/** When `ps` last failed for a pid; it is not asked again until then, so a hung `ps` costs one wait, not one per read. */
const unreadableUntil = new Map<number, number>();
const UNREADABLE_RETRY_MS = 30_000;

/**
 * When `pid` started, in the form Claude Code writes as `procStart` (`ps`
 * lstart, UTC, C locale). `null`: there is no such process. `undefined`: `ps`
 * could not tell (cannot run, timed out). A start time read once is kept for
 * that pid, so the answer does not depend on `ps` working every time it is
 * asked, and `ps` is not started again for every check of the same session.
 * A pid reused by a later process only matters for a registry file left behind
 * by an earlier one, which is checked against the first reading of this run.
 * Not available on Windows, where there is no `ps`.
 */
function processStart(pid: number): string | null | undefined {
  const known = startByPid.get(pid);
  if (known !== undefined) return known;
  const retryAt = unreadableUntil.get(pid);
  if (retryAt !== undefined && Date.now() < retryAt) return undefined;
  try {
    const text = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
    }).trim();
    if (!text) return null;
    if (startByPid.size >= 64) startByPid.clear();
    startByPid.set(pid, text);
    return text;
  } catch (error) {
    // `ps` ran and found no such process: exit status 1.
    if ((error as { status?: unknown }).status === 1) return null;
    if (unreadableUntil.size >= 64) unreadableUntil.clear();
    unreadableUntil.set(pid, Date.now() + UNREADABLE_RETRY_MS);
    if (!unreadableLogged.has(pid)) {
      unreadableLogged.add(pid);
      try { process.stderr.write(`[memesh] could not read the start time of process ${pid} (${(error as Error).message.split('\n')[0]}); its Claude session registry file is used without that check\n`); } catch { /* stderr gone */ }
    }
    return undefined;
  }
}

/**
 * Whether the start time `ps` printed is the one the registry recorded. `ps`
 * pads a single-digit day with an extra space, so spacing is not compared.
 */
export function startsMatch(actual: string, recorded: string): boolean {
  const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
  return squash(actual) === squash(recorded);
}

/**
 * The registry file Claude Code keeps for the session whose process id is `pid`.
 * Found by pid, never by folder: a plugin's host process runs in the project root,
 * while the session itself may be in a linked worktree.
 */
export function readClaudeRegistry(pid: number, claudeDir = defaultClaudeDir()): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readTail(path.join(claudeDir, 'sessions', `${pid}.json`), 0o022, MAX_REGISTRY_BYTES) ?? '');
    if (!value || typeof value !== 'object' || Array.isArray(value) || (value as Record<string, unknown>).pid !== pid) return undefined;
    // A file left behind by an earlier process whose id was reused names that process, not this one.
    // The session id is no substitute: it changes after /clear while the process stays.
    const { procStart } = value as Record<string, unknown>;
    if (typeof procStart === 'string' && process.platform !== 'win32') {
      const actual = processStart(pid);
      if (actual !== undefined && (actual === null || !startsMatch(actual, procStart))) return undefined;
    }
    return value as Record<string, unknown>;
  } catch { /* missing, unreadable or not JSON */ }
  return undefined;
}

export function createClaudeActivity(pid: number, workspace: string, claudeDir = defaultClaudeDir()): () => string | undefined {
  let slug: string | undefined;
  let reader: ClaudeTranscriptReader | undefined;
  return () => {
    const registry = readClaudeRegistry(pid, claudeDir);
    const status = registry?.status === 'busy' || registry?.status === 'idle' ? registry.status : undefined;
    const title = typeof registry?.name === 'string' ? registry.name : undefined;
    if (registry && typeof registry.cwd === 'string') {
      const currentSlug = projectTranscriptSlug(registry.cwd);
      if (currentSlug !== slug) { slug = currentSlug; reader = new ClaudeTranscriptReader(path.join(claudeDir, 'projects'), slug); }
    }
    const task = typeof registry?.sessionId === 'string' ? reader?.currentTask(registry.sessionId) : undefined;
    return formatSessionActivity({ repo: repoLabel(typeof registry?.cwd === 'string' ? registry.cwd : workspace), status, title, task });
  };
}

export function createCodexActivity(session: string, workspace: string, dataDir: string, codexHome = process.env.CODEX_HOME || path.join(homeDir(), '.codex')): () => string | undefined {
  return () => formatSessionActivity({ repo: repoLabel(workspace), title: readCodexTitle(codexHome, session), task: readCodexPlanActivity(dataDir, session, workspace) });
}
