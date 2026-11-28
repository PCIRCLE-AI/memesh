// Citation instructions used by the MCP server and explicit `install-hooks`.
// SessionStart never creates or rewrites Claude configuration; explicit writes
// use their own marked rule file and refuse files MeMesh did not create.

import fs from 'fs';
import path from 'path';

/** Marks the file as memesh's, so we never overwrite or delete a file a user
 *  wrote by hand at the same path. Checked on both write and remove. */
export const CITATION_RULE_MARKER = '<!-- managed-by: memesh -->';

export const CITATION_RULE_FILENAME = 'memesh-citations.md';

/**
 * The saving contract, in the two places a model reads as instructions: this
 * rule file and the MCP server's `instructions`. Saving is the default;
 * users can request removal of specific existing memories. Nothing here
 * ranks what is "worth" saving — that is the choice this sentence removes.
 */
export const DEFAULT_SAVE_INSTRUCTION =
  'Saving is on by default: store the decisions, preferences, lessons and facts that come up in the work with the memesh `remember` tool, without waiting to be asked; give a decision its reason as `why`. When the user asks to remove a specific stored memory, use `recall` to identify it and `forget` to archive that memory or remove the selected observation.';

export const DEFAULT_CITATION_INSTRUCTION =
  'When an injected memory genuinely informs your work, cite it inline once as `[mem:42]`; do not cite a memory you only read past, and never invent an id.';

/**
 * The contract itself.
 *
 * Deliberately short: this is loaded as an instruction on every session, so
 * its length is a permanent per-session cost.
 */
export const CITATION_RULE_BODY = `${CITATION_RULE_MARKER}
# MeMesh memory citations

MeMesh injects relevant memories at session start and before file edits. Every
injected line ends with a handle: \`[mem:42]\`.

${DEFAULT_CITATION_INSTRUCTION}

An uncited memory is recorded as unused: that is how MeMesh learns which
memories are worth the tokens they cost you.

# MeMesh saving

${DEFAULT_SAVE_INSTRUCTION}
`;

export type CitationRuleScope = 'user' | 'project';

/**
 * Where the rule lives.
 *
 * `home` is a parameter rather than a `homeDir()` call so this module imports
 * nothing but node builtins. User scope still checks `CLAUDE_CONFIG_DIR` here,
 * in the one implementation shared by install-hooks, doctor and uninstall.
 * The hook mirror keeps the installed hook module surface aligned with this
 * contract, but SessionStart does not write it.
 */
export function citationRuleDir(scope: CitationRuleScope, home: string, cwd: string): string {
  if (scope === 'project') return path.join(cwd, '.claude', 'rules');
  const relocated = process.env.CLAUDE_CONFIG_DIR;
  const configRoot = relocated ? path.resolve(relocated) : path.join(home, '.claude');
  return path.join(configRoot, 'rules');
}

export function citationRulePath(scope: CitationRuleScope, home: string, cwd: string): string {
  return path.join(citationRuleDir(scope, home, cwd), CITATION_RULE_FILENAME);
}

/**
 * Read the rule file in ONE syscall, or report that it is not there.
 *
 * Not `existsSync` then `readFileSync`. That pair is a time-of-check /
 * time-of-use race (CodeQL `js/file-system-race`, reported high on this file):
 * between the two calls the path can be replaced, and this path lives inside
 * the user's own `~/.claude/` tree. Reading first and classifying ENOENT has
 * no window at all — and it is also simply more correct, because "the file
 * vanished between the check and the read" stops being a crash.
 */
function readRule(
  filePath: string,
  fsImpl: Pick<typeof fs, 'readFileSync'>,
): { kind: 'absent' } | { kind: 'read'; text: string } {
  try {
    return { kind: 'read', text: String(fsImpl.readFileSync(filePath, 'utf8')) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { kind: 'absent' };
    throw err;
  }
}

export type CitationRuleAction = 'created' | 'updated' | 'unchanged' | 'foreign-file';

export interface CitationRuleResult {
  path: string;
  action: CitationRuleAction;
}

/**
 * Write the rule, idempotently.
 *
 * `foreign-file` is a refusal, not a failure: a file at this path without the
 * memesh marker belongs to the user, and overwriting it would destroy
 * instructions they wrote. Reported so it is visible rather than silently
 * skipped — the caller surfaces it and the user decides.
 */
export function writeCitationRule(
  scope: CitationRuleScope,
  home: string,
  cwd: string,
  fsImpl: Pick<typeof fs, 'readFileSync' | 'writeFileSync' | 'mkdirSync'> = fs,
): CitationRuleResult {
  const filePath = citationRulePath(scope, home, cwd);
  const existing = readRule(filePath, fsImpl);

  if (existing.kind === 'read') {
    if (!existing.text.includes(CITATION_RULE_MARKER)) {
      return { path: filePath, action: 'foreign-file' };
    }
    if (existing.text === CITATION_RULE_BODY) return { path: filePath, action: 'unchanged' };
    fsImpl.writeFileSync(filePath, CITATION_RULE_BODY);
    return { path: filePath, action: 'updated' };
  }

  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  fsImpl.writeFileSync(filePath, CITATION_RULE_BODY);
  return { path: filePath, action: 'created' };
}

export type CitationRuleRemoval = 'removed' | 'absent' | 'foreign-file';

/** Remove the rule. Refuses to delete a file memesh did not write. */
export function removeCitationRule(
  scope: CitationRuleScope,
  home: string,
  cwd: string,
  fsImpl: Pick<typeof fs, 'readFileSync' | 'rmSync'> = fs,
): { path: string; action: CitationRuleRemoval } {
  const filePath = citationRulePath(scope, home, cwd);
  const existing = readRule(filePath, fsImpl);
  if (existing.kind === 'absent') return { path: filePath, action: 'absent' };
  if (!existing.text.includes(CITATION_RULE_MARKER)) return { path: filePath, action: 'foreign-file' };
  fsImpl.rmSync(filePath);
  return { path: filePath, action: 'removed' };
}

export type CitationRuleState = 'current' | 'stale' | 'missing' | 'foreign-file';

/**
 * What doctor reports.
 *
 * Three states, not two: `stale` (an older wording is installed) is separate
 * from `missing` because the remedies differ — one is a re-install, the other
 * is a first install — and collapsing them would report a healthy-but-old
 * install as if memesh had never been wired up.
 */
export function citationRuleState(
  scope: CitationRuleScope,
  home: string,
  cwd: string,
  fsImpl: Pick<typeof fs, 'readFileSync'> = fs,
): { path: string; state: CitationRuleState } {
  const filePath = citationRulePath(scope, home, cwd);
  const existing = readRule(filePath, fsImpl);
  if (existing.kind === 'absent') return { path: filePath, state: 'missing' };
  if (!existing.text.includes(CITATION_RULE_MARKER)) return { path: filePath, state: 'foreign-file' };
  return { path: filePath, state: existing.text === CITATION_RULE_BODY ? 'current' : 'stale' };
}
