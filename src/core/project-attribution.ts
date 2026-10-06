// =============================================================================
// Project attribution — which project does one memory belong to?
// =============================================================================
//
// Pure functions and constants, no imports: the HTTP server (`/v1/projects`,
// `/v1/entities?project=`) and the dashboard bundle all decide a memory's
// project by THIS rule. `/v1/projects` runs these functions; the project list
// behind `?project=` applies the same rule in SQL (`listByProject`,
// knowledge-graph.ts) over the same constants. The dashboard imports this file
// directly, which is why it must stay free of anything node-only.
//
// The project of an entity is encoded two ways, neither enforced by the schema:
//   1) An explicit `project:<name>` tag (the canonical source)
//   2) An implicit prefix in the entity name (e.g. lesson-claude-code-buddy-X
//      where "claude-code-buddy" is the project)

/** The tag prefix that names a memory's project. */
export const PROJECT_TAG_PREFIX = 'project:';

/** A project read out of a lesson's name must be at least this long. */
export const MIN_NAME_PROJECT_LENGTH = 2;

/**
 * The fixed set of error patterns `inferErrorPattern` (lesson-engine.ts) can
 * return. Lives here so the name heuristic below anchors on the same set
 * instead of duplicating the strings — preventing silent drift if a new
 * pattern is added.
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

/**
 * Heuristic: extract a project hint from an entity name like
 * "lesson-claude-code-buddy-config-error" → "claude-code-buddy".
 * Returns null when the name has no recognisable prefix.
 *
 * The lesson naming convention emitted by `lesson-engine.ts createLesson` is
 * `lesson-{project}-{errorPattern}` where `errorPattern` is itself one of a
 * fixed set produced by `inferErrorPattern()`. Several of those patterns
 * contain a dash (`config-error`, `import-missing`, `null-reference`,
 * `test-failure`, `build-error`), so the previous "split on the last dash"
 * approach was wrong — for `lesson-claude-code-buddy-config-error` it
 * yielded `claude-code-buddy-config` instead of `claude-code-buddy`.
 *
 * Fix: anchor on the fixed pattern set. Match the trailing slug against
 * `KNOWN_ERROR_PATTERNS` and treat everything before it as the project. We
 * intentionally restrict the heuristic to `lesson-` only — other prefixes
 * (`plan-`, `decision-`, etc.) have no fixed naming convention and the old
 * heuristic produced more wrong answers than right ones.
 */
export function extractProjectFromName(name: string): string | null {
  if (!name.startsWith('lesson-')) return null;
  const rest = name.slice('lesson-'.length);
  // Try each known pattern as the trailing slug.
  for (const pattern of KNOWN_ERROR_PATTERNS) {
    const suffix = `-${pattern}`;
    if (rest.endsWith(suffix)) {
      const project = rest.slice(0, rest.length - suffix.length);
      if (project.length >= MIN_NAME_PROJECT_LENGTH) return project;
    }
  }
  return null;
}

/** Pull the project name out of a single entity's tags + name. */
export function extractProjectFromEntity(
  tags: string[] | null | undefined,
  name: string,
): { project: string | null; source: 'tag' | 'heuristic' | null } {
  if (tags) {
    const tagged = tags.find((t) => t.startsWith(PROJECT_TAG_PREFIX));
    if (tagged) return { project: tagged.slice(PROJECT_TAG_PREFIX.length), source: 'tag' };
  }
  const fromName = extractProjectFromName(name);
  if (fromName) return { project: fromName, source: 'heuristic' };
  return { project: null, source: null };
}
