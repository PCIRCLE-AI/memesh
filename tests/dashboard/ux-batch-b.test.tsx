// @vitest-environment happy-dom
//
// Batch B — flow / error / empty-state UX. What these pin:
//
//   1. No raw exception prose reaches the user. A dead server surfaces as
//      the browser's "Failed to fetch"; every catch that used to paint
//      `e.message` now routes through actionFailureMessage(), which says
//      what happened AND what to do, localised.
//   2. api() reads the error envelope on non-2xx responses. The server
//      sends `success:false` envelopes WITH their real status (400/500);
//      throwing `HttpError` straight off `!res.ok` discarded the errorCode
//      the whole Batch-C translation layer exists for.
//   3. An empty DATABASE and a filter that matched nothing are different
//      truths with different messages — and the empty-database state carries
//      the demo seed button, the durable entry point that survives the
//      OnboardingBanner's permanent dismissal.
//   4. Silent truncation is spoken: Memories at its 2000-row fetch limit
//      names the real total; the Graph's node cap names what it kept.
//
// All network is stubbed — nothing here touches ~/.memesh or any config.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/preact';
import { api, HttpError, NetworkError, type Entity } from '../../dashboard/src/lib/api';
import { actionFailureMessage } from '../../dashboard/src/lib/failure';
import { t } from '../../dashboard/src/lib/i18n';
import { MemoriesTab } from '../../dashboard/src/components/MemoriesTab';
import { ProjectTab } from '../../dashboard/src/components/ProjectTab';
import { InsightsTab } from '../../dashboard/src/components/InsightsTab';
import { EmptyLibraryState } from '../../dashboard/src/components/EmptyLibraryState';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function entity(i: number, over: Partial<Entity> = {}): Entity {
  return {
    id: i,
    name: `entity-${i}`,
    // 'decision' sits in the WORK layer — the default scope when Signal
    // Mode is on — so list-visibility assertions see these rows.
    type: 'decision',
    created_at: '2026-08-01T00:00:00.000Z',
    observations: [`obs ${i}`],
    tags: [],
    ...over,
  };
}

const unreachableSentence = t('common.serverUnreachable');

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

/* ── api(): envelopes on real (non-2xx) statuses ─────────────────────────── */

describe('api() reads the error envelope the server actually sends (non-2xx)', () => {
  it('translates a KNOWN errorCode from a 400 envelope instead of throwing "HTTP 400"', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ success: false, errorCode: 'validation.bad-body', error: 'raw zod prose' }, 400),
    );
    const expected = t('httpError.validation.bad-body');
    expect(expected, 'the catalogue must contain the key this test relies on').not.toBe('httpError.validation.bad-body');
    await expect(api('POST', '/v1/remember', {})).rejects.toThrow(expected);
  });

  it('keeps the raw prose for an UNKNOWN code on a 500 envelope', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ success: false, errorCode: 'future.code', error: 'prose survives' }, 500),
    );
    await expect(api('GET', '/v1/whatever')).rejects.toThrow('prose survives');
  });

  it('still throws HttpError for a non-2xx with no envelope (a proxy page)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>Bad Gateway</html>', { status: 502 }),
    );
    await expect(api('GET', '/v1/health')).rejects.toBeInstanceOf(HttpError);
  });
});

/* ── actionFailureMessage(): the four shapes ─────────────────────────────── */

describe('actionFailureMessage', () => {
  it('turns a NetworkError into the unreachable sentence, not browser prose', () => {
    const msg = actionFailureMessage(new NetworkError('Failed to fetch'));
    expect(msg).toContain(unreachableSentence);
    expect(msg).not.toContain('Failed to fetch');
  });

  it('names the status for an envelope-less HttpError', () => {
    expect(actionFailureMessage(new HttpError(502))).toBe(t('common.serverError', { status: 502 }));
  });

  it('passes through an envelope Error (already translated or server prose)', () => {
    expect(actionFailureMessage(new Error('digest already applied'))).toBe('digest already applied');
  });

  it('falls back to the localized unknown for a non-Error throw', () => {
    expect(actionFailureMessage('wat')).toBe(t('errors.unknown'));
  });
});

