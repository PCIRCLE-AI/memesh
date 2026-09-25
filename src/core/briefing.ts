// =============================================================================
// briefing — the assembled work topology, for agents that do not run the hooks
// =============================================================================
//
// Claude Code gets the topology pushed at session start by
// `scripts/hooks/session-start.js`. Every other MCP client — Gemini, Codex,
// anything that speaks the protocol — runs no hooks, so until this existed
// they could reach the PARTS (recall, task_state) but never the assembled
// block. "Cross-vendor gets the assembled topology, not the parts" is A1c's
// acceptance criterion, verbatim.
//
// This deliberately does NOT share selection SQL with the hook. That is the
// A1a design decision, restated in work-topology.ts's header: each consumer
// owns its own database access with its own compat rules; what must exist
// exactly once — classification, phrasing, the assembly order, the budget,
// the fence — is imported from the single owners below.
//
// The selection is a LEAN read on purpose. The first version went through
// `kg.search`/`kg.listRecent`, which hydrate observations, tags and relations
// for every candidate (up to 2×400 rows to render ~35 lines) and bump
// `access_count` on all of them — recall's machinery, sized for limit≈20 and
// for callers that asked. A briefing is not an ask for 800 memories: it reads
// scalar columns for the window, ranks, gates, and fetches ONE snippet per
// survivor — the same shape the hook uses. It also tracks no access: the
// hook's injection never has, and a ranking signal that means "was shown
// unasked" would inflate frequency for whatever happened to be in the window.

import { getDatabase } from '../db.js';
import { getProjectName } from './paths.js';
import { readConfig } from './config.js';
import { readRepoState, repoStateLines } from './repo-state.js';
import { rankEntities } from './scoring.js';
import { getTaskState, TaskStateUnreadableError } from './task-state-store.js';
import { recipientEverSeen, unreadDeliveryCount, unreadInboxLines } from './agent-message-inbox.js';
import { canonicalAgentScopeId } from './agent-scope-id.js';
import { briefingTaskStateLines } from './task-state.js';
import { handoffLines, SESSION_HANDOFF_TYPE, sessionHandoffName } from './session-handoff.js';
import {
  INDEX_CANDIDATE_CAP,
  INDEX_EXCLUDED_TYPES,
  INDEX_SNIPPET_FETCH_CHARS,
  buildBriefingIndex,
  injectedIndexReserve,
  type BriefingIndex,
  type IndexCandidate,
} from './briefing-index.js';
import type { MemeshDatabase } from '../storage/sqlite.js';
import {
  DECISION_LAYER_TYPES,
  DEFAULT_TOPOLOGY_BUDGET,
  GLOBAL_TOPOLOGY_LIMIT,
  LESSON_TYPE_LIST,
  SNIPPET_FETCH_CHARS,
  TOPOLOGY_CANDIDATE_CAP,
  assembleTopologyBlock,
  boundTaskStateLines,
  buildReferenceContext,
  hasBriefingContent,
  isAutoInjectable,
  joinedLength,
  prioritizeDecisions,
  projectLabel,
  type TopologyEntity,
} from './work-topology.js';
import {
  briefingLevelPolicy,
  resolveBriefingLevel,
  type BriefingLevel,
} from './briefing-level.js';

const PROJECT_LIMIT = 30;
const RECENT_LIMIT = 5;
const LESSON_LIMIT = 5;

