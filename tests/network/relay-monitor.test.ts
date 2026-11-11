import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { parseRelayUrl } from '../../src/network/relay-url.js';
import type { RelayState } from '../../src/network/bridge-state.js';
import { applyRelayState, pingRelay, relayComplaint, relayStateOf } from '../../src/network/relay-monitor.js';

describe('relay state', () => {
  it('follows reality, not just the first online()', () => {
    const base = { online: false, deadlinePassed: false, reachable: null };
    expect(relayStateOf(base)).toBe('connecting');
    expect(relayStateOf({ ...base, deadlinePassed: true })).toBe('unreachable');
    expect(relayStateOf({ ...base, online: true })).toBe('online');
    // The transport stays "online" for good once it has been; the ping is what notices.
    expect(relayStateOf({ online: true, deadlinePassed: true, reachable: false })).toBe('unreachable');
    expect(relayStateOf({ online: true, deadlinePassed: true, reachable: true })).toBe('online');
    expect(relayStateOf({ online: false, deadlinePassed: false, reachable: false })).toBe('unreachable');
  });

  it('coming back online clears only its own complaint', () => {
    const url = 'https://relay.example/';
    const status = { relay_state: 'online' as const as RelayState, last_error: null as string | null, last_error_at: null as string | null };
    const signals = { online: true, deadlinePassed: true, reachable: false };
    expect(applyRelayState(status, signals, url)).toBe(true);
    expect(status.relay_state).toBe('unreachable');
    status.last_error = relayComplaint(url);
    status.last_error_at = 'then';
    expect(applyRelayState(status, signals, url)).toBe(false);
    signals.reachable = true;
    expect(applyRelayState(status, signals, url)).toBe(true);
    expect(status).toEqual({ relay_state: 'online', last_error: null, last_error_at: null });

    signals.reachable = false;
    applyRelayState(status, signals, url);
    status.last_error = 'something else broke';
    signals.reachable = true;
    applyRelayState(status, signals, url);
    expect(status.last_error).toBe('something else broke');
  });

  it('a ping is true only for a 2xx from the relay\'s ping path, and never throws', async () => {
    const seen: string[] = [];
    let code = 200;
    const server = http.createServer((request, response) => {
      seen.push(request.url as string);
      response.statusCode = code;
      response.end();
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    try {
      expect(await pingRelay(url)).toBe(true);
      expect(seen).toEqual(['/ping']);
      code = 503;
      expect(await pingRelay(url)).toBe(false);
    } finally {
      await new Promise((resolve) => { server.close(resolve); });
    }
    expect(await pingRelay(url)).toBe(false);
  });
});

describe('a relay that redirects', () => {
  it('a redirect to a page that answers 200 is not "online", and the redirect is not followed', async () => {
    const elsewhere: string[] = [];
    const page = http.createServer((request, response) => {
      elsewhere.push(request.url as string);
      response.statusCode = 200;
      response.end('a captive portal, or any web page');
    });
    await new Promise<void>((resolve) => { page.listen(0, '127.0.0.1', resolve); });
    const pageUrl = `http://127.0.0.1:${(page.address() as AddressInfo).port}/welcome`;
    const relay = http.createServer((_request, response) => {
      response.statusCode = 302;
      response.setHeader('location', pageUrl);
      response.end();
    });
    await new Promise<void>((resolve) => { relay.listen(0, '127.0.0.1', resolve); });
    try {
      expect(await pingRelay(`http://127.0.0.1:${(relay.address() as AddressInfo).port}/`)).toBe(false);
      expect(elsewhere).toHaveLength(0);
      // The page does answer 200 and its log works: a followed redirect would have shown here.
      expect((await fetch(pageUrl)).status).toBe(200);
      expect(elsewhere).toHaveLength(1);
      expect(elsewhere).toEqual(['/welcome']);
    } finally {
      await new Promise((resolve) => { relay.close(resolve); });
      await new Promise((resolve) => { page.close(resolve); });
    }
  });

  it('any 2xx from the relay itself counts', async () => {
    const relay = http.createServer((_request, response) => {
      response.statusCode = 204;
      response.end();
    });
    await new Promise<void>((resolve) => { relay.listen(0, '127.0.0.1', resolve); });
    try {
      expect(await pingRelay(`http://127.0.0.1:${(relay.address() as AddressInfo).port}/`)).toBe(true);
    } finally {
      await new Promise((resolve) => { relay.close(resolve); });
    }
  });
});

describe('relay addresses', () => {
  it('https is fine, plain http only on loopback, credentials never', () => {
    expect(parseRelayUrl('https://relay.memesh.ai/')).toBe('https://relay.memesh.ai/');
    expect(parseRelayUrl('https://relay.memesh.ai')).toBe('https://relay.memesh.ai/');
    for (const local of ['http://127.0.0.1:9/', 'http://localhost:9/', 'http://[::1]:9/']) {
      expect(parseRelayUrl(local)).toBe(local);
    }
    for (const bad of [
      'http://relay.memesh.ai/', 'http://192.168.1.2/', 'http://127.0.0.1.example.com/', 'https://u:p@relay.memesh.ai/',
      'https://u@relay.memesh.ai/', 'http://u:p@127.0.0.1/', 'ftp://relay/', 'not a url', 'off',
    ]) {
      expect(parseRelayUrl(bad)).toBeNull();
    }
  });
});