/* ── MemoriesTab: dead server, both failure paths ────────────────────────── */

describe('MemoriesTab against a dead server', () => {
  it('deep search shows the localized unreachable sentence, never "Failed to fetch"', async () => {
    // The list loads fine and the server dies BEFORE the ranked search, so
    // the sentence this pins comes from the /v1/recall ACTION path — the
    // migrated SearchTab guard — not from the mount load's catch.
    let dead = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      if (dead) throw new TypeError('Failed to fetch');
      const url = String(input);
      if (url.includes('/v1/projects')) return jsonResponse({ success: true, data: [] });
      return jsonResponse({ success: true, data: [entity(1)] });
    });
    const { container } = render(<MemoriesTab />);
    await waitFor(() => {
      expect(container.textContent).toContain('obs 1');
    });

    dead = true;
    const input = container.querySelector('input[type="search"]') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'auth' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      const alert = container.querySelector('[role="alert"]');
      expect(alert, 'error box should render').not.toBeNull();
      expect(alert!.textContent).toContain(unreachableSentence);
    });
    expect(container.textContent).not.toContain('Failed to fetch');
  });

  it('routes a dead server at load through the classified sentence', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new TypeError('Failed to fetch');
    });
    const { container } = render(<MemoriesTab />);
    await waitFor(() => {
      const alert = container.querySelector('[role="alert"]');
      expect(alert).not.toBeNull();
      expect(alert!.textContent).toContain(unreachableSentence);
    });
    expect(container.textContent).not.toContain('Failed to fetch');
  });
});

/* ── MemoriesTab: empty database vs filter-matched-nothing ───────────────── */

function stubMemories(entities: Entity[], entityCount?: number) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST' && url.includes('/v1/demo/seed')) {
      return jsonResponse({ success: true, data: { inserted: 30, removed: 0 } });
    }
    if (url.includes('/v1/projects')) return jsonResponse({ success: true, data: [] });
    if (url.includes('/v1/entities')) return jsonResponse({ success: true, data: entities });
    return jsonResponse({ success: true, data: { status: 'ok', version: 't', entity_count: entityCount ?? entities.length } });
  });
}

