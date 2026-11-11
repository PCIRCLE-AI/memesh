import { describe, it, expect } from 'vitest';
import { isLoopbackHost } from '../../src/transports/http/server.js';

describe('isLoopbackHost', () => {
  it.each([
    'localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]',
    '0:0:0:0:0:0:0:1', '0000:0000:0000:0000:0000:0000:0000:0001', '[0:0:0:0:0:0:0:1]',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:0001',
  ])('treats %s as loopback', (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each([
    '0.0.0.0', '10.0.0.1', '192.168.1.5', '::', '::2', '2001:db8::1', '::ffff:10.0.0.1', '::ffff:a00:1',
    'example.com', '127.evil.example', '127.0.0.1.evil.example', '',
  ])('does not treat %s as loopback', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});
