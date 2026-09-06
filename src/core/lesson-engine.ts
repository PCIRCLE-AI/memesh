import { remember } from './operations.js';
import type { LessonSeverity } from './types.js';
import { getDatabase } from '../db.js';
import { lessonSlug } from './lesson-slug.js';

/**
 * Create a lesson from explicit user input (for the learn tool).
 * Does not require LLM — user provides the structured fields.
 */
export function createExplicitLesson(
  error: string,
  fix: string,
  projectName: string,
  opts?: {
    rootCause?: string;
    prevention?: string;
    severity?: LessonSeverity;
    errorPattern?: string;
    sourceHost?: string;
  }
): { name: string } {
  const errorPattern = opts?.errorPattern || inferErrorPattern(error);
  // Keyed on the lesson's own content, not on the seven-value error enum.
  //
  // `lesson-${project}-${errorPattern}` is the right key for a
  // recurring runtime error: same pattern, same entity, the
  // observations accumulate. It is the wrong key for an explicit lesson,
  // where the categories are all code-level runtime errors and anything about
  // test design, a security boundary, or a process falls into `other` — one
  // bucket per project. Measured on a real graph: one `-other` entity holding
  // 68 observations, roughly seventeen unrelated lessons fused, retrieved 61
  // times and matched 3. Re-submitting the SAME error text still lands on the
  // same slug, so the append/dedupe contract for a repeated lesson holds.
  //
  // A caller that passes an explicit `errorPattern` deliberately requests a
  // stable recurring-error key. Only the unkeyed explicit `learn` gets the
  // content-derived slug.
  const name = opts?.errorPattern
    ? `lesson-${projectName}-${errorPattern}`
    : `lesson-${projectName}-${lessonSlug(error)}`;

  remember({
    name,
    type: 'lesson_learned',
    observations: [
      `Error: ${error}`,
      `Root cause: ${opts?.rootCause || 'Not specified'}`,
      `Fix: ${fix}`,
      `Prevention: ${opts?.prevention || 'Review similar code paths'}`,
    ],
    tags: [
      `project:${projectName}`,
      `error-pattern:${errorPattern}`,
      `severity:${opts?.severity || 'minor'}`,
      'source:explicit',
    ],
    sourceHost: opts?.sourceHost,
  });

  // Explicit user `learn` = highest-trust signal: user asserted "this
  // happened, here's the fix." Reset confidence to 1.0 so a freshly
  // re-confirmed lesson is not held back by the lifecycle decay applied
  // before the re-confirmation.
  getDatabase()
    .prepare('UPDATE entities SET confidence = 1.0 WHERE name = ?')
    .run(name);

  return { name };
}

// `findProjectLessons` was removed in 2026-05 (SDD G8 cleanup). The
// session-start hook (scripts/hooks/session-start.js) does not use it
// — that path executes its own raw SQL with a trust filter
// (`isTrustedForAutoContext`) the helper did not enforce. Keeping the
// helper around as "documentation that this query exists" only invited
// future drift between two separate lookup paths. Use the hook's
// query directly if a similar lookup is needed elsewhere.

/**
 * Infer error pattern from error description text.
 * Simple heuristic — used when user doesn't specify pattern.
 */
/**
 * The fixed set of error patterns `inferErrorPattern` can return.
 * Exported so other modules (notably `projects.ts`) can anchor on the
 * same set instead of duplicating the strings — preventing silent
 * drift if a new pattern is added here.
 */
export const KNOWN_ERROR_PATTERNS = [
  'null-reference',
  'type-error',
  'import-missing',
  'config-error',
  'test-failure',
  'build-error',
  'other',
] as const;

function inferErrorPattern(error: string): string {
  const lower = error.toLowerCase();
  if (lower.includes('null') || lower.includes('undefined') || lower.includes('cannot read prop')) return 'null-reference';
  if (lower.includes('type') && (lower.includes('error') || lower.includes('mismatch'))) return 'type-error';
  if (lower.includes('import') || lower.includes('module not found') || lower.includes('cannot find')) return 'import-missing';
  if (lower.includes('config') || lower.includes('env') || lower.includes('environment')) return 'config-error';
  if (lower.includes('test') && (lower.includes('fail') || lower.includes('assert'))) return 'test-failure';
  if (lower.includes('build') || lower.includes('compile') || lower.includes('tsc')) return 'build-error';
  return 'other';
}

// Export for testing
export { inferErrorPattern, lessonSlug };