describe('MemoriesTab empty-state awareness', () => {
  it('an empty database shows the seed entry point, not "try a different filter"', async () => {
    stubMemories([]);
    const { container } = render(<MemoriesTab health={{ status: 'ok', version: 't', entity_count: 0 }} />);
    await waitFor(() => {
      expect(container.textContent).toContain(t('emptyLibrary.title'));
    });
    expect(container.textContent).not.toContain(t('browse.emptyFilter'));

    // The one-click seed works from here — the OnboardingBanner may be
    // permanently dismissed, so this button is the durable path.
    const seedBtn = [...container.querySelectorAll('button')]
      .find((b) => b.textContent === t('onboarding.seedButton'));
    expect(seedBtn, 'seed button should render inside the empty state').toBeDefined();
    fireEvent.click(seedBtn!);
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith('/v1/demo/seed', expect.objectContaining({ method: 'POST' }));
    });
  });

  it('a filter that matched nothing keeps the filter message and no seed button', async () => {
    stubMemories([entity(1)]);
    const { container } = render(<MemoriesTab health={{ status: 'ok', version: 't', entity_count: 1 }} />);
    // UX-1: rows no longer print the machine name; the observation-derived
    // headline is the render sentinel now.
    await waitFor(() => {
      expect(container.textContent).toContain('obs 1');
    });
    const filterInput = container.querySelector('input[type="search"]') as HTMLInputElement;
    fireEvent.input(filterInput, { target: { value: 'zzz-no-match' } });
    await waitFor(() => {
      expect(container.textContent).toContain(t('browse.noMatch'));
    });
    expect(container.textContent).not.toContain(t('emptyLibrary.title'));
  });

  it('an empty WORK LAYER guides instead of apologising, and one click widens the scope', async () => {
    // Signal Mode defaults ON, so the tab opens scoped to the work layer.
    // A graph of pure mechanical capture (commits) has nothing there — the
    // empty state must say where work memories come from and offer the
    // all-memories scope, not claim a filter mismatch or a fresh install.
    stubMemories([entity(1, { type: 'commit' })]);
    const { container } = render(<MemoriesTab health={{ status: 'ok', version: 't', entity_count: 1 }} />);
    await waitFor(() => {
      expect(container.textContent).toContain(t('memories.workEmpty'));
    });
    expect(container.textContent).not.toContain(t('emptyLibrary.title'));
    expect(container.textContent).not.toContain(t('browse.noMatch'));

    const showAll = [...container.querySelectorAll('button')]
      .find((b) => (b.textContent ?? '').includes(t('memories.showAll')));
    expect(showAll, 'the show-all escape hatch should render').toBeDefined();
    fireEvent.click(showAll!);
    await waitFor(() => {
      expect(container.textContent).toContain('obs 1');
    });
  });

  it('names the truncation when the fetch limit is hit and the library is larger', async () => {
    const full = Array.from({ length: 2000 }, (_, i) => entity(i + 1));
    stubMemories(full, 5000);
    const { container } = render(<MemoriesTab health={{ status: 'ok', version: 't', entity_count: 5000 }} />);
    const expected = t('browse.truncated', {
      shown: (2000).toLocaleString('en'),
      total: (5000).toLocaleString('en'),
    });
    await waitFor(() => {
      expect(container.textContent).toContain(expected);
    });
  });

  it('says nothing about truncation when the fetch got everything', async () => {
    stubMemories([entity(1), entity(2)], 2);
    const { container } = render(<MemoriesTab health={{ status: 'ok', version: 't', entity_count: 2 }} />);
    await waitFor(() => {
      expect(container.textContent).toContain('obs 1');
    });
    // Match the key's stable English prefix rather than re-interpolating.
    expect(container.textContent).not.toContain('showing the first');
  });
});

/* ── ProjectTab: the tri-state before claiming emptiness ─────────────────── */
//
// Migrated from the retired LessonsTab's empty-state suite: the tri-state
// on `health` survived the tab merge and lives in ProjectTab now. The
// LessonsTab cap-note guard (`lessons.capNote`) has NO surviving surface —
// the merged Memories list speaks its truncation through `browse.truncated`,
// pinned above.

