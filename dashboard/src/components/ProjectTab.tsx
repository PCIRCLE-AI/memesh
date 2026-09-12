import { Fragment } from 'preact';
import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import { api, fetchBriefingIndex, fetchProjects, fetchTaskState, type BriefingIndexData, type Entity, type HealthData, type ProjectInfo, type TaskStateData } from '../lib/api';
import { ProjectRoadmap } from './ProjectRoadmap';
import { EmptyLibraryState } from './EmptyLibraryState';
import { Chip } from './Chip';
import { t } from '../lib/i18n';
import { classifyLoadError, failureMessage } from '../lib/failure';
import { extractProject, relativeDate } from '../lib/entity-display';
import { TerminalHandoff } from './ExternalHandoff';

const FETCH_LIMIT = 2000;

/** `?project=` deep-link read. Unvalidated on purpose: a stale name renders
 *  the roadmap's own honest empty state, and the chip row is still there to
 *  recover with — better than silently ignoring the link. */
function urlProject(): string | null {
  try { return new URLSearchParams(window.location.search).get('project'); } catch { return null; }
}

function writeUrlProject(name: string): void {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('project', name);
    history.replaceState(null, '', url);
  } catch { /* private mode / no history — the view still works */ }
}

/**
 * The roadmap's entity set for one project: active entities of the project,
 * PLUS the archived entities OF THAT SAME PROJECT an active one points at
 * with a lineage edge.
 * `supersedes` ARCHIVES its target on write (operations.ts), so a plain
 * active filter hides exactly the node every supersession edge points at —
 * the roadmap could never show a chain. The fetch already carries archived
 * rows (status=all); general archived noise stays out. Exported for the
 * unit test — the readmission rule is the load-bearing part of this tab.
 */
