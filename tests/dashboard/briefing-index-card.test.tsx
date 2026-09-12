// @vitest-environment happy-dom
// #323 — the Project tab shows the durable-memory index an agent receives.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/preact';
import { BriefingIndexCard, ProjectTab } from '../../dashboard/src/components/ProjectTab';
import { getLocales, setLocale, t } from '../../dashboard/src/lib/i18n';
import { fetchBriefingIndex, isBriefingIndexData, type BriefingIndexData } from '../../dashboard/src/lib/api';
import { buildBriefingIndex, INDEX_STALE_DAYS, type IndexCandidate } from '../../src/core/briefing-index.js';

function response(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'content-type': 'application/json' } });
}

const NOW = Date.parse('2026-09-12T00:00:00Z');
const CANDIDATES: IndexCandidate[] = [
  { id: 7, type: 'decision', title: 'Keep the index capped', snippet: null, lastActivity: '2026-09-10 10:00:00' },
  { id: 3, type: 'lesson_learned', title: 'Revert the fix and confirm red', snippet: null, lastActivity: '2026-09-01 10:00:00' },
];

/**
 * The fixture is BUILT BY THE SHIPPED RENDERER, not hand-written.
 *
 * The first version of this file typed out its own payload — including
 * `staleDays: 180` and its own idea of what a memory line looks like — so it
 * asserted against a contract the fixture itself invented, and stayed green
 * while the route was free to stop sending fields or to change the line
 * format. Here `lines`/`shown`/`older`/`bytes`/`tokens`/`ids` come from
 * `buildBriefingIndex`, `staleDays` from `INDEX_STALE_DAYS`, and the two
 * wrappers the route adds are the only literals — the same composition
 * `GET /v1/briefing-index` performs.
 */
function index(overrides: Partial<BriefingIndexData> = {}, candidates: IndexCandidate[] = CANDIDATES): BriefingIndexData {
  return {
    project: 'alpha',
    staleDays: INDEX_STALE_DAYS,
    ...buildBriefingIndex(candidates, 'alpha', NOW),
    ...overrides,
  };
}

/** What the card renders after the `--mono` spans are flattened: the catalogue
 *  marks those parts with backticks, and nothing user-visible keeps them. */
