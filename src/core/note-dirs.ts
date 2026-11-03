// =============================================================================
// note-dirs — which folders hold a person's own memory notes
// =============================================================================
//
// A note memory records the id of the folder it came from (`note_dir_id`: a
// hash of that folder's real path). The Stop hook ingests the notes Claude
// Code keeps for a project under `<claude home>/projects/<project>/memory`;
// those are the person's own, and everything else a note can come from
// (`memesh import --notes <any folder>`) is not known to be.

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { homeDir } from './paths.js';

/** The id a note memory stores for the folder it was read from. */
export function noteDirId(realDir: string): string {
  return createHash('sha256').update(realDir).digest('hex').slice(0, 16);
}

/**
 * The ids of every memory folder Claude Code keeps today: the real path of each
 * `<claude home>/projects/<project>/memory` that exists and is a folder. A
 * folder that is gone cannot be recognised, so what came from it is not
 * counted as the person's own.
 */
export function ownMemoryDirIds(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const claudeHome = env.CLAUDE_CONFIG_DIR && path.isAbsolute(env.CLAUDE_CONFIG_DIR)
    ? env.CLAUDE_CONFIG_DIR
    : path.join(homeDir(), '.claude');
  const projects = path.join(claudeHome, 'projects');
  const ids = new Set<string>();
  let names: string[];
  try {
    names = fs.readdirSync(projects);
  } catch {
    return ids;
  }
  for (const name of names) {
    const memory = path.join(projects, name, 'memory');
    try {
      if (!fs.lstatSync(memory).isDirectory()) continue;
      ids.add(noteDirId(fs.realpathSync(memory)));
    } catch {
      // No memory folder for this project.
    }
  }
  return ids;
}