describe('ProjectTab empty states', () => {
  it('an empty DATABASE gets the seed entry point', async () => {
    stubMemories([]);
    const { container } = render(<ProjectTab health={{ status: 'ok', version: 't', entity_count: 0 }} />);
    await waitFor(() => {
      expect(container.textContent).toContain(t('emptyLibrary.title'));
    });
    expect(container.textContent).not.toContain(t('project.empty'));
  });

  it('renders neither empty-state while health is still loading (no false-flash)', async () => {
    // health arrives async from App's /v1/health, independent of this tab's
    // own entities fetch. Before it lands, `null?.entity_count === 0` is
    // false — deciding then would flash "no project memories yet" (or the
    // fresh-install screen) over a state nobody has measured yet. The
    // tri-state holds a neutral spinner until health !== null.
    stubMemories([]);
    const { container } = render(<ProjectTab health={null} />);
    // Let the tab's own fetch (the project list) settle first, so
    // this pins the post-load decision, not the initial loading spinner.
    // (Break-tested: with `entity_count: 0` instead of null, EmptyLibraryState
    // is already visible at this exact flush point — so the negative
    // assertions below run against the settled frame, not the initial one.)
    await waitFor(() => {
      // With no project selected the tab asks only for the project list; a
      // project's memories are fetched once one is chosen.
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('.loading'), 'a neutral spinner should hold the frame').not.toBeNull();
    expect(container.textContent).not.toContain(t('emptyLibrary.title'));
    expect(container.textContent).not.toContain(t('project.empty'));
  });

  it('a populated database with no project tags explains where the story comes from', async () => {
    stubMemories([entity(1)]);
    const { container } = render(<ProjectTab health={{ status: 'ok', version: 't', entity_count: 42 }} />);
    await waitFor(() => {
      expect(container.textContent).toContain(t('project.empty'));
    });
    expect(container.textContent).not.toContain(t('emptyLibrary.title'));
  });
});

/* ── InsightsTab: action failures are sentences, not exceptions ──────────── */

describe('InsightsTab action failure routing', () => {
  it('a dead server during accept shows the unreachable sentence', async () => {
    let dead = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (dead) throw new TypeError('Failed to fetch');
      if (method === 'GET' && /\/v1\/dream\/proposals\/\d+$/.test(url)) {
        // A reviewable proposal: Accept is only offered for content that loaded.
        return jsonResponse({
          success: true,
          data: {
            id: 1, project: 'p', cluster_key: 'k', status: 'pending', reason: null,
            created_at: '2026-08-05 00:00:00', reviewed_at: null, kind: 'digest',
            proposed_digest: { name: 'd', type: 'digest', observations: ['o'], tags: [] },
            source_ids: [1, 2],
          },
        });
      }
      if (method === 'GET' && url.includes('/v1/dream/proposals')) {
        return jsonResponse({
          success: true,
          data: [{
            id: 1, project: 'p', cluster_key: 'k', source_count: 2,
            digest_name: 'd', digest_observations_preview: 'txt',
            status: 'pending', created_at: '2026-08-05 00:00:00', kind: 'digest',
          }],
        });
      }
      return jsonResponse({ success: true, data: { status: 'applied' } });
    });

    const { container } = render(<InsightsTab />);
    const detailBtn = await waitFor(() => {
      const btn = [...container.querySelectorAll('button')]
        .find((b) => b.textContent === t('insights.viewDetail')) as HTMLButtonElement | undefined;
      if (!btn) throw new Error('detail button not rendered yet');
      return btn;
    });
    fireEvent.click(detailBtn);
    const acceptBtn = await waitFor(() => {
      const btn = [...container.querySelectorAll('button')]
        .find((b) => b.textContent === t('insights.accept')) as HTMLButtonElement | undefined;
      if (!btn) throw new Error('accept button not rendered yet');
      return btn;
    });
    dead = true;
    fireEvent.click(acceptBtn);

    await waitFor(() => {
      const alert = container.querySelector('[role="alert"]');
      expect(alert).not.toBeNull();
      expect(alert!.textContent).toContain(unreachableSentence);
    });
    expect(container.textContent).not.toContain('Failed to fetch');
  });

});

/* ── EmptyLibraryState: its own failure surface ──────────────────────────── */

describe('EmptyLibraryState', () => {
  it('surfaces a seed failure as a localized sentence in a live alert', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new TypeError('Failed to fetch');
    });
    const { container } = render(<EmptyLibraryState />);
    const btn = container.querySelector('button.btn-primary') as HTMLButtonElement;
    fireEvent.click(btn);
    await waitFor(() => {
      const alert = container.querySelector('[role="alert"]');
      expect(alert).not.toBeNull();
      expect(alert!.textContent).toContain(unreachableSentence);
    });
    // finally-block: the button re-enables so the user can retry.
    expect(btn.disabled).toBe(false);
  });
});

/* ── Project page: the selected project's memories, a page at a time ─────── */

