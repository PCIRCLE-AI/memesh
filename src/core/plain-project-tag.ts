import { projectLabel } from './work-topology.js';

/** A `project:` tag rewritten from a repository's plain name to its id. */
export interface ProjectRetag {
  from: string;
  to: string;
}

/**
 * #511: a `project:<name>` tag that names the caller's repository by its plain
 * name, when the repository's project id is `<name>~<hash>`. Stored as
 * written, the memory sits under a separate project that no briefing for the
 * repository reads. Returns the tags with that one tag replaced by the full
 * id, and what was replaced. Any other tag, including a plain tag naming a
 * different project, is left as written.
 */
export function withFullProjectTag(
  tags: readonly string[] | undefined,
  projectId: string | undefined,
): { tags: string[] | undefined; retagged?: ProjectRetag } {
  if (tags === undefined) return { tags: undefined };
  if (projectId === undefined) return { tags: [...tags] };
  const label = projectLabel(projectId);
  if (label === projectId) return { tags: [...tags] };
  const plain = `project:${label}`;
  if (!tags.includes(plain)) return { tags: [...tags] };
  const full = `project:${projectId}`;
  return { tags: [...new Set(tags.map((tag) => (tag === plain ? full : tag)))], retagged: { from: plain, to: full } };
}
