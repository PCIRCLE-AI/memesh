import { describe, expect, it } from 'vitest';
import { parseNetworkAddress, formatNetworkAddress, projectHash } from '../../src/network/address.js';

const NETWORK_ID = '0123456789abcdef0123456789abcdef';
const PROJECT = 'shared~0123456789abcdef0123456789abcdef';

describe('addresses', () => {
  it('split on the last @, then the first /', () => {
    expect(parseNetworkAddress('ann/alice@alpha')).toEqual({ person: 'ann', target: 'alice', machine: 'alpha' });
    expect(parseNetworkAddress('ann/shared-claude-ab12@alpha')).toEqual({ person: 'ann', target: 'shared-claude-ab12', machine: 'alpha' });
    for (const bad of ['alice', 'ann@alpha', '/alice@alpha', 'ann/@alpha', 'ann/a@', 'a b/c@d', 'ann/a/b@alpha', 'ann/a@b@c']) {
      expect(parseNetworkAddress(bad)).toBeNull();
    }
    expect(formatNetworkAddress('ann', 'alice', 'alpha')).toBe('ann/alice@alpha');
  });

  it('a project hash depends on the network and the project, and is not the project', () => {
    const hash = projectHash(NETWORK_ID, PROJECT);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('shared');
    expect(projectHash('f'.repeat(32), PROJECT)).not.toBe(hash);
  });
});