describe('ProjectTab loads the selected project a page at a time', () => {
  const PAGE = 200; // PAGE_SIZE in ProjectTab.tsx
  const rows = (from: number, n: number) => Array.from({ length: n }, (_, i) =>
    entity(from + i, { title: `big memory ${from + i}`, tags: ['project:big'], created_at: '2026-03-01T00:00:00.000Z' }));

  function stub(pages: Array<Entity[] | 'fail'>) {
    const urls: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('/v1/projects')) return jsonResponse({ success: true, data: [{ name: 'big', count: 450, types: ['decision'], source: 'tag' }] });
      if (url.includes('/v1/entities')) {
        const offset = Number(new URL(url, 'http://localhost').searchParams.get('offset'));
        const page = pages[offset / PAGE] ?? [];
        if (page === 'fail') throw new TypeError('Failed to fetch');
        return jsonResponse({ success: true, data: page });
      }
      return jsonResponse({ success: true, data: {} });
    });
    return urls;
  }
  const renderTab = () => render(<ProjectTab health={{ status: 'ok', version: 't', entity_count: 450 }} />);

  it('asks the server for this project only — never the newest 2000 of the whole library', async () => {
    const urls = stub([rows(1, 3)]);
    const { container } = renderTab();
    await waitFor(() => expect(container.textContent).toContain('big memory 1'));

    const entityCalls = urls.filter((u) => u.includes('/v1/entities'));
    expect(entityCalls).toEqual([`/v1/entities?project=big&status=all&limit=${PAGE}&offset=0`]);
    expect(container.textContent).not.toContain(t('roadmap.emptyProject'));
    // A short page is the whole project: no partial notice, no button.
    expect(container.textContent).not.toContain(t('project.loadMore'));
  });

  it('says it is showing the newest page and loads the older ones on request', async () => {
    const urls = stub([rows(1, PAGE), rows(PAGE + 1, 5)]);
    const { container, getByRole } = renderTab();
    await waitFor(() => expect(container.textContent).toContain(t('project.partial', { n: PAGE.toLocaleString('en') })));

    fireEvent.click(getByRole('button', { name: t('project.loadMore') }));
    await waitFor(() => expect(container.textContent).toContain(`big memory ${PAGE + 5}`));
    expect(urls.some((u) => u.includes(`offset=${PAGE}`))).toBe(true);
    // The last page was short: everything is loaded, so the notice retires.
    expect(container.textContent).not.toContain(t('project.loadMore'));
  });

  it('a failed further page keeps what was loaded and says why', async () => {
    stub([rows(1, PAGE), 'fail']);
    const { container, getByRole } = renderTab();
    await waitFor(() => expect(container.textContent).toContain(t('project.loadMore')));

    fireEvent.click(getByRole('button', { name: t('project.loadMore') }));
    await waitFor(() => expect(container.textContent).toContain(unreachableSentence));
    expect(container.textContent).toContain('big memory 1');
  });
});