export function selectProjectEntities(entities: Entity[], selected: string | null): Entity[] {
  if (!selected) return [];
  const isArchived = (e: Entity) => Boolean(e.archived) || e.status === 'archived';
  const active = entities.filter((e) => !isArchived(e) && extractProject(e) === selected);
  const referenced = new Set<string>();
  for (const e of active) {
    for (const r of e.relations ?? []) {
      if (r.type === 'supersedes' || r.type === 'contradicts') referenced.add(r.to);
    }
  }
  // Readmission matched on NAME alone, with no project predicate — so an
  // archived entity belonging to a DIFFERENT project rode in on this
  // project's chain edge, and the three surfaces fed from this array (the
  // roadmap, the capture-density band and the Decisions list) counted it as
  // part of this project's story. The active side has always filtered on the
  // project; this side has to agree, or the tab silently absorbs work that
  // was never here. The legitimate case is untouched: archiving flips
  // `status` and nothing else (knowledge-graph.ts `archiveEntity`), so a
  // chain target inside this project keeps its `project:` tag and still rides
  // back in.
  const readmitted = entities.filter(
    (e) => isArchived(e) && referenced.has(e.name) && extractProject(e) === selected,
  );
  return [...active, ...readmitted].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/**
 * The Project tab — a thin host for ProjectRoadmap, which is 100%
 * parent-fed (it fetches nothing itself). This tab owns the fetch, the
 * project selector and the `?project=` deep link. No `memesh:data-changed`
 * dispatch here: this surface is read-only, and the event exists to sync
 * the header after mutations.
 */
/**
 * What the owner said about a project — goal, next, blocked, done — exactly
 * as `memesh task` recorded it. Nothing here is derived: an absent field is
 * "not stated", the timestamp is the owner's last statement, and the
 * provenance line says so. The retrospective history below it is the other
 * source, and the two are kept visibly apart (#237).
 */
const TASK_STATE_FIELDS = ['goal', 'next', 'blocked', 'done'] as const;

export function TaskStateCard({ data, error }: { data: TaskStateData | null; error: string }) {
  if (error) return <div class="card"><div class="error-box" role="alert">{error}</div></div>;
  if (!data) return <div class="card"><Loading /></div>;
  const present = TASK_STATE_FIELDS.filter((f) => typeof data.state[f] === 'string' && data.state[f]!.trim().length > 0);
  return (
    <section class="card" aria-labelledby="task-state-title">
      <h3 id="task-state-title" style={{ margin: '0 0 8px', fontSize: 15 }}>{t('project.taskState.title')}</h3>
      {present.length === 0
        ? <p style={{ margin: 0, color: 'var(--text-2)' }}>{t('project.taskState.empty')}</p>
        : (
          <>
            <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 16px', margin: 0 }}>
              {present.map((f) => (
                <Fragment key={f}>
                  <dt style={{ color: f === 'blocked' ? 'var(--amber)' : 'var(--text-3)', fontSize: 14 }}>{t(`project.taskState.${f}`)}</dt>
                  <dd style={{ margin: 0, color: 'var(--text-1)' }}>{data.state[f]}</dd>
                </Fragment>
              ))}
            </dl>
            <p style={{ margin: '10px 0 0', fontSize: 14, color: 'var(--text-3)' }}>
              {data.state.updated_at ? `${t('project.taskState.updated', { when: relativeDate(data.state.updated_at) })} · ` : ''}
              {t('project.taskState.provenance')}
            </p>
          </>
        )}
    </section>
  );
}

/** A rendered memory line, told apart from the heading, trailers and footer
 *  by the `[mem:id]` handle it ends with. Both halves are read: the text is
 *  memory content (`--font-memory`), the handle is an id the user compares
 *  digit by digit (`--mono`) — DESIGN.md "Type — three voices". */
const MEM_LINE = /^(.*?)(\s\[mem:\d{1,10}\])$/;

/**
 * A translated sentence that carries a command or a count, rendered so the
 * marked-off part gets `--mono` instead of showing its backticks.
 *
 * The catalogue marks those parts with backticks; a plain `<p>` printed them
 * literally, because this dashboard has no markdown renderer and is not
 * getting one. Everything a backtick can mark here — a `memesh …` command, a
 * token count, a byte count — is `--mono` under the same DESIGN.md rule, so
 * one split covers both, in every locale, without each locale having to be
 * re-punctuated.
 */
function monoMarked(text: string) {
  return text.split('`').map((part, i) => (
    i % 2 === 1
      ? <code key={i} style={{ fontFamily: 'var(--mono)', fontSize: 14 }}>{part}</code>
      : <Fragment key={i}>{part}</Fragment>
  ));
}

/** A spinner announces nothing to a screen reader on its own; the live region
 *  needs words in it. */
function Loading() {
  return <div class="loading" role="status" aria-label={t('common.loading')} />;
}

/**
 * What is known here (#323) — the durable-memory index an agent receives at
 * session start, shown as the agent gets it: one line per decision, lesson,
 * pattern or reference, newest first, under the same frozen cap. The memory
 * lines come from the server's renderer verbatim; only the framing around
 * them (heading, overflow, staleness, cost) is translated here.
 */
export function BriefingIndexCard({ data, error }: { data: BriefingIndexData | null; error: string }) {
  if (error) return <div class="card" style={{ marginTop: 12 }}><div class="error-box" role="alert">{error}</div></div>;
  if (!data) return <div class="card" style={{ marginTop: 12 }}><Loading /></div>;
  const parsed = data.lines.map((line) => MEM_LINE.exec(line)).filter((m): m is RegExpExecArray => m !== null);
  // `shown` is the server's own count of the memory lines it rendered; the
  // regex above only recovers them from the prose. The renderer is shared
  // code (`topologyLine`), so a format change makes this side silently show
  // fewer rows — or fall back to "nothing here" — while `shown` stays right,
  // and a false claim of absence is exactly what this card must never make.
  // Disagreement means this bundle cannot read that payload: say so.
  if (parsed.length !== data.shown) {
    console.warn('[memesh dashboard] /v1/briefing-index rendered', data.shown, 'memory lines but this bundle recognised', parsed.length);
    return <div class="card" style={{ marginTop: 12 }}><div class="error-box" role="alert">{failureMessage('unreadable')}</div></div>;
  }
  const plus = data.truncated ? '+' : '';
  return (
    <section class="card" style={{ marginTop: 12 }} aria-labelledby="briefing-index-title">
      <h3 id="briefing-index-title" style={{ margin: '0 0 8px', fontSize: 15 }}>{t('project.index.title')}</h3>
      {/* `shown` alone, not `shown === 0 && older === 0`: a project whose
          memories are ALL stale returns `shown: 0, older: n`, and the pair
          test sent that case into the list branch — an empty `<ul>` under the
          heading, the exact "heading above nothing" shape this card is being
          fixed for. Nothing is listed, so the honest sentence belongs here;
          the `older` line below still says how many are waiting, so the
          sentence is qualified rather than a bare claim of absence. */}
      {data.shown === 0
        ? <p style={{ margin: 0, color: 'var(--text-2)' }}>{monoMarked(t('project.index.empty'))}</p>
        : (
          <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
            {parsed.map(([line, text, handle]) => (
              <li
                key={line}
                style={{ fontFamily: 'var(--font-memory)', fontSize: 15, lineHeight: 1.6, color: 'var(--text-1)', overflowWrap: 'anywhere' }}
              >
                {text.replace(/^- /, '')}
                <span style={{ fontFamily: 'var(--mono)', fontSize: 14, color: 'var(--text-3)' }}>{handle}</span>
              </li>
            ))}
          </ul>
        )}
      {data.more > 0 && <p style={{ margin: '8px 0 0', fontSize: 14, color: 'var(--text-3)' }}>{monoMarked(t('project.index.more', { n: `\`${data.more}${plus}\``, project: data.project }))}</p>}
      {data.older > 0 && <p style={{ margin: '8px 0 0', fontSize: 14, color: 'var(--text-3)' }}>{monoMarked(t('project.index.older', { n: `\`${data.older}${plus}\``, days: `\`${data.staleDays}\`` }))}</p>}
      <p style={{ margin: '10px 0 0', fontSize: 14, color: 'var(--text-3)' }}>{monoMarked(t('project.index.cost', { tokens: `\`${data.tokens}\``, bytes: `\`${data.bytes}\`` }))}</p>
    </section>
  );
}

/**
 * One per-project fetch: null until it lands, a named failure if it does not.
 *
 * The stated task state and the durable-memory index were two identical
 * effects — same `selected` guard, same `cancelled` flag, same settled (not
 * caught) handler, same cleanup. Settled is the load-bearing part and the
 * reason they stay together: a failed fetch is reported AS a failure, never
 * rendered as "nothing stated" or "no durable memories", so a copy of this
 * shape that drifts starts making claims about the user's data from an answer
 * nobody received. `fetcher` is a module-level function and deliberately not a
 * dependency — the effect re-runs on the project and the data revision.
 */
function useProjectResource<T>(
  fetcher: (project: string) => Promise<T>,
  selected: string | null,
  dataRevision: number,
): [T | null, string] {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setData(null);
    setError('');
    if (!selected) return;
    let cancelled = false;
    fetcher(selected).then(
      (value) => { if (!cancelled) setData(value); },
      (e: unknown) => { if (!cancelled) setError(failureMessage(classifyLoadError(e))); },
    );
    return () => { cancelled = true; };
  }, [selected, dataRevision]);
  return [data, error];
}

