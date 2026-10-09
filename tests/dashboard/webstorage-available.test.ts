// @vitest-environment happy-dom
//
// The DOM half of the Web Storage setup contract — see
// `tests/setup/webstorage.ts` for the Node 26 behaviour it repairs.
//
// Pinned separately from the component tests that depend on it: when
// `OnboardingBanner` went red on the first Node 26 CI leg, five failures all
// read `Cannot read properties of undefined (reading 'clear')`, which points
// at the component. It was the environment. One test that says so directly
// costs nothing and saves that hunt next time.
import { afterEach, describe, it, expect, vi } from 'vitest';
import { getLocale, initLocale, setLocale } from '../../dashboard/src/lib/i18n';

describe('DOM tests get a working localStorage on every supported Node', () => {
  it('stores, reads back, and clears', () => {
    expect(typeof localStorage, 'no localStorage in a happy-dom test').toBe('object');

    localStorage.clear();
    expect(localStorage.getItem('memesh-probe')).toBeNull();

    localStorage.setItem('memesh-probe', 'value');
    expect(localStorage.getItem('memesh-probe')).toBe('value');

    localStorage.clear();
    expect(localStorage.getItem('memesh-probe')).toBeNull();
  });

  it('is happy-dom\'s Storage, not a hand-written stand-in', () => {
    // The repair borrows happy-dom's own implementation rather than
    // polyfilling one, so tests on Node 26 exercise the same object they
    // exercise everywhere else. A bespoke shim would let them pass against
    // behaviour that exists only in the test harness.
    expect(localStorage.constructor.name).toBe('Storage');
  });
});

describe('the locale picker survives the storage and language edge cases', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    setLocale('en');
    localStorage.clear(); // after setLocale, which stores its choice
  });

  // What a browser with site data blocked does: the property exists, and every
  // call throws a SecurityError.
  const blockedStorage = () => ({
    getItem: () => { throw new Error('storage blocked'); },
    setItem: () => { throw new Error('storage blocked'); },
    removeItem: () => { throw new Error('storage blocked'); },
    clear: () => {},
  });

  it('initLocale does not throw when storage is blocked (it runs inside the first render)', () => {
    vi.stubGlobal('localStorage', blockedStorage());
    expect(() => initLocale()).not.toThrow();
  });

  it('setLocale applies the choice for the session even when it cannot be stored', () => {
    vi.stubGlobal('localStorage', blockedStorage());
    expect(() => setLocale('ja')).not.toThrow();
    expect(getLocale()).toBe('ja');
    expect(document.documentElement.lang).toBe('ja');
  });

  it.each(['en', 'zh-TW', 'zh-CN', 'ja', 'ko', 'pt', 'fr', 'de', 'vi', 'es', 'th'] as const)(
    'marks the page language on startup and selection in %s', (locale) => {
      document.documentElement.lang = 'stale';
      localStorage.setItem('memesh-locale', locale);
      expect(initLocale()).toBe(locale);
      expect(document.documentElement.lang).toBe(locale);
      document.documentElement.lang = 'stale';
      setLocale(locale);
      expect(document.documentElement.lang).toBe(locale);
    },
  );

  it('a stored value that is only an Object.prototype name is not a locale', () => {
    localStorage.setItem('memesh-locale', 'constructor');
    expect(initLocale()).toBe('en');
  });

  it('Hong Kong and Macau browsers get Traditional Chinese', () => {
    for (const tag of ['zh-HK', 'zh-MO', 'zh-Hant-HK']) {
      vi.spyOn(navigator, 'language', 'get').mockReturnValue(tag);
      expect(initLocale(), tag).toBe('zh-TW');
      vi.restoreAllMocks();
    }
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('zh-CN');
    expect(initLocale()).toBe('zh-CN');
  });
});