describe('ProjectTab: the previous project, the overlap between pages and keyboard focus', () => {
  const PAGE = 200; // PAGE_SIZE in ProjectTab.tsx
  const rowsOf = (project: string, from: number, n: number, over: Partial<Entity> = {}) => Array.from({ length: n }, (_, i) =>
    entity(from + i, { title: `${project} memory ${from + i}`, tags: [`project:${project}`], ...over }));
  const renderTab = () => render(<ProjectTab health={{ status: 'ok', version: 't', entity_count: 900 }} />);
  // `getByRole` searches the whole document: a previous test's tab must be
  // gone, and so must the `?project=` a chip click wrote to the address.
  afterEach(() => {
    cleanup();
    history.replaceState(null, '', '/');
  });

  /** One handler per project's entity pages; everything else answers `{}`. */
  function stubProjects(projects: string[], pages: (project: string, offset: number) => Promise<Entity[]> | Entity[] | 'fail') {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/v1/projects') {
        return jsonResponse({ success: true, data: projects.map((name) => ({ name, count: 450, types: ['decision'], source: 'tag' })) });
      }
      if (url.pathname === '/v1/entities') {
        const answer = await pages(url.searchParams.get('project')!, Number(url.searchParams.get('offset')));
        if (answer === 'fail') throw new TypeError('Failed to fetch');
        return jsonResponse({ success: true, data: answer });
      }
      return jsonResponse({ success: true, data: {} });
    });
  }
  const chip = (container: Element, name: string) => container.querySelector(`button[title="${name}"]`) as HTMLButtonElement;

  it('after a switch, a first page that fails shows the error alone — not the old rows as "no memories"', async () => {
    stubProjects(['alpha', 'beta'], (project) => (project === 'alpha' ? rowsOf('alpha', 1, 3) : 'fail'));
    const { container } = renderTab();
    await waitFor(() => expect(chip(container, 'alpha')).not.toBeNull());
    fireEvent.click(chip(container, 'alpha'));
    await waitFor(() => expect(container.textContent).toContain('alpha memory 1'));

    fireEvent.click(chip(container, 'beta'));
    await waitFor(() => expect(container.textContent).toContain(unreachableSentence));
    expect(container.textContent).not.toContain(t('roadmap.emptyProject'));
    expect(container.textContent).not.toContain('alpha memory 1');
  });

  it('a page that overlaps the previous one (a memory written since) lists each memory once', async () => {
    stubProjects(['big'], (_project, offset) => (offset === 0 ? rowsOf('big', 1, PAGE) : rowsOf('big', PAGE - 1, 6)));
    const { container, getByRole } = renderTab();
    await waitFor(() => expect(container.textContent).toContain(t('project.loadMore')));
    fireEvent.click(getByRole('button', { name: t('project.loadMore') }));
    await waitFor(() => expect(container.textContent).toContain(`big memory ${PAGE + 4}`));

    const count = (title: string) => container.textContent!.split(title).length - 1;
    expect(count(`big memory ${PAGE}`)).toBe(1);
    expect(count(`big memory ${PAGE - 1}`)).toBe(1);
  });

  it('"Load older memories" keeps keyboard focus while it loads, and hands it to the notice when the last page arrives', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let furtherPageRequests = 0;
    stubProjects(['big'], async (_project, offset) => {
      if (offset === 0) return rowsOf('big', 1, PAGE);
      furtherPageRequests++;
      await gate;
      return rowsOf('big', PAGE + 1, 5);
    });
    const { container, getByRole } = renderTab();
    await waitFor(() => expect(container.textContent).toContain(t('project.loadMore')));
    const button = getByRole('button', { name: t('project.loadMore') }) as HTMLButtonElement;
    button.focus();
    expect(document.activeElement).toBe(button);

    fireEvent.click(button);
    // Loading: still the same focusable control (a disabled button loses focus to <body>), marked busy for AT.
    await waitFor(() => expect(button.getAttribute('aria-disabled')).toBe('true'));
    expect(button.disabled).toBe(false);
    expect(document.activeElement).toBe(button);
    // A second press while the page loads must not ask for another page.
    fireEvent.click(button);

    release();
    await waitFor(() => expect(container.textContent).toContain(`big memory ${PAGE + 5}`));
    expect(furtherPageRequests).toBe(1);
    // The button is gone (everything is loaded); focus sits on the notice that says so.
    expect(container.textContent).not.toContain(t('project.loadMore'));
    const notice = container.querySelector('[role="status"][tabindex="-1"]') as HTMLElement;
    expect(notice.textContent).toBe(t('project.allLoaded', { n: (PAGE + 5).toLocaleString('en') }));
    expect(document.activeElement).toBe(notice);
  });

  it('"Load older memories": focus the user moved to a project chip while the last page loaded stays on the chip', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    stubProjects(['big', 'other'], async (project, offset) => {
      if (project !== 'big') return [];
      if (offset === 0) return rowsOf('big', 1, PAGE);
      await gate;
      return rowsOf('big', PAGE + 1, 5);
    });
    const { container, getByRole } = renderTab();
    await waitFor(() => expect(chip(container, 'big')).not.toBeNull());
    fireEvent.click(chip(container, 'big'));
    await waitFor(() => expect(container.textContent).toContain(t('project.loadMore')));
    const button = getByRole('button', { name: t('project.loadMore') }) as HTMLButtonElement;
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute('aria-disabled')).toBe('true'));

    // The user tabs away to another project's chip (tabbing only focuses it).
    const other = chip(container, 'other');
    other.focus();
    expect(document.activeElement).toBe(other);

    release();
    await waitFor(() => expect(container.textContent).toContain(`big memory ${PAGE + 5}`));
    const notice = container.querySelector('[role="status"][tabindex="-1"]') as HTMLElement;
    expect(notice.textContent).toBe(t('project.allLoaded', { n: (PAGE + 5).toLocaleString('en') }));
    expect(document.activeElement).toBe(other);
  });

  it('the notice counts the rows it shows, not the rows loaded (unlinked archived memories are loaded but not listed)', async () => {
    stubProjects(['big'], () => [...rowsOf('big', 1, 150), ...rowsOf('big', 151, 50, { status: 'archived' })]);
    const { container } = renderTab();
    await waitFor(() => expect(container.textContent).toContain(t('project.partial', { n: '150' })));
    expect(container.textContent).not.toContain(t('project.partial', { n: String(PAGE) }));
  });

  it('a failed further page is announced on its own, not from inside the status line that already speaks', async () => {
    stubProjects(['big'], (_project, offset) => (offset === 0 ? rowsOf('big', 1, PAGE) : 'fail'));
    const { container, getByRole } = renderTab();
    await waitFor(() => expect(container.textContent).toContain(t('project.loadMore')));
    fireEvent.click(getByRole('button', { name: t('project.loadMore') }));
    await waitFor(() => expect(container.textContent).toContain(unreachableSentence));
    const alert = Array.from(container.querySelectorAll('[role="alert"]')).find((el) => el.textContent?.includes(unreachableSentence))!;
    expect(alert.closest('[role="status"]')).toBeNull();
    // The failed page leaves the button usable for a retry.
    expect(getByRole('button', { name: t('project.loadMore') }).getAttribute('aria-disabled')).not.toBe('true');
  });
});