export interface BriefingResult {
  project: string;
  /** The fenced, injection-ready block — identical framing to the hook's. */
  text: string;
  /** How many memories were rendered into the block (excluding the task state). */
  entityCount: number;
  /** Whether a task-state line leads the block: the fresh state, the one-line
   *  stale flag, or the unreadable-record line. The unread-message reminder
   *  that rides beside them is not a task state and does not count — a briefing
   *  whose only state line is that reminder has `hasTaskState: false`. At
   *  `minimal` a FRESH state is not rendered at all, so it is `false` there. */
  hasTaskState: boolean;
  /** Whether the block leads with the session handoff: where the last session
   *  in this project left off. Shown at every level while it is under
   *  HANDOFF_MAX_AGE_DAYS old. Not counted in `entityCount`. */
  hasHandoff: boolean;
  /** The durable-memory index (#323) — counts, cost and the rendered lines,
   *  computed regardless of level (the `--index` CLI flag and callers that
   *  want the index on its own read this even when `level` excludes it from
   *  `text`). Always present: an empty project renders the empty-state line
   *  rather than nothing. */
  index: BriefingIndex;
  /** #360 — the resolved level this result was assembled at. */
  level: BriefingLevel;
  /** #360: true when there was NOTHING to show at this
   *  level — `text` is `''` in that case, not a preamble wrapped around an
   *  empty fence. Callers that render for a human (the CLI) must check this
   *  and print a short line instead of `text`; callers that just forward
   *  the object (MCP) do not need to — `empty: true, text: ''` already says
   *  the same thing machine-readably. Can only be true at `minimal`: at
   *  `standard`/`full` the durable-memory index always contributes at
   *  least its own empty-state line (#323). */
  empty: boolean;
}

interface CandidateRow {
  id: number;
  name: string;
  type: string | null;
  title: string | null;
  metadata: string | null;
  access_count: number | null;
  last_accessed_at: string | null;
  confidence: number | null;
  recall_hits: number | null;
  recall_misses: number | null;
  /** Decision-layer rows only: latest valid activity (see RECENCY_SQL). */
  recency?: string | null;
}

const CANDIDATE_COLUMNS =
  'e.id, e.name, e.type, e.title, e.metadata, e.access_count, e.last_accessed_at, e.confidence, e.recall_hits, e.recall_misses';

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Rank a candidate window with core's own scoring, gate it, and cap it.
 * Wide fetch BEFORE the gate — the starvation bug this repo measured was a
 * top-N cut applied before a filter, letting one blocked class consume the
 * whole window.
 */
interface PoolRow {
  id: number;
  name: string;
  type: string | null;
  title: string | null;
  meta: Record<string, unknown> | null;
  /** The auto-injection gate, decided on the RAW column: an unreadable
   *  column is refused, not read as absent (the hook's isTrustedForAutoContext). */
  autoInjectable: boolean;
  access_count?: number;
  last_accessed_at?: string;
  confidence?: number;
  recall_hits?: number;
  recall_misses?: number;
  recency?: string | null;
}

/**
 * A decision's latest VALID activity, as canonical SQLite UTC text: its newest
 * observation, else its creation. A timestamp counts only if it round-trips
 * through strftime unchanged (the same rule as time-utils' parseSqliteUtcMs:
 * 'YYYY-MM-DD HH:MM:SS' or with a 'T', no zone suffix, a real calendar date)
 * and is not more than 5 minutes in the future — so an impossible or future
 * date can never make a decision look newest. NULL = unknown, sorted last.
 * session-start.js carries the same expression (a hook cannot import this).
 */
const RECENCY_SQL = `COALESCE(
  (SELECT MAX(replace(o.created_at, 'T', ' ')) FROM observations o
    WHERE o.entity_id = e.id
      AND replace(o.created_at, 'T', ' ') = strftime('%Y-%m-%d %H:%M:%S', o.created_at)
      AND replace(o.created_at, 'T', ' ') <= strftime('%Y-%m-%d %H:%M:%S', 'now', '+5 minutes')),
  CASE WHEN replace(e.created_at, 'T', ' ') = strftime('%Y-%m-%d %H:%M:%S', e.created_at)
        AND replace(e.created_at, 'T', ' ') <= strftime('%Y-%m-%d %H:%M:%S', 'now', '+5 minutes')
       THEN replace(e.created_at, 'T', ' ') END)`;

