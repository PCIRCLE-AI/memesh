// =============================================================================
// note-dirs — the id a note memory keeps for the folder it came from
// =============================================================================
//
// A note memory records the id of the folder it came from (`note_dir_id`: a
// hash of that folder's real path).

import { createHash } from 'crypto';

/** The id a note memory stores for the folder it was read from. */
export function noteDirId(realDir: string): string {
  return createHash('sha256').update(realDir).digest('hex').slice(0, 16);
}
