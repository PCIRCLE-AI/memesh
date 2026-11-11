// The test bind hook: unset changes nothing; set, the endpoint binds to that one
// address and advertises none; a value of any other shape is refused.
import { describe, expect, it } from 'vitest';
import { advertisedAddresses, bindEndpoint, testBindAddress } from '../../src/network/endpoint.js';
import type { Endpoint, IrohModule } from '../../src/network/iroh-types.js';

function fakeIroh(): { iroh: IrohModule; calls: string[] } {
  const calls: string[] = [];
  const endpoint = { addr: () => ({ directAddresses: () => ['192.168.1.5:4433', '100.80.1.2:4433'] }) } as unknown as Endpoint;
  const builder = {
    applyMinimal: () => { calls.push('applyMinimal'); },
    secretKey: () => { calls.push('secretKey'); },
    alpns: () => { calls.push('alpns'); },
    relayMode: () => { calls.push('relayMode'); },
    bindAddr: (addr: string) => { calls.push(`bindAddr ${addr}`); },
    bind: async () => { calls.push('bind'); return endpoint; },
  };
  const iroh = {
    Endpoint: { builder: () => builder },
    RelayMode: { disabled: () => ({}), customFromUrls: () => ({}) },
  } as unknown as IrohModule;
  return { iroh, calls };
}

describe('the test bind hook', () => {
  it('unset: the same calls as before, and the real addresses are advertised', async () => {
    const { iroh, calls } = fakeIroh();
    const endpoint = await bindEndpoint(iroh, Buffer.alloc(32), 'off', ['memesh/net/1'], {});
    expect(calls).toEqual(['applyMinimal', 'secretKey', 'relayMode', 'alpns', 'bind']);
    expect(advertisedAddresses(endpoint, {})).toEqual(['192.168.1.5:4433', '100.80.1.2:4433']);
    expect(advertisedAddresses(endpoint, { MEMESH_TEST_NETWORK_BIND: '' })).toHaveLength(2);
  });

  it.each(['127.0.0.1:0', '[::1]:0', '127.0.0.1:4433'])('set to %s: binds there only and advertises nothing', async (value) => {
    const { iroh, calls } = fakeIroh();
    const env = { MEMESH_TEST_NETWORK_BIND: value };
    const endpoint = await bindEndpoint(iroh, Buffer.alloc(32), 'https://relay.example/', [], env);
    expect(calls).toEqual(['applyMinimal', 'secretKey', 'relayMode', `bindAddr ${value}`, 'bind']);
    expect(advertisedAddresses(endpoint, env)).toHaveLength(0);
  });

  it.each(['localhost:0', '127.0.0.1', '999.0.0.1:0', '127.0.0.1:70000', '127.0.0.1:0; rm -rf /', '0'])('a bad shape is refused, not ignored: %s', async (value) => {
    expect(() => testBindAddress(value)).toThrowError(/MEMESH_TEST_NETWORK_BIND must be an IP address and port/);
    const { iroh, calls } = fakeIroh();
    await expect(bindEndpoint(iroh, Buffer.alloc(32), 'off', [], { MEMESH_TEST_NETWORK_BIND: value })).rejects.toThrowError(/did not start/);
    expect(calls).toHaveLength(0);
  });
});