export function ProjectTab({ health, dataRevision = 0 }: { health?: HealthData | null; dataRevision?: number }) {
  const [entities, setEntities] = useState<Entity[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(urlProject);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [projectsError, setProjectsError] = useState('');
  const loadGen = useRef(0);

  useEffect(() => {
    const gen = ++loadGen.current;
    setLoading(true);
    setError('');
    setProjectsError('');
    Promise.all([
      api<Entity[]>('GET', `/v1/entities?limit=${FETCH_LIMIT}&status=all`),
      // `.catch(() => [])` reported a projects fetch that FAILED as a library
      // with no projects, and this tab renders that as "No project memories
      // yet" — a claim about the user's data made from an answer nobody
      // received. It is not a rare path: `computeProjects` scans with no LIMIT
      // while api() aborts at 10s, so a large graph produces the false
      // first-run claim reliably, WHILE the sibling entities fetch beside it
      // has already loaded thousands of rows. Settled rather than caught, so
      // the failure survives as a diagnosis instead of an empty list — and so
      // one dead endpoint still does not take the entities down with it.
      fetchProjects().then(
        (list) => ({ ok: true as const, list }),
        (e: unknown) => ({ ok: false as const, failure: classifyLoadError(e) }),
      ),
    ])
      .then(([data, projs]) => {
        if (gen !== loadGen.current) return;
        if (!Array.isArray(data)) {
          setError(failureMessage('unreadable'));
        } else {
          setEntities(data);
        }
        if (projs.ok) {
          setProjects(projs.list);
          // One project = no choice to make; walk straight in — unless a
          // ?project= deep link already chose (even a stale one: overriding
          // it would make the shared URL silently show something else).
          if (projs.list.length === 1) setSelected((cur) => cur ?? projs.list[0].name);
        } else {
          setProjectsError(failureMessage(projs.failure));
        }
      })
      .catch((e) => {
        if (gen !== loadGen.current) return;
        setError(failureMessage(classifyLoadError(e)));
      })
      .finally(() => {
        if (gen === loadGen.current) setLoading(false);
      });
  }, [dataRevision]);

  const projectEntities = useMemo(
    () => selectProjectEntities(entities, selected),
    [entities, selected],
  );

  const [taskState, taskStateError] = useProjectResource(fetchTaskState, selected, dataRevision);
  const [briefingIndex, briefingIndexError] = useProjectResource(fetchBriefingIndex, selected, dataRevision);

  if (loading && entities.length === 0) return <div class="empty"><div class="loading" /></div>;
  if (error && entities.length === 0) return <div class="error-box" role="alert">{error}</div>;

  // Tri-state before claiming emptiness: health arrives from App's own
  // async fetch, and `null?.entity_count === 0` is false — deciding before
  // it lands would render a false first-run claim.
  if (entities.length === 0 && health == null) return <div class="empty"><div class="loading" /></div>;
  if (health?.entity_count === 0) return <EmptyLibraryState />;

  // The projects fetch gets the same tri-state as health above, for the same
  // reason: an empty list because the request failed is not a library without
  // projects, and `project.empty` speaks about the user's DATA. Named as a
  // failure it is something the user can act on; folded into `[]` it is a
  // first-run claim they have no way to see through.
  if (projectsError && projects.length === 0) return <div class="error-box" role="alert">{projectsError}</div>;

  if (projects.length === 0) {
    return <div class="empty">
      <div>{t('project.empty')}</div>
      <TerminalHandoff id="project-hook-setup" command="memesh install-hooks" />
    </div>;
  }

  return (
    <div>
      {loading && <Loading />}
      {error && <div class="error-box" role="alert">{error}</div>}
      {projectsError && <div class="error-box" role="alert">{projectsError}</div>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12, alignItems: 'center' }}>
        <span style={{ fontSize: 14, color: 'var(--text-3)', marginRight: 4 }}>{t('project.selectLabel')}</span>
        {projects.map((p) => (
          <Chip
            key={p.name}
            label={p.name}
            count={p.count}
            active={selected === p.name}
            onClick={() => { setSelected(p.name); writeUrlProject(p.name); }}
          />
        ))}
      </div>
      {selected
        ? (
          <>
            <TaskStateCard data={taskState} error={taskStateError} />
            <BriefingIndexCard data={briefingIndex} error={briefingIndexError} />
            <div class="card" style={{ marginTop: 12 }}><ProjectRoadmap projectName={selected} entities={projectEntities} /></div>
          </>
        )
        : <div class="empty">{t('project.selectPrompt')}</div>}
    </div>
  );
}