function spoken(key: string, params?: Record<string, string | number>): string {
  return t(key, params).replace(/`/g, '');
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); setLocale('en'); });

describe('Project tab: the durable-memory index (#323)', () => {
  it('builds its fixture from the real contract, not from a literal', () => {
    const data = index();
    expect(isBriefingIndexData(data)).toBe(true);
    expect(data.staleDays).toBe(INDEX_STALE_DAYS);
    expect(data.shown).toBe(2);
    expect(data.ids).toEqual([7, 3]);
  });

  it('lists the memory lines the agent receives, with their handles, and the cost', () => {
    const { container } = render(<BriefingIndexCard error="" data={index()} />);
    const items = [...container.querySelectorAll('li')].map((li) => li.textContent);
    expect(items).toHaveLength(2);
    expect(items).toEqual(['[decision] Keep the index capped [mem:7]', '[lesson_learned] Revert the fix and confirm red [mem:3]']);
    expect(container.textContent).toContain(t('project.index.title'));
    const { tokens, bytes } = index();
    expect(container.textContent).toContain(spoken('project.index.cost', { tokens, bytes }));
    expect(container.textContent).not.toContain(spoken('project.index.empty'));
  });

  it('shows the overflow and staleness lines so the cap is visible', () => {
    const { container } = render(<BriefingIndexCard error="" data={index({ more: 12, older: 4, truncated: true })} />);
    expect(container.textContent).toContain(spoken('project.index.more', { n: '12+', project: 'alpha' }));
    expect(container.textContent).toContain(spoken('project.index.older', { n: '4+', days: INDEX_STALE_DAYS }));
  });

  it('an empty project says so honestly', () => {
    const { container } = render(<BriefingIndexCard error="" data={index({}, [])} />);
    expect(container.textContent).toContain(spoken('project.index.empty'));
    expect(container.querySelectorAll('li')).toHaveLength(0);
  });

  // F1 — the empty state used to read "No durable memories for this project
  // yet" while the project chip beside it said 3: the index counts only what
  // is auto-injectable and `project:`-tagged, and `memesh import` stamps both
  // exclusions. A confident claim of absence about someone's own data is the
  // most expensive shape of defect here, so every locale has to carry the
  // qualification, not just English.
  it('never claims a bare absence: every locale names what is not counted', () => {
    for (const { code } of getLocales()) {
      setLocale(code);
      const empty = t('project.index.empty');
      expect(empty, `${code}: the empty state must name the \`project:\` tag requirement`).toContain('project:');
      expect(empty.length, `${code}: the empty state must qualify, not just deny`).toBeGreaterThan(t('project.index.title').length * 2);
      // `monoMarked` splits on backticks: an odd count would leak a stray
      // backtick onto the screen or set the rest of the sentence in --mono.
      for (const key of ['project.index.empty', 'project.index.more', 'project.index.older', 'project.index.cost']) {
        expect(t(key).split('`').length % 2, `${code}/${key}: unbalanced backticks`).toBe(1);
      }
    }
    setLocale('en');
    expect(t('project.index.empty')).toContain('untrusted');
    expect(t('project.index.empty')).toContain('Imported');
  });

  // F1, the defect itself: `memesh import` stamps both `provenance.source =
  // 'import'` and `trust: 'untrusted'`, and the index counts neither — while
  // the project chip beside the card counts them all. The card cannot stop
  // the exclusion (it is the documented contract), so what it says has to be
  // true of it.
  it('a project whose memories were all imported is not told it has none', () => {
    setLocale('en');
    const imported = CANDIDATES.map((c) => ({ ...c, metadata: { provenance: { source: 'import' }, trust: 'untrusted' } }));
    const data = index({}, imported);
    expect(data.shown, 'the auto-injection gate excludes imported memories').toBe(0);
    const { container } = render(<BriefingIndexCard error="" data={data} />);
    expect(container.textContent).toContain(spoken('project.index.empty'));
    expect(container.textContent, 'the empty state must name the exclusion that produced it').toMatch(/imported/i);
    expect(container.textContent).toMatch(/untrusted/i);
  });

  // F3 — a project whose memories are all older than the staleness cut-off
  // comes back as `shown: 0, older: n`. Keying the empty state on the pair
  // `shown === 0 && older === 0` sent that into the list branch: an empty
  // `<ul>` under the heading, with nothing saying why.
  it('a project with only stale memories says so, instead of an empty list', () => {
    const stale = CANDIDATES.map((c) => ({ ...c, lastActivity: '2024-01-01 00:00:00' }));
    const data = index({}, stale);
    expect(data.shown, 'stale memories are counted, not listed').toBe(0);
    expect(data.older).toBe(2);
    const { container } = render(<BriefingIndexCard error="" data={data} />);
    expect(container.querySelectorAll('ul')).toHaveLength(0);
    expect(container.textContent).toContain(spoken('project.index.empty'));
    expect(container.textContent).toContain(spoken('project.index.older', { n: '2', days: INDEX_STALE_DAYS }));
  });

  // F3 — `shown` is the server's count; the regex only recovers the lines from
  // prose. A shared renderer that changes format must not turn into "nothing
  // here".
  it('a payload whose line count disagrees with `shown` is a failure, not an empty card', () => {
    const good = index();
    const data = { ...good, lines: [good.lines[0], good.lines[2]], shown: 2 };
    const { container } = render(<BriefingIndexCard error="" data={data} />);
    expect(container.querySelector('[role="alert"]')?.textContent ?? '').not.toBe('');
    expect(container.textContent).not.toContain(spoken('project.index.empty'));
    expect(container.querySelectorAll('li')).toHaveLength(0);
  });

  // F5 — DESIGN.md "Type — three voices": memory content is --font-memory
  // 15/1.6; ids and counts are --mono.
  it('renders memory content in the memory voice and every id or count in mono', () => {
    const { container } = render(<BriefingIndexCard error="" data={index({ more: 12, older: 4 })} />);
    const li = container.querySelector('li') as HTMLElement;
    expect(li.style.fontFamily).toContain('--font-memory');
    expect(li.style.fontSize).toBe('15px');
    const monos = [...container.querySelectorAll('li span, p code')].map((el) => (el as HTMLElement).style.fontFamily);
    expect(monos.length).toBeGreaterThan(0);
    for (const family of monos) expect(family).toContain('--mono');
    const handle = container.querySelector('li span') as HTMLElement;
    expect(handle.textContent?.trim()).toBe('[mem:7]');
  });

  // F4 — the catalogue marks commands with backticks and this dashboard has
  // no markdown renderer; they used to reach the screen as literal characters.
  it('shows the recall command as code, never as literal backticks', () => {
    const { container } = render(<BriefingIndexCard error="" data={index({ more: 12 })} />);
    expect(container.textContent).not.toContain('`');
    const codes = [...container.querySelectorAll('code')].map((el) => el.textContent);
    expect(codes).toContain('memesh recall --tag project:alpha');
  });

  // F6 — a pure CSS spinner announces nothing.
  it('the loading state is announced to a screen reader', () => {
    const { container } = render(<BriefingIndexCard error="" data={null} />);
    const status = container.querySelector('[role="status"]') as HTMLElement;
    expect(status.getAttribute('aria-label')).toBe(t('common.loading'));
  });

  it('a failed fetch is a failure, never "no durable memories"', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/v1/entities')) return response([]);
      if (url === '/v1/projects') return response([{ name: 'alpha', count: 1, types: ['decision'], source: 'tag' }]);
      if (url.startsWith('/v1/task-state')) return response({ project: 'alpha', state: {} });
      if (url.startsWith('/v1/briefing-index')) return new Response(JSON.stringify({ success: false, error: 'boom' }), { status: 500, headers: { 'content-type': 'application/json' } });
      return response({});
    });
    const { container } = render(<ProjectTab health={{ status: 'ok', version: 't', entity_count: 1 }} />);
    await waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent ?? '').not.toBe(''));
    expect(container.textContent).not.toContain(spoken('project.index.empty'));
  });

  it('ProjectTab fetches /v1/briefing-index for the selected project', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/v1/entities')) return response([]);
      if (url === '/v1/projects') return response([{ name: 'alpha', count: 1, types: ['decision'], source: 'tag' }]);
      if (url.startsWith('/v1/task-state')) return response({ project: 'alpha', state: {} });
      if (url.startsWith('/v1/briefing-index?project=alpha')) return response(index());
      return response({});
    });
    const { container } = render(<ProjectTab health={{ status: 'ok', version: 't', entity_count: 1 }} />);
    await waitFor(() => expect(container.textContent).toContain('Keep the index capped [mem:7]'));
  });

  // F2 — the shape guard validated `lines` and `shown` only. Each field it let
  // through fails silently in the card: a missing `older` renders a heading
  // above an empty list, a missing `tokens` prints the literal `{tokens}`.
  describe('the shape guard reads the whole payload', () => {
    const REQUIRED = Object.keys(index()) as Array<keyof BriefingIndexData>;

    it('covers every field the type declares', () => {
      expect(REQUIRED).toEqual(
        expect.arrayContaining(['project', 'staleDays', 'lines', 'shown', 'more', 'older', 'truncated', 'bytes', 'tokens', 'ids']),
      );
    });

    for (const field of REQUIRED) {
      it(`rejects a success:true payload with \`${String(field)}\` missing`, async () => {
        const partial: Record<string, unknown> = { ...index() };
        delete partial[field];
        expect(isBriefingIndexData(partial)).toBe(false);
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(partial));
        await expect(fetchBriefingIndex('alpha')).rejects.toThrow(/unreadable/);
      });
    }

    it('rejects a response that is not JSON at all', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('<!doctype html><title>proxy</title>', { status: 200, headers: { 'content-type': 'text/html' } }),
      );
      await expect(fetchBriefingIndex('alpha')).rejects.toThrow();
    });
  });
});
