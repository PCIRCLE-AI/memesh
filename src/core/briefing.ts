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
// The selection is briefing-pools.ts, the same module the hook runs through
// its generated copy; what must exist exactly once — classification,
// phrasing, the assembly order, the budget, the fence — is imported from the
// single owners below.
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
import { getTaskState, TaskStateUnreadableError } from './task-state-store.js';
import { recipientEverSeen, unreadDeliveryCount, unreadInboxLines } from './agent-message-inbox.js';
import { hostSessionFromEnv } from './host-session.js';
import { canonicalAgentScopeId } from './agent-scope-id.js';
import { briefingTaskStateLines } from './task-state.js';
import { handoffLines } from './session-handoff.js';
import {
  buildBriefingIndex,
  injectedIndexReserve,
  type BriefingIndex,
} from './briefing-index.js';
import type { MemeshDatabase } from '../storage/sqlite.js';
import {
  DEFAULT_TOPOLOGY_BUDGET,
  assembleTopologyBlock,
  boundTaskStateLines,
  buildReferenceContext,
  hasBriefingContent,
  joinedLength,
  jsonStringLiteral,
  projectLabel,
} from './work-topology.js';
import { readIndexCandidates, readSnippets, selectBriefingPools, toTopologyEntity, type PoolRow } from './briefing-pools.js';
import {
  briefingLevelPolicy,
  resolveBriefingLevel,
  type BriefingLevel,
} from './briefing-level.js';

const PROJECT_LIMIT = 30;

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

/**
 * The durable-memory index for one project (#323): project-tagged, active,
 * non-global, durable-typed rows, newest activity first. Every decision
 * about what to show and how lives in briefing-index.ts; this is only the
 * read (briefing-pools.ts), shared with the session-start hook.
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
    taskLines = [`task state for ${jsonStringLiteral(projectLabel(projectName))}: ${err.message}`];
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
  // #497: a message meant for one session of a shared principal counts only
  // in that session; this process's session is the one Claude Code started it in.
  const unreadCount = unreadDeliveryCount(db, canonicalAgentScopeId(projectName), inboxRecipient, hostSessionFromEnv());
  // D8: only worth asking when it can change the answer — a nonzero count
  // already proves the recipient is real, and with no recipient at all
  // `unreadInboxLines` never looks at it.
  const everSeen = inboxRecipient !== undefined && unreadCount === 0
    ? recipientEverSeen(db, canonicalAgentScopeId(projectName), inboxRecipient)
    : undefined;
  // The session handoff leads everything: it is what the last session in this
  // project said it was about to do. Exact project, active, and through the
  // same trust gate as every other memory. Every pool below comes from the
  // one selection the hook also runs.
  const pools = selectBriefingPools(db, projectName, {
    projectLimit: PROJECT_LIMIT,
    global: policy.global,
    foreign: policy.foreign,
  });
  const handoff = pools.handoff ? handoffLines(pools.handoff) : [];

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

  const snippets = readSnippets(db, [...pools.lessons, ...pools.project, ...pools.noProject, ...pools.global, ...pools.recent].map((row) => row.id));
  const toEntities = (pool: PoolRow[]) => pool.map((row) => toTopologyEntity(row, snippets));

  // One memory budget for everything inside the fence; when this level shows
  // the index, room for its heading and "N more" line is kept back first.
  const indexReserve = policy.index ? injectedIndexReserve(projectName) + 2 : 0;
  const lines = assembleTopologyBlock(
    stateLines,
    [
      { entities: toEntities(pools.lessons), foreign: false },
      { entities: toEntities(pools.project), foreign: false },
      { entities: toEntities(pools.noProject), foreign: false, noProject: true },
      { entities: toEntities(pools.global), foreign: false, global: true },
      { entities: toEntities(pools.recent), foreign: true },
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