function toPoolRow(row: CandidateRow): PoolRow {
  const meta = parseMetadata(row.metadata);
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    title: row.title,
    meta,
    autoInjectable: (row.metadata == null || meta !== null) && isAutoInjectable(meta),
    // SQLite hands back null for absent scalars; rankEntities' generic wants
    // them undefined. Same values, one shape.
    access_count: row.access_count ?? undefined,
    last_accessed_at: row.last_accessed_at ?? undefined,
    confidence: row.confidence ?? undefined,
    recall_hits: row.recall_hits ?? undefined,
    recall_misses: row.recall_misses ?? undefined,
    recency: row.recency ?? null,
  };
}

function selectPool(rows: CandidateRow[], cap: number): PoolRow[] {
  const withMeta: PoolRow[] = rows.map(toPoolRow);
  return rankEntities(withMeta, new Map())
    .filter((row) => row.autoInjectable)
    .slice(0, cap);
}

function toTopologyEntity(row: PoolRow, snippet: string | null): TopologyEntity {
  const signal = row.meta?.signal_score;
  return {
    name: row.name,
    type: row.type || 'memory',
    // The citation handle: briefing lines carry the same `[mem:<id>]` ref
    // the session-start injection prints, so a memory reads the same way on
    // every surface an agent meets it.
    id: row.id,
    title: row.title,
    snippet,
    signalScore: typeof signal === 'number' ? signal : null,
    recency: row.recency ?? null,
  };
}

/**
 * The durable-memory index for one project (#323): project-tagged, active,
 * non-global, durable-typed rows, newest activity first. Every decision
 * about what to show and how lives in briefing-index.ts; this is only the
 * read. The session-start hook issues the same query against its own handle
 * (A1a: each consumer owns its SQL) — the parity test in briefing.test.ts
 * holds the two together.
 *
 * Team-namespace rows are included exactly as the ranked project pool
 * includes them: only `global` is excluded, and only rows carrying this
 * project's tag are read, so the index is never cross-project.
 */
export function readBriefingIndex(
  db: MemeshDatabase,
  projectName: string,
  now: number = Date.now(),
): BriefingIndex {
  const { candidates, truncated } = readIndexCandidates(db, projectName);
  return buildBriefingIndex(candidates, projectName, now, { truncated });
}

