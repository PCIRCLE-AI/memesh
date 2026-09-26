import { describe, expect, it, vi } from 'vitest';
import { recipientEverSeen, recipientEverSeenAnywhere } from '../../scripts/hooks/_generated/agent-message-inbox.js';

// D8 review gap: `recipientEverSeen` is mirrored into the SessionStart hook's
// generated copy (scripts/generate-hook-core.mjs) so the hook and the MCP/CLI
// briefing surface can't disagree, but nothing in src/ or tests/ exercised
// that mirrored copy directly — a change to its catch block could regress
// silently. This calls the generated file, not src/core/agent-message-inbox.ts.
describe('generated hook copy: recipientEverSeen', () => {
  it('returns undefined, not a thrown error, when the query cannot be answered', () => {
    const throwingDb = {
      prepare() {
        throw new Error('no such table: agent_principals');
      },
    };
    expect(recipientEverSeen(throwingDb as never, 'proj', 'someone')).toBeUndefined();
  });

  it('returns true when the delivery table has seen the recipient', () => {
    const db = {
      prepare() {
        return { get: () => ({ seen: 1 }) };
      },
    };
    expect(recipientEverSeen(db as never, 'proj', 'someone')).toBe(true);
  });
});

// Same gap, for the any-project variant SessionStart's own hint uses (#402):
// this is the copy the hook actually imports, not src/core/agent-message-inbox.ts.
describe('generated hook copy: recipientEverSeenAnywhere', () => {
  it('returns undefined, not a thrown error, when the query cannot be answered, and does not call onError', () => {
    const throwingDb = {
      prepare() {
        throw new Error('no such table: agent_principals');
      },
    };
    const onError = vi.fn();
    expect(recipientEverSeenAnywhere(throwingDb as never, 'someone', onError)).toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
  });

  it('returns true when the delivery table has seen the recipient', () => {
    const db = {
      prepare() {
        return { get: () => ({ seen: 1 }) };
      },
    };
    expect(recipientEverSeenAnywhere(db as never, 'someone')).toBe(true);
  });

  it('calls onError for a failure that is not the tables-missing case', () => {
    const brokenDb = {
      prepare() {
        throw new Error('no such column: principal_id');
      },
    };
    const onError = vi.fn();
    expect(recipientEverSeenAnywhere(brokenDb as never, 'someone', onError)).toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
