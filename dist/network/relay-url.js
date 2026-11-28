const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/;
export function parseRelayUrl(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        return null;
    }
    if (url.username !== '' || url.password !== '')
        return null;
    if (url.protocol === 'https:')
        return url.toString();
    if (url.protocol === 'http:' && LOOPBACK_HOST.test(url.hostname))
        return url.toString();
    return null;
}
//# sourceMappingURL=relay-url.js.map