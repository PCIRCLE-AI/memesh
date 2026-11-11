// What counts as a relay address, in one place: the same rule for `--relay` and for
// the relay named in an invite link.

const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/;

/**
 * The URL in normal form, or null when it is not acceptable. Credentials are
 * refused because this URL is stored and shown in status. Plain http carries the
 * relay handshake unprotected, so it is only accepted on this machine's loopback.
 */
export function parseRelayUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '') return null;
  if (url.protocol === 'https:') return url.toString();
  if (url.protocol === 'http:' && LOOPBACK_HOST.test(url.hostname)) return url.toString();
  return null;
}
