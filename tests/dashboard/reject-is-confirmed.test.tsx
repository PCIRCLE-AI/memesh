// @vitest-environment happy-dom
//
// Rejecting a dream proposal is one click and irreversible.
//
// No surface offers an un-reject. So a mis-click on a ghost-styled button
// next to the primary action irreversibly rejects this reviewed proposal,
// silently. Rejection does not create a durable opt-out from future prompts.
//
// The sibling irreversible action in this dashboard, `OnboardingBanner`'s
// demo reset, already asks first. Accept deliberately does not: an accepted
// memory can be forgotten.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/preact';
import { InsightsTab } from '../../dashboard/src/components/InsightsTab';

const PROPOSAL = {
  id: 7,
  project: 'memesh',
  cluster_key: 'memesh::review-7',
  source_count: 2,
  digest_name: 'a proposed digest',
  digest_observations_preview: 'the digest body',
  kind: 'digest',
  source_kind: 'entities',
  status: 'pending',
  created_at: '2026-08-24T00:00:00Z',
};

const DETAIL = {
  ...PROPOSAL,
  source_ids: [1, 2],
  proposed_digest: {
    name: PROPOSAL.digest_name,
    type: 'digest',
    observations: ['the digest body'],
    tags: ['project:memesh'],
  },
  reason: null,
  reviewed_at: null,
};

/** Answer the tab's own GETs; record every POST it attempts. */
function stubApi(posts: string[]) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST') posts.push(url);
    let data: unknown;
    if (method === 'POST') data = { id: 7, status: url.endsWith('/accept') ? 'applied' : 'rejected' };
    else if (url.endsWith('/v1/dream/proposals/7')) data = DETAIL;
    else if (url.includes('/v1/dream/proposals')) data = [PROPOSAL];
    else data = { config: {} };
    return Promise.resolve(
      new Response(
        JSON.stringify({ success: true, data }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
  });
}

async function renderWithProposal(posts: string[]) {
  stubApi(posts);
  const view = render(<InsightsTab />);
  // Review actions must not exist until the full proposal is loaded.
  await waitFor(() => {
    expect(view.container.textContent ?? '', 'the proposal row never rendered').toContain('#7');
  });
  fireEvent.click(view.getByRole('button', { name: 'View detail' }));
  await waitFor(() => {
    rejectButton(view.container);
  });
  return view;
}

function rejectButton(container: Element): HTMLButtonElement {
  const buttons = Array.from(container.querySelectorAll('button')) as unknown as HTMLButtonElement[];
  // The reject button is the ghost one carrying the danger colour, next to
  // the primary accept.
  const found = buttons.find((b) => (b.getAttribute('style') ?? '').includes('--danger'));
  if (!found) throw new Error('fixture: no reject button rendered');
  return found;
}

// happy-dom does not implement `confirm`, so there is nothing to spy on —
// it has to be installed. Which is also the honest shape of the test: the
// component calls the bare global, exactly as a browser provides it.
const savedConfirm = (globalThis as { confirm?: unknown }).confirm;

function answerConfirm(value: boolean): ReturnType<typeof vi.fn> {
  const stub = vi.fn(() => value);
  (globalThis as unknown as { confirm: unknown }).confirm = stub;
  return stub;
}

describe('rejecting a proposal asks first', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    (globalThis as unknown as { confirm: unknown }).confirm = savedConfirm;
  });

  it('sends nothing when the user cancels', async () => {
    const posts: string[] = [];
    const { container } = await renderWithProposal(posts);
    answerConfirm(false);

    fireEvent.click(rejectButton(container));
    // Give any in-flight promise a turn to land before asserting absence.
    await new Promise((r) => setTimeout(r, 0));

    expect(posts, 'a cancelled reject still called the server').toEqual([]);
  });

  it('sends the reject when the user confirms — the anti-vacuity half', async () => {
    // Without this, a reject handler that returned unconditionally would
    // satisfy the test above perfectly.
    const posts: string[] = [];
    const { container } = await renderWithProposal(posts);
    const confirmSpy = answerConfirm(true);

    fireEvent.click(rejectButton(container));

    await waitFor(() => {
      expect(posts.some((u) => u.includes('/v1/dream/proposals/7/reject'))).toBe(true);
    });
    expect(confirmSpy).toHaveBeenCalledWith('Reject this insight? This action cannot be undone.');
    // The size pin that gives the `toEqual([])` above its meaning: one click
    // produces exactly one call, so "no calls" is a real observation and not
    // a stub that never records anything.
    expect(posts.filter((u) => u.includes('/reject'))).toHaveLength(1);
  });

  it('does not ask before accepting — accept is reversible', async () => {
    const posts: string[] = [];
    const { container } = await renderWithProposal(posts);
    const confirmSpy = answerConfirm(true);

    const accept = Array.from(container.querySelectorAll('button.btn-primary')) as unknown as HTMLButtonElement[];
    const acceptButton = accept.find((b) => !(b.getAttribute('style') ?? '').includes('--danger'));
    expect(acceptButton, 'fixture: no accept button rendered').toBeDefined();
    fireEvent.click(acceptButton!);

    await waitFor(() => {
      expect(posts.some((u) => u.includes('/v1/dream/proposals/7/accept'))).toBe(true);
    });
    expect(confirmSpy, 'accept grew a confirmation it should not have').not.toHaveBeenCalled();
  });
});