/* ── Memories: a failed project list is said, and Archive acts on ranked results ── */

describe('MemoriesTab edge behaviour', () => {
  it('says so when /v1/projects fails instead of silently dropping the project filter row', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).includes('/v1/projects')) throw new TypeError('Failed to fetch');
      return jsonResponse({ success: true, data: [entity(1)] });
    });
    const { container } = render(<MemoriesTab />);
    await waitFor(() => expect(container.textContent).toContain(unreachableSentence));
    expect(container.textContent).toContain('obs 1'); // the entities themselves still load
    expect(warn.mock.calls.some((c) => String(c[0]).includes('/v1/projects'))).toBe(true);
  });

  it('Archive on a ranked-search result changes that row (it offers Restore afterwards)', async () => {
    vi.stubGlobal('confirm', () => true);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.includes('/v1/projects')) return jsonResponse({ success: true, data: [] });
      if (url.includes('/v1/recall')) return jsonResponse({ success: true, data: { entities: [entity(7, { name: 'ranked-seven', observations: ['ranked obs'] })] } });
      if (url.includes('/v1/forget') && method === 'POST') return jsonResponse({ success: true, data: { archived: true } });
      return jsonResponse({ success: true, data: [entity(7, { name: 'ranked-seven', observations: ['ranked obs'] })] });
    });
    const { container, getByRole } = render(<MemoriesTab />);
    await waitFor(() => expect(container.textContent).toContain('ranked obs'));

    const input = container.querySelector('input[type="search"]') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'ranked' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(container.textContent).toContain(t('memories.rankedBy')));

    const archiveButtons = container.querySelectorAll<HTMLButtonElement>('button.btn-danger');
    expect(archiveButtons).toHaveLength(1);
    fireEvent.click(archiveButtons[0]);
    try {
      await waitFor(() => expect(getByRole('button', { name: t('browse.restore') })).toBeTruthy());
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
