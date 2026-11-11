// =============================================================================
// Anonymous install ID
// =============================================================================
//
// A random UUID stored at `~/.memesh/install.json`, created the first time
// `memesh feedback` builds a report WITH diagnostics (the default; `--no-diagnostics`
// leaves it out and creates nothing). Nothing else creates it: not the doctor, not
// the MCP server, not a hook.
// Purpose: correlate multiple feedback issues filed by the same anonymous user
// without collecting any PII. The doctor shows it when it exists. It is never
// transmitted automatically: it is only put into the issue text that `memesh
// feedback` prints or opens for the user to submit, and the user chooses whether
// to submit it.
//
// Lazy-generate, chmod 600, single canonical location.
//
// Schema is JSON-extensible so we can add fields later (created_at
// is helpful for support; never add anything that maps to a person).

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { memeshDir } from './paths.js';
import { removeGroupAndOtherAccess } from './file-mode.js';

interface InstallRecord {
  install_id: string;
  created_at: string;
  schema_version: 1;
}

const SCHEMA_VERSION = 1 as const;

function installFilePath(): string {
  return path.join(memeshDir(), 'install.json');
}

/** What `install.json` holds, said without inventing anything. */
export type InstallRecordState =
  | { status: 'missing' }
  /** The file is there but cannot be used (unreadable, not JSON, no `install_id`). `reason` is an error code or a short phrase, never a path. */
  | { status: 'unreadable'; reason: string }
  /** `created_at` is null when the file has none or it is not a time: the age is then unknown, not "now". */
  | { status: 'ok'; install_id: string; created_at: string | null };

/**
 * Look at the stored install record and say what is there. Creates nothing: a caller that only reports on the
 * install (the doctor) must not be what leaves it behind, and a record that is absent, damaged or missing its
 * creation time are three different facts that it must be able to tell apart.
 */
export function readInstallRecordState(): InstallRecordState {
  let raw: string;
  try {
    raw = fs.readFileSync(installFilePath(), 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { status: 'missing' };
    return { status: 'unreadable', reason: typeof code === 'string' ? code : 'read error' };
  }
  let parsed: Partial<InstallRecord> | null;
  try {
    parsed = JSON.parse(raw) as Partial<InstallRecord> | null;
  } catch {
    return { status: 'unreadable', reason: 'not valid JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.install_id !== 'string' || parsed.install_id.length === 0) {
    return { status: 'unreadable', reason: 'no install_id in it' };
  }
  const createdAt = typeof parsed.created_at === 'string' && Number.isFinite(new Date(parsed.created_at).getTime())
    ? parsed.created_at
    : null;
  return { status: 'ok', install_id: parsed.install_id, created_at: createdAt };
}

/**
 * Read or lazily create the install record. Idempotent — once
 * generated, the same UUID is returned on every subsequent call from
 * the same machine forever (or until the user deletes the file).
 *
 * Defensive: file-system errors return a synthetic record with
 * install_id = 'unknown' rather than crashing — feedback flows must
 * never block on this.
 */
export function getInstallRecord(): InstallRecord {
  const filePath = installFilePath();
  const state = readInstallRecordState();
  if (state.status === 'ok') {
    return {
      install_id: state.install_id,
      created_at: state.created_at ?? new Date().toISOString(),
      schema_version: SCHEMA_VERSION,
    };
  }

  const record: InstallRecord = {
    install_id: randomUUID(),
    created_at: new Date().toISOString(),
    schema_version: SCHEMA_VERSION,
  };

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // #520: only group/other access comes off; 0700 would hand the owner
    // write access back to a data folder they made read-only.
    removeGroupAndOtherAccess(path.dirname(filePath));
    fs.writeFileSync(filePath, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
    // `mode` above applies only when the file is created; an existing one
    // (rewritten because it was unreadable) keeps its old mode until this.
    removeGroupAndOtherAccess(filePath);
  } catch {
    // Cannot persist — return the in-memory record. Next call will
    // generate a new UUID; that's fine for ephemeral / sandboxed envs.
  }

  return record;
}

/**
 * Convenience: just the UUID. Useful for the FeedbackWidget body
 * builder and the CLI `memesh config get install_id` flow.
 */
export function getInstallId(): string {
  return getInstallRecord().install_id;
}