function readIndexCandidates(
  db: MemeshDatabase,
  projectName: string,
): { candidates: IndexCandidate[]; truncated: boolean } {
  const hasNamespace = (db.prepare('PRAGMA table_info(entities)').all() as Array<{ name: string }>)
    .some((column) => column.name === 'namespace');
  const nonGlobal = hasNamespace ? " AND (e.namespace IS NULL OR e.namespace <> 'global')" : '';
  const excluded = INDEX_EXCLUDED_TYPES.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT e.id, e.type, e.title, e.metadata,
       (SELECT substr(o.content, 1, ${INDEX_SNIPPET_FETCH_CHARS}) FROM observations o
         WHERE o.entity_id = e.id ORDER BY o.id ASC LIMIT 1) AS snippet,
       max(e.created_at, COALESCE((SELECT MAX(o2.created_at) FROM observations o2
         WHERE o2.entity_id = e.id), e.created_at)) AS last_activity
     FROM entities e
     WHERE e.id IN (SELECT entity_id FROM tags WHERE tag = ?)
       AND e.status = 'active'${nonGlobal}
       AND e.type NOT IN (${excluded})
     ORDER BY last_activity DESC, e.id DESC
     LIMIT ?`,
  ).all(`project:${projectName}`, ...INDEX_EXCLUDED_TYPES, INDEX_CANDIDATE_CAP) as Array<{
    id: number; type: string | null; title: string | null; metadata: string | null;
    snippet: string | null; last_activity: string | null;
  }>;
  const candidates: IndexCandidate[] = rows.map((row) => ({
    id: row.id,
    type: row.type,
    title: row.title,
    snippet: row.snippet,
    lastActivity: row.last_activity,
    // The RAW column, not a parsed object: the index's gate has to tell an
    // absent metadata column (allowed) from one holding unparseable JSON
    // (refused), and parsing here would collapse both to null.
    metadata: row.metadata,
  }));
  return { candidates, truncated: rows.length >= INDEX_CANDIDATE_CAP };
}

/**
 * Assemble the same block session-start injects, for a caller that has no
 * session-start: task state first (the one line someone stated on purpose),
 * then the ranked topology, wrapped in the shared fence.
 */
export function assembleBriefing(project?: string, recipient?: string): BriefingResult {
  const projectName = project ?? getProjectName();
  const db = getDatabase();

  // #360 — env > config > default('minimal'), the same precedence
  // `resolveSessionLimit` uses for the hook. No `--level` parameter exists
  // (or is needed) on this function: `assembleBriefing` has exactly one
  // caller-visible knob for this, the `briefing` config key, so the CLI and
  // the MCP tool cannot be told two different levels for the same project. An
  // unknown env/config value is not a silent fallback — it is traced, the
  // same discipline the SessionStart hook applies via its outcome record
  // (this module has no equivalent JSONL channel, so stderr is the honest
  // substitute; a CLI/MCP process never mixes stderr into its stdout JSON).
  const resolvedLevel = resolveBriefingLevel(process.env.MEMESH_BRIEFING, readConfig().briefing);
  if (resolvedLevel.invalid) {
    const { source, value } = resolvedLevel.invalid;
    try {
      process.stderr.write(
        `[memesh briefing] invalid ${source} briefing level ${value} — using "${resolvedLevel.level}"\n`,
      );
    } catch { /* stderr gone */ }
  }
  const level = resolvedLevel.level;
  const policy = briefingLevelPolicy(level);
  // `policy.workPackageNotice` is deliberately never read here — see its
  // field comment in briefing-level.ts. This function's result is the
  // MEMORY block only; the notice is a SessionStart-hook-only host-agent
  // instruction, appended by `session-start.js`, never by this function —
  // enforced by the parity tests in tests/core/briefing.test.ts.

  // Derived first, stated second, and in that order on purpose. Both blocks
  // used to be one: the stated goal was injected under a heading that read as
  // the project's status, and nothing else in the briefing said where the work
  // actually was. Facts read from git on the way out cannot be stale; a
  // recorded intention always can be, so it follows the facts rather than
  // standing in for them.
  // Only when the process is actually standing in that project. `project` is
  // a NAME, not a path, so `process.cwd()` is the right repository for a CLI
  // run and can be an entirely different one over MCP, where the server's cwd
  // has nothing to do with the project being asked about. Reporting this
  // repository's branch under another project's heading would be a new way of
  // saying something false, which is the thing this module exists to stop.
  const repoLines = (project === undefined || project === getProjectName())
    ? repoStateLines(readRepoState())
    : [];

  // The one stated line, before anything ranked — same reasoning as the
  // hook: ranking cannot know what you meant to do next.
  // A corrupted record must not cost the agent the rest of the briefing:
  // it becomes one line that says the record is unreadable and how to
  // replace it, in the slot the stated lines would have taken.
  let taskLines: string[];
  try {
    // #360: briefingTaskStateLines downgrades a stale record to one line
    // (at every level) and, when fresh, honours the level's own
    // taskState flag — `minimal` omits it entirely.
    taskLines = boundTaskStateLines(briefingTaskStateLines(getTaskState(projectName).state, projectName, new Date(), {
      includeFresh: policy.taskState,
    }));
  } catch (err) {
    if (!(err instanceof TaskStateUnreadableError)) throw err;
    taskLines = [`task state for ${projectLabel(projectName)}: ${err.message}`];
  }
  const inboxRecipient = recipient === undefined ? undefined : canonicalAgentScopeId(recipient);
  // The inbox line rides WITH the stated lines, not among the ranked
  // memories: like goal / next / blocked it is a fact the agent must act
  // on, not a memory that scored well. It is only actionable when the caller
  // supplies the exact logical recipient; generic briefing has no identity
  // and must not aggregate another recipient's activity.
  // The inbox is keyed on (project, recipient) in the canonical form
  // core/agent-scope-id.ts defines — that is how `send` stores it and how
  // `poll` reads it back. Counting must ask in the same spelling, or a
  // caller whose name differs only by Unicode composition is told its inbox
  // is empty while `poll` returns messages: the split this change closes,
  // reappearing on the surface an agent actually reads. The project tag
  // lookups below deliberately keep `projectName` as given — those are
  // entity tags, written by a different path, not this key.
  const unreadCount = unreadDeliveryCount(db, canonicalAgentScopeId(projectName), inboxRecipient);
  // D8: only worth asking when it can change the answer — a nonzero count
  // already proves the recipient is real, and with no recipient at all
  // `unreadInboxLines` never looks at it.
  const everSeen = inboxRecipient !== undefined && unreadCount === 0
    ? recipientEverSeen(db, canonicalAgentScopeId(projectName), inboxRecipient)
    : undefined;
  // The session handoff leads everything: it is what the last session in this
  // project said it was about to do. Exact project, active, and through the
  // same trust gate as every other memory — except that metadata nobody can
  // parse keeps it out (the ranked pool below lets such a row through).
  const handoffRow = db.prepare(
    `SELECT e.id, e.metadata, o.content AS text, o.created_at AS observedAt
     FROM entities e JOIN observations o ON o.entity_id = e.id
     WHERE e.name = ? AND e.type = ? AND e.status = 'active'
     ORDER BY o.id DESC
     LIMIT 1`,
  ).get(sessionHandoffName(projectName), SESSION_HANDOFF_TYPE) as
    { id: number; metadata: string | null; text: string; observedAt: string } | undefined;
  const handoffMeta = handoffRow ? parseMetadata(handoffRow.metadata) : null;
  const handoffTrusted = !!handoffRow && (handoffRow.metadata === null || handoffMeta !== null) && isAutoInjectable(handoffMeta);
  const handoff = handoffTrusted ? handoffLines(handoffRow) : [];

  const stateLines = [
    ...handoff,
    ...taskLines,
    ...unreadInboxLines(
      unreadCount,
      canonicalAgentScopeId(projectName),
      inboxRecipient,
      everSeen,
    ),
  ];

  // A database from before namespaces cannot hold global rows. Preserve the
  // previous project/recent behaviour instead of making briefing fail to open.
  const hasNamespace = (db.prepare('PRAGMA table_info(entities)').all() as Array<{ name: string }>)
    .some((column) => column.name === 'namespace');
  const nonGlobal = hasNamespace ? " AND (e.namespace IS NULL OR e.namespace <> 'global')" : '';

  const projectRows = db.prepare(
    `SELECT DISTINCT ${CANDIDATE_COLUMNS}
     FROM entities e JOIN tags t ON t.entity_id = e.id
     WHERE t.tag = ? AND e.status = 'active' AND e.type <> ?${nonGlobal}
     ORDER BY e.id DESC
     LIMIT ?`,
  ).all(`project:${projectName}`, SESSION_HANDOFF_TYPE, TOPOLOGY_CANDIDATE_CAP) as unknown as CandidateRow[];
  // Decisions first (#434 step 3): the project's newest trusted decision-layer
  // rows take slots before the score-ordered candidates fill the rest, so a
  // burst of commits can neither push them out of the candidate window nor
  // out of the project's slots. Same cap as before; no per-type limit.
  const decisionRows = db.prepare(
    `SELECT DISTINCT ${CANDIDATE_COLUMNS}, ${RECENCY_SQL} AS recency
     FROM entities e JOIN tags t ON t.entity_id = e.id
     WHERE t.tag = ? AND e.status = 'active' AND e.type IN (${DECISION_LAYER_TYPES.map(() => '?').join(',')})${nonGlobal}
     ORDER BY recency IS NULL, recency DESC, e.id DESC
     LIMIT ?`,
  ).all(`project:${projectName}`, ...DECISION_LAYER_TYPES, TOPOLOGY_CANDIDATE_CAP) as unknown as CandidateRow[];
  const decisionPool = decisionRows.map(toPoolRow).filter((row) => row.autoInjectable);
  const projectPool = prioritizeDecisions(decisionPool, selectPool(projectRows, TOPOLOGY_CANDIDATE_CAP), PROJECT_LIMIT);
  // The project's lessons: the same separate pool the SessionStart hook
  // claims first (newest 50, trust gate, top 5), so a project whose slots are
  // all taken by decisions still shows its lessons on both surfaces.
  const lessonPool = (db.prepare(
    `SELECT DISTINCT ${CANDIDATE_COLUMNS}
     FROM entities e JOIN tags t ON t.entity_id = e.id
     WHERE e.type IN (${LESSON_TYPE_LIST.map(() => '?').join(', ')}) AND e.status = 'active'${nonGlobal} AND t.tag = ?
     ORDER BY e.id DESC
     LIMIT 50`,
  ).all(...LESSON_TYPE_LIST, `project:${projectName}`) as unknown as CandidateRow[])
    .map(toPoolRow).filter((row) => row.autoInjectable).slice(0, LESSON_LIMIT);

  // `global` is an explicit storage scope, not a project tag. It gets a
  // bounded pool, and the shared assembler gives it what the project leaves of
  // the one budget, capped at its old size. Keeping it out of the project and recent queries below
  // makes this the only selection path, so a tagged global row cannot appear
  // twice and overflow globals cannot sneak back through recency.
  //
  // #360: `minimal`/`standard` skip this query outright rather than fetch
  // and then not render it — the whole reason for the level is to stop
  // paying for what is not the current project.
  const globalRows: CandidateRow[] = policy.global && hasNamespace
    ? db.prepare(
      `SELECT ${CANDIDATE_COLUMNS}
       FROM entities e
       WHERE e.namespace = 'global' AND e.status = 'active'
       ORDER BY e.id DESC
       LIMIT ?`,
    ).all(TOPOLOGY_CANDIDATE_CAP) as unknown as CandidateRow[]
    : [];
  const globalPool = selectPool(globalRows, GLOBAL_TOPOLOGY_LIMIT);

  // Recent pool: newest activity across ALL projects. Anything only here is
  // from elsewhere and must say so — the assembler files rows from a foreign
  // pool under a heading that does not claim this project. Skipped at
  // `minimal`/`standard` for the same reason as the global pool above.
  const recentRows: CandidateRow[] = policy.foreign
    ? db.prepare(
      `SELECT ${CANDIDATE_COLUMNS}
       FROM entities e
       WHERE e.status = 'active' AND e.type <> ?${nonGlobal}
       ORDER BY e.id DESC
       LIMIT ?`,
    ).all(SESSION_HANDOFF_TYPE, TOPOLOGY_CANDIDATE_CAP) as unknown as CandidateRow[]
    : [];
  const recentPool = selectPool(recentRows, RECENT_LIMIT);

  // One snippet per survivor, one query — first observation per entity,
  // fetched a few line-widths long so clip() can still cut on a word
  // boundary. This is the survivors-only hydration the hook already uses.
  const survivorIds = [...new Set([...lessonPool, ...projectPool, ...globalPool, ...recentPool].map((row) => row.id))];
  const snippets = new Map<number, string>();
  if (survivorIds.length > 0) {
    const placeholders = survivorIds.map(() => '?').join(',');
    const obsRows = db.prepare(
      `SELECT entity_id, substr(content, 1, ${SNIPPET_FETCH_CHARS}) AS content
       FROM observations WHERE entity_id IN (${placeholders})
       ORDER BY id ASC`,
    ).all(...survivorIds) as Array<{ entity_id: number; content: string | null }>;
    for (const row of obsRows) {
      if (snippets.has(row.entity_id)) continue;
      const text = String(row.content ?? '').trim();
      if (text) snippets.set(row.entity_id, text);
    }
  }

  const toEntities = (pool: PoolRow[]) =>
    pool.map((row) => toTopologyEntity(row, snippets.get(row.id) ?? null));

  // One memory budget for everything inside the fence; when this level shows
  // the index, room for its heading and "N more" line is kept back first.
  const indexReserve = policy.index ? injectedIndexReserve(projectName) + 2 : 0;
  const lines = assembleTopologyBlock(
    stateLines,
    [
      { entities: toEntities(lessonPool), foreign: false },
      { entities: toEntities(projectPool), foreign: false },
      { entities: toEntities(globalPool), foreign: false, global: true },
      { entities: toEntities(recentPool), foreign: true },
    ],
    projectName,
    DEFAULT_TOPOLOGY_BUDGET,
    { reserve: indexReserve },
  );

  // Repository facts PREFIX a briefing; they never constitute one. Prepending
  // them unconditionally made "nothing to say" impossible — every call inside
  // a git repository returned a fenced block whose entire content was a branch
  // name, which is the one thing the agent can already see. So the emptiness
  // test comes first and the facts are context for memories, not a substitute.
  const withRepo = lines.length > 0 && repoLines.length > 0
    ? [...repoLines, '', ...lines]
    : lines;

  // The index closes the block, after the ranked sections, and is always
  // there — including for a project with nothing ranked, where it is the
  // honest empty state (#323). Repository facts still prefix only a block
  // that has ranked memories: the index's empty-state line is not a reason
  // to tell the agent its own branch name.
  //
  // #360: computed at every level regardless — `result.index` is a
  // documented, always-present field (other callers, e.g. the CLI's
  // `--index` flag, read it on its own) — but its lines only enter the
  // INJECTED block when the level includes it.
  const now = Date.now();
  const { candidates: indexCandidates, truncated } = readIndexCandidates(db, projectName);
  const index = buildBriefingIndex(indexCandidates, projectName, now, { truncated });
  // The injected index gets what the block left of the shared budget; the
  // standalone `index` above keeps its own caps (`memesh briefing --index`).
  const used = lines.length === 0 ? 0 : joinedLength(lines) + 2;
  const indexLines = policy.index
    ? buildBriefingIndex(indexCandidates, projectName, now, { truncated, maxChars: DEFAULT_TOPOLOGY_BUDGET.maxChars - used }).lines
    : [];
  const block = withRepo.length > 0 && indexLines.length > 0
    ? [...withRepo, '', ...indexLines]
    : [...withRepo, ...indexLines];

  // #360: `block` can be genuinely empty — `minimal` on a
  // project with nothing yet: no ranked topology, no repo-state prefix
  // (repo lines only prepend onto EXISTING topology lines, unchanged from
  // before #360), and `indexLines` itself empty because `minimal` excludes
  // the index entirely (`policy.index === false`). Wrapping nothing in the
  // preamble + an empty fence is not "nothing" — `hasBriefingContent` is
  // the SAME rule the hook applies to its own assembled lines (see
  // session-start.js's `memoryContext` construction), so the two cannot
  // drift on what "nothing to show" means, even though neither can call
  // the other's code (A1a).
  const empty = !hasBriefingContent(block);

  return {
    project: projectName,
    text: empty ? '' : buildReferenceContext(block),
    // Counted from the ranked lines only — the index's lines carry the same
    // `- [type] … [mem:id]` shape and are reported under `index` instead.
    // The ranked lines only: the state lines lead the block, and the
    // handoff's text there can itself contain lines that look like `- [`.
    entityCount: lines.slice(stateLines.length).filter((l) => l.startsWith('- [')).length,
    // `taskLines`, not `stateLines`: the latter also carries the unread-inbox
    // reminder, which is not a task state.
    hasTaskState: taskLines.length > 0,
    hasHandoff: handoff.length > 0,
    index,
    level,
    empty,
  };
}
