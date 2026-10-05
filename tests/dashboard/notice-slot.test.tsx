// @vitest-environment happy-dom
//
// The notice slot: at most ONE banner interrupts at a time, by priority
// Doctor > Onboarding > Insights. The mechanism is split across two
// places, so this file pins both halves:
//
//   1. App.tsx renders the three banners inside `.notice-slot` in priority
//      order — each banner self-decides eligibility and renders no DOM
//      when ineligible, so document order IS the priority order.
//   2. global.css hides every slot child after the first rendered one.
//      happy-dom does not compute stylesheet cascade, so the rule is
//      pinned at the source: delete or loosen it and this file goes red
//      even though every DOM assertion would still pass.
//
// All network is stubbed — nothing here touches ~/.memesh or any config.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/preact';
import { InsightsBanner } from '../../dashboard/src/components/InsightsBanner';
import { readFileSync } from 'fs';
import { t } from '../../dashboard/src/lib/i18n';
import { App } from '../../dashboard/src/App';
import type { HealthData } from '../../dashboard/src/lib/api';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Every banner eligible at once: doctor FAILs, the library is empty, and
 *  two dream proposals wait. (Insights additionally needs the active tab
 *  to not be Home — pinned via the stored tab below.) */
function stubAllBannersEligible(health: HealthData = { status: 'ok', version: 't', entity_count: 0 }) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/v1/doctor')) {
      return jsonResponse({
        success: true,
        data: {
          status: 'FAIL',
          checks: [{ id: 'db', label: 'Database', status: 'fail', summary: 'db unreadable' }],
        },
      });
    }
    if (url.includes('/v1/dream/proposals')) {
      return jsonResponse({ success: true, data: [{ id: 1, status: 'pending' }, { id: 2, status: 'pending' }] });
    }
    if (url.includes('/v1/health')) {
      return jsonResponse({ success: true, data: health });
    }
    if (url.includes('/v1/config')) {
      return jsonResponse({ success: true, data: {} });
    }
    return jsonResponse({ success: true, data: [] });
  });
}

describe('the notice slot shows one banner at a time, by priority', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    // Insights self-suppresses on Home (its content lives there); park the
    // app on Memories so all three banners are eligible simultaneously.
    localStorage.setItem('memesh.tab', 'Memories');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('renders all eligible banners inside the slot in Doctor > Onboarding > Insights order', async () => {
    stubAllBannersEligible();
    const { container } = render(<App />);

    const slot = container.querySelector('.notice-slot');
    expect(slot, 'App must render the notice slot').not.toBeNull();

    await waitFor(() => {
      // All three eligible banners have landed in the slot.
      expect(slot!.children.length).toBe(3);
    });

    // Document order is the priority order — the stylesheet shows only the
    // first child, so getting this order wrong silently changes which
    // notice the user sees.
    const [first, second, third] = [...slot!.children];
    expect(first.textContent).toContain('db unreadable');
    expect(second.textContent).toContain(t('onboarding.title'));
    expect(third.textContent).toContain(
      t('banner.pendingInsights', { n: 2, s: 's' }),
    );
  });

  it('the next notice in line takes the slot when the winner is not eligible', async () => {
    stubAllBannersEligible();
    // The doctor banner's dismissal signature matches the stubbed failing
    // check, so the highest-priority notice is out of the running from the
    // first render — Onboarding must be the slot's first child.
    localStorage.setItem('memesh.doctorBanner.dismissedSig', 'db:fail::');
    const { container } = render(<App />);

    const slot = container.querySelector('.notice-slot')!;
    await waitFor(() => {
      expect(slot.children.length).toBe(2);
    });
    expect(slot.children[0].textContent).toContain(t('onboarding.title'));
  });

  it('keeps populated demo cleanup outside the competing notice slot', async () => {
    stubAllBannersEligible({
      status: 'ok',
      version: 't',
      entity_count: 30,
      demo_entity_count: 30,
    });
    const { container, getByRole } = render(<App />);

    const cleanup = await waitFor(() => getByRole('region', {
      name: /Demo data|示範資料|示范数据|デモデータ|데모 데이터/i,
    }));
    const slot = container.querySelector('.notice-slot')!;
    expect(slot.contains(cleanup)).toBe(false);
    expect(cleanup.textContent).toContain('30');
    expect(slot.textContent).toContain('db unreadable');
  });

  it('the stylesheet hides every slot child after the first', () => {
    const css = readFileSync('dashboard/src/styles/global.css', 'utf8');
    // The one-notice rule: any .notice-slot child with a preceding sibling
    // is display:none. Whitespace-tolerant, but the selector and the
    // declaration must both survive.
    expect(css).toMatch(/\.notice-slot\s*>\s*\*\s*~\s*\*\s*\{\s*display:\s*none;?\s*\}/);
  });
});

describe('InsightsBanner keyboard and reporting', () => {
  afterEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });

  function stubPending(count: number) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({ success: true, data: Array.from({ length: count }, (_, i) => ({ id: i + 1, status: 'pending' })) }));
  }

  // The banner is two sibling buttons. A real <button> is keyboard-operable by
  // the browser (Enter and Space click it), so nothing here handles keys.
  const navigateButton = (container: Element) => container.querySelector(`button[aria-label$="${t('banner.viewAll')}"]`) as HTMLButtonElement | null;
  const dismissButton = (container: Element) => container.querySelector(`button[aria-label="${t('banner.dismiss')}"]`) as HTMLButtonElement | null;
  const shown = (container: Element) => waitFor(() => {
    if (!navigateButton(container)) throw new Error('banner not shown yet');
  });

  it('has the view-all button and the × button side by side, neither inside the other', async () => {
    stubPending(2);
    const { container } = render(<InsightsBanner currentTab="Memories" onNavigateToInsights={() => {}} />);
    await shown(container);
    const view = navigateButton(container)!;
    const dismiss = dismissButton(container)!;
    expect(view.contains(dismiss)).toBe(false);
    expect(dismiss.contains(view)).toBe(false);
    expect(view.parentElement).toBe(dismiss.parentElement);
    // No element pretends to be a button around other controls.
    expect(container.querySelector('[role="button"]')).toBeNull();
    expect(container.querySelector('button button')).toBeNull();
  });

  it('× dismisses without navigating, and the view-all button navigates', async () => {
    stubPending(2);
    const onNavigate = vi.fn();
    const { container } = render(<InsightsBanner currentTab="Memories" onNavigateToInsights={onNavigate} />);
    await shown(container);

    fireEvent.click(navigateButton(container)!);
    expect(onNavigate).toHaveBeenCalledTimes(1);

    fireEvent.click(dismissButton(container)!);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(container.querySelector('button')).toBeNull();
    expect(sessionStorage.getItem('memesh.insightsBanner.dismissed')).toBe('true');
  });

  it('keeps its visible text in the accessible name', async () => {
    stubPending(3);
    const { container } = render(<InsightsBanner currentTab="Memories" onNavigateToInsights={() => {}} />);
    await shown(container);
    expect(navigateButton(container)!.getAttribute('aria-label')).toContain(t('banner.pendingInsights', { n: 3, s: 's' }));
  });

  it('logs when the proposals request fails instead of failing in silence', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    render(<InsightsBanner currentTab="Memories" onNavigateToInsights={() => {}} />);
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(String(warn.mock.calls[0]![0])).toContain('/v1/dream/proposals');
  });

  // Keep this last: it checks what the test before it left behind.
  it('starts without the spies of the test before it', () => {
    expect(vi.isMockFunction(console.warn)).toBe(false);
    expect(vi.isMockFunction(globalThis.fetch)).toBe(false);
  });
});
