import { describe, it, expect } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateKeyPairSync } from 'crypto';
import { holdsSecret, redactSecretList, redactSecrets, redactUserPaths, SECRET_PATTERN_SOURCES } from '../../src/core/paths.js';

/**
 * redactSecrets guards two PUBLIC egresses — the dashboard's /v1/doctor and
 * the CLI's `memesh feedback`, both of which land verbatim in a pre-filled
 * GitHub issue body. Until this file existed the function had ZERO tests:
 * deleting any single pattern, or the call itself, left the whole suite
 * green while credentials sailed into a public issue URL. A cross-model
 * review measured the gap empirically (github_pat_, Stripe, JWT and npm
 * tokens all survived the old seven-pattern list).
 */
describe('redactSecrets (public-egress credential masking)', () => {
  // One realistic sample per shape the shared list claims to cover.
  const SECRETS: Array<[string, string]> = [
    ['anthropic key', 'sk-ant-' + 'a1B2'.repeat(6)],
    ['openai key', 'sk-' + 'x9Yz'.repeat(6)],
    ['underscore sk key', 'sk_' + 'a1b2c3d4'.repeat(2)],
    ['stripe live secret', 'sk_live_' + 'A1b2C3d4'.repeat(3)],
    ['stripe test restricted', 'rk_test_' + 'A1b2C3d4'.repeat(3)],
    ['github classic PAT', 'ghp_' + 'A1b2C3d4'.repeat(9)],
    ['github oauth', 'gho_' + 'A1b2C3d4'.repeat(9)],
    ['github server token', 'ghs_' + 'A1b2C3d4'.repeat(9)],
    ['github refresh token', 'ghr_' + 'A1b2C3d4'.repeat(9)],
    ['github fine-grained PAT', 'github_pat_' + '11AAAAAAA0'.repeat(4)],
    ['aws access key', 'AKIA' + 'ABCDEFGHIJKLMNOP'],
    ['aws temporary key', 'ASIA' + 'ABCDEFGHIJKLMNOP'],
    ['google api key', 'AIza' + 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5'],
    ['slack bot token', 'xoxb-1234567890-abcdefghij'],
    ['npm automation token', 'npm_' + 'a1B2c3D4e5F6'.repeat(3)],
    ['sendgrid key', 'SG.' + 'a1B2c3D4e5F6g7H8'.repeat(1) + '.' + 'i9J0k1L2m3N4o5P6'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM'],
    ['bearer token', 'Bearer abcdefghijklmnopqrstuvwxyz012345'],
    ['postgres url creds', 'postgres://memesh_user:hunter2secret@db.internal:5432/prod'],
    // #238 — what a provider ACTUALLY returns for a rejected key: the value
    // quoted back, partially masked. The old `sk-[A-Za-z0-9_-]{16,}` stopped
    // at the first mask glyph and published the prefix and the tail.
    ['masked openai key (asterisks)', 'sk-proj-**********************************ZfQ9'],
    ['masked openai key (bullets)', 'sk-proj-••••••••••••••••ZfQ9'],
    ['truncated openai key', 'sk-proj-...ZfQ9'],
    // #238 — a credential in a query string. No pattern covered this shape.
    ['url query api key', 'api_key=A1b2C3d4E5f6G7h8I9j0'],
    ['url query access token', 'access_token=A1b2C3d4E5f6G7h8I9j0'],
  ];

  it.each(SECRETS)('masks a %s', (_label, secret) => {
    const out = redactSecrets(`context before ${secret} context after`);
    expect(out).toContain('***REDACTED***');
    // The full credential must be gone. For URL-shaped secrets the scheme
    // may survive; the password portion must not.
    expect(out).not.toContain(secret.includes('@') ? 'hunter2secret' : secret);
  });

  it('masks a PEM private key body, including a truncated paste', () => {
    const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ';
    const whole = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
    expect(redactSecrets(whole)).not.toContain(body);
    const truncated = `-----BEGIN PRIVATE KEY-----\n${body}\n\ntrailing prose`;
    expect(redactSecrets(truncated)).not.toContain(body);
  });

  it('is idempotent, and never removes ordinary text after a redaction marker (#523)', () => {
    // Every edit through the memory tool redacts the WHOLE file again, so a
    // second pass that changes anything silently deletes stored lines: a rule
    // that treated `***REDACTED***` + base64-shaped lines as a key body ate a
    // commit hash, a long word and `next` on each later edit.
    const marker = (kind: string) => `-----${kind} RSA ${'PRIV' + 'ATE'} KEY-----`;
    const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ';
    const secrets = [
      ...SECRETS.map(([, secret]) => secret),
      `${marker('BEGIN')}\n${body}\n${marker('END')}`,
      `${marker('BEGIN')}\n${body}\n${body}\nAAAA`,
      `${marker('BEGIN')}\r\n${body}\r\n${body}`,
      `{"private_key": "${marker('BEGIN')}\\n${body}\\n${body}`,
      `password=Bearer\n${'abcdefghijklmnop1234'}`,
      'Authorization: Bearer\n' + 'abcdefghijklmnopqrstuvwxyz012345',
      ['token', 'abc12345abc12345'].join('='),
    ];
    const ordinary = ['a'.repeat(40), 'longlonglonglonglong', 'next', 'Step 2: chmod 600', '0123456789abcdef0123456789abcdef01234567'];
    const texts = secrets.flatMap((secret) => [
      secret,
      `before ${secret} after`,
      `deploy ${secret}\n${ordinary.join('\n')}`,
      `${secret}\n\n${ordinary.join('\n')}`,
    ]);
    for (const text of texts) {
      const once = redactSecrets(text);
      expect(redactSecrets(once), JSON.stringify(text)).toBe(once);
    }
    // Ordinary lines after a marker already in the text are never touched.
    for (const line of ordinary) {
      for (const lead of ['***REDACTED***', 'deploy ***REDACTED***', `x ${'***REDACTED***'} y`]) {
        const stored = `${lead}\n${line}\nnext`;
        expect(redactSecrets(stored), JSON.stringify(stored)).toBe(stored);
        const escaped = `${lead}\\n${line}`;
        expect(redactSecrets(escaped), JSON.stringify(escaped)).toBe(escaped);
      }
    }
  });

  it('reaches a fixed point on credentials glued together with no separator (#523)', () => {
    // A marker left by one pattern can complete another pattern's match, so a
    // single pass over the list was not idempotent on glued input.
    expect(redactSecrets(`key AKIA${'A'.repeat(16)}${['password', 'hunterZZLEAK99'].join('=')} end`)).not.toContain('hunterZZLEAK99');
    const fragments = [
      `AKIA${'B'.repeat(16)}`, ['password', 'hunter2hunter2'].join('='), ['token', 'abcd1234abcd1234'].join('='),
      'sk-' + 'a1B2'.repeat(6), 'Bearer abcdefghijklmnopqrstuvwxyz012345', `ghp_${'A1b2C3d4'.repeat(4)}`,
      'postgres://u:pw12345678@db/x', 'Authorization:', 'xoxb-1234567890-abcdefghij', 'word', '=', '***REDACTED***',
    ];
    // Deterministic pseudo-random glue: every pair and a spread of longer chains.
    let seed = 7;
    const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
    const inputs: string[] = [];
    for (const a of fragments) for (const b of fragments) inputs.push(a + b);
    for (let i = 0; i < 3000; i++) {
      let text = '';
      for (let j = 0; j < 2 + (next() % 5); j++) text += fragments[next() % fragments.length];
      inputs.push(text);
    }
    for (const text of inputs) {
      const once = redactSecrets(text);
      expect(redactSecrets(once), JSON.stringify(text)).toBe(once);
    }
  });

  describe('a private-key region is sensitive as a whole (#523)', () => {
    const REDACTED = '***REDACTED***';
    const gen = (type: 'rsa' | 'ec', format: 'pkcs8' | 'sec1') => generateKeyPairSync(type as 'rsa', (type === 'rsa'
      ? { modulusLength: 2048, privateKeyEncoding: { type: format, format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }
      : { namedCurve: 'P-256', privateKeyEncoding: { type: format, format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }) as never);
    const pem = (key: { privateKey: string | Buffer }) => String(key.privateKey).trim().split('\n');
    const keys: Record<string, string[]> = {
      'rsa-2048 pkcs8': pem(gen('rsa', 'pkcs8')),
      'ec p256 pkcs8': pem(gen('ec', 'pkcs8')),
      'ec p256 sec1': pem(gen('ec', 'sec1')),
    };
    const wrap = (body: string, widths: number[]): string[] => {
      const lines: string[] = [];
      for (let i = 0, w = 0; i < body.length; w++) {
        const width = widths[Math.min(w, widths.length - 1)];
        lines.push(body.slice(i, i + width));
        i += width;
      }
      return lines;
    };
    const parts = (lines: string[]) => ({ header: lines[0], end: lines[lines.length - 1], body: lines.slice(1, -1).join('') });
    const marker = (kind: string) => `-----${kind} RSA ${'PRIV' + 'ATE'} KEY-----`;
    // A key line carrying junk: the characters that ended the old line-by-line rule.
    const junk = ['",', '\\",', '"}', '"]', '":', '\\"}', '\\"]', '\\":', ' "x'];

    it.each(Object.entries(keys))('%s: a BEGIN..END block is masked whole, junk inside it included; text before and after stays', (_name, lines) => {
      const { header, end, body } = parts(lines);
      for (const widths of [[64], [1], [7], [8, 64]]) {
        for (const j of junk) {
          const bodyLines = wrap(body, widths);
          bodyLines[1] += j;
          bodyLines[bodyLines.length - 1] += j;
          const text = `Saved it.\n${[header, ...bodyLines, end].join('\n')}\nNext: rotate it. "quoted", done.`;
          expect(redactSecrets(text), `wrap ${widths} junk ${JSON.stringify(j)}`).toBe(`Saved it.\n${REDACTED}\nNext: rotate it. "quoted", done.`);
        }
      }
    });

    it.each(Object.entries(keys))('%s: with no END line, everything from the header to the end of the text is masked, whatever the wrap, line break, prefix or junk', (_name, lines) => {
      const { header, body } = parts(lines);
      const wraps: number[][] = [[1], [2], [3], [7], [8], [12], [15], [64], [2, 8, 64], [4, 12], [7, 8], [1, 64], [8, 64]];
      const breaks = ['\n', '\r\n', '\\n', '\\r\\n', ' ', ' ', '\\\\n'];
      const prefixes = ['', '> ', '# ', '-', '+', '> # '];
      for (const widths of wraps) {
        for (const sep of breaks) {
          for (const prefix of prefixes) {
            const at = `wrap ${widths} / ${JSON.stringify(sep)} / prefix ${JSON.stringify(prefix)}`;
            const text = [header, ...wrap(body, widths).map((l) => prefix + l)].join(sep);
            expect(redactSecrets(text), at).toBe(REDACTED);
            // Prose after the body is part of the unterminated region: it is masked too.
            expect(redactSecrets(`Saved it.\n${text}${sep}${prefix}(then) chmod 600`), at).toBe(`Saved it.\n${REDACTED}`);
          }
        }
      }
    });

    it.each(Object.entries(keys))('%s: junk in a key line, and a short last line with trailing text, leave no fragment (raw text, no END)', (_name, lines) => {
      const { header, body } = parts(lines);
      const bodyLines = wrap(body, [64]);
      for (const j of junk) {
        const withJunk = [...bodyLines];
        withJunk[1] += j;
        expect(redactSecrets([header, ...withJunk].join('\n')), `junk ${JSON.stringify(j)}`).toBe(REDACTED);
      }
      for (const tail of [1, 2, 5, 10, 15, 16, 30]) {
        const last = bodyLines[bodyLines.length - 1].slice(0, tail);
        expect(redactSecrets([header, ...bodyLines.slice(0, -1), `${last} "x`].join('\n')), `tail ${tail}`).toBe(REDACTED);
      }
    });

    it.each(Object.entries(keys))('%s: body on the header line, blank lines, Proc-Type and DEK-Info headers, chunks joined by blanks or tabs', (_name, lines) => {
      const { header, body } = parts(lines);
      const bodyLines = wrap(body, [64]);
      const spaced = (gap: string) => bodyLines.map((l) => (l.match(/.{1,8}/g) ?? []).join(gap));
      const shapes: Record<string, string> = {
        'body on the header line': `${header} ${bodyLines.join(' ')}`,
        'chunk directly after the header': `${header}${body.slice(0, 8)}\n${wrap(body.slice(8), [64]).join('\n')}`,
        'quote on the header line': `${header} note "x\n${bodyLines.join('\n')}`,
        'blank line after the header': [header, '', ...bodyLines].join('\n'),
        'two blank lines': [header, '', '', ...bodyLines].join('\n'),
        'blank lines between body lines': [header, ...bodyLines.flatMap((l) => [l, ''])].join('\n'),
        'blank line before Proc-Type': [header, '', 'Proc-Type: 4,ENCRYPTED', 'DEK-Info: AES-128-CBC,0123456789ABCDEF0123456789ABCDEF', '', ...bodyLines].join('\n'),
        'Proc-Type with CRLF': [header, 'Proc-Type: 4,ENCRYPTED', 'DEK-Info: AES-128-CBC,0123456789ABCDEF0123456789ABCDEF', '', ...bodyLines].join('\r\n'),
        'chunks joined by a blank': [header, ...spaced(' ')].join('\n'),
        'chunks joined by a tab': [header, ...spaced('\t')].join('\n'),
      };
      for (const [name, text] of Object.entries(shapes)) expect(redactSecrets(text), name).toBe(REDACTED);
    });

    /** `value` with every string and every key name at any depth replaced by the marker (` (2)`… on a clash); numbers and structure kept. */
    const maskStrings = (value: unknown): unknown => typeof value === 'string' ? REDACTED
      : Array.isArray(value) ? value.map(maskStrings)
        : value !== null && typeof value === 'object'
          ? Object.fromEntries(Object.values(value).map((v, i) => [i === 0 ? REDACTED : `${REDACTED} (${i + 1})`, maskStrings(v)]))
          : value;
    /** No body line, nor its first 40 characters, survives anywhere in `out`. */
    const expectNoBody = (out: string, bodyLines: string[], name: string) => {
      for (const line of bodyLines) expect(out, name).not.toContain(line.slice(0, 40));
    };

    it.each(Object.entries(keys))('%s: in a JSON document, a whole key masks its own string; part of a key masks every string value', (_name, lines) => {
      const { header, end, body } = parts(lines);
      const bodyLines = wrap(body, [64]);
      const withJunk = [...bodyLines];
      withJunk[1] += '",';
      withJunk[2] += '\\"}';
      const value = (k: string) => ({ before: 'a "quoted" sibling, with , } ] :', k, n: 1, after: ['x', 'y'], nested: { inner: 'keep "this"' } });
      // A BEGIN..END block inside one string: only that string changes.
      for (const indent of [undefined, 2]) {
        const out = redactSecrets(JSON.stringify(value(`Saved it.\n${[header, ...withJunk, end].join('\n')}\nEnd.`), null, indent));
        expect(JSON.parse(out), `whole key / indent ${indent}`).toEqual(value(`Saved it.\n${REDACTED}\nEnd.`));
      }
      // A header with no END: the rest of the key may sit in any other string.
      const partial: Record<string, string> = {
        'header and body, no END': [header, ...bodyLines].join('\n'),
        'junk in key lines': [header, ...withJunk].join('\n'),
        'short tail and a blank': [header, ...bodyLines.slice(0, -1), `${bodyLines[bodyLines.length - 1].slice(0, 5)} `].join('\n'),
        'quotes on the header line': `${header} "a", 'b' "c"\n${bodyLines.join('\n')}`,
        'CRLF and prefixes': [header, ...bodyLines].map((l) => `> ${l}`).join('\r\n'),
        'prose before, none after': `Saved it.\n${[header, ...bodyLines].join('\n')}\nEnd.`,
      };
      for (const [name, text] of Object.entries(partial)) {
        for (const indent of [undefined, 2]) {
          const out = redactSecrets(JSON.stringify(value(text), null, indent));
          expect(JSON.parse(out), `${name} / indent ${indent}`).toEqual(maskStrings(value(text)));
          expectNoBody(out, bodyLines, name);
        }
      }
      // A key in a JSON string cut before the closing quote is not JSON: the raw rule masks to the end of the text.
      const cut = JSON.stringify({ k: [header, ...bodyLines].join('\n'), n: 1 }).slice(0, -8);
      expect(redactSecrets(cut)).toBe(`{"k":"${REDACTED}`);
    });

    it.each(Object.entries(keys))('%s: a key split across the strings of a JSON document is masked wherever its parts sit (#565)', (_name, lines) => {
      const { header, end, body } = parts(lines);
      const bodyLines = wrap(body, [64]);
      const lined = bodyLines.map((l) => `${l}\n`);
      const shapes: Array<[string, string]> = [
        ['array, no END element', JSON.stringify(['before', `${header}\n`, ...lined, 'End.', 42, true, null, { safe: 'x' }])],
        ['array, END element', JSON.stringify(['before', `${header}\n`, ...lined, `${end}\n`, 'after', 42])],
        ['array, junk in an element', JSON.stringify([`${header}\n`, ...bodyLines.map((l, i) => (i === 1 ? `${l}",\n` : `${l}\n`)), `${end}\n`])],
        ['array, CRLF elements', JSON.stringify([`${header}\r\n`, ...lined.map((l) => l.replace(/\n$/, '\r\n')), 'End.'])],
        ['array, splitlines elements', JSON.stringify([header, ...bodyLines, 'End.'])],
        ['array, chunks', JSON.stringify([`${header}\n${bodyLines[0]}`, ...bodyLines.slice(1), end])],
        ['array, header with text after it', JSON.stringify([`${header} saved below`, ...bodyLines])],
        ['array, a whole block then a second header', JSON.stringify([`${header}\nAAAA\n${end}\n${header}`, ...bodyLines, end])],
        ['array, a whole block then a second header, no END', JSON.stringify([`${header}\nAAAA\n${end}\n${header}`, ...bodyLines])],
        ['array, END before BEGIN in one string', JSON.stringify([`${end} then ${header}`, ...bodyLines])],
        ['array, a quoted fake END on the header line', JSON.stringify([`${header} "${end}"`, ...bodyLines, end])],
        ['object fields', JSON.stringify({ a: `${header}\n`, b: bodyLines.join('\n'), c: 1 })],
        ['integer keys in reverse', `{"2":${JSON.stringify(end)},"1":${JSON.stringify(bodyLines.join('\n'))},"0":${JSON.stringify(header)}}`],
        ['nested arrays', JSON.stringify([[header], ...bodyLines.map((l) => [l]), [end]])],
        ['array of objects', JSON.stringify([{ t: header }, ...bodyLines.map((t) => ({ t })), { t: end }])],
        ['a header in a key name', JSON.stringify({ [header]: 1, b: bodyLines.join('\n') })],
        ['JSON inside a JSON string', JSON.stringify({ inner: JSON.stringify({ a: header, b: bodyLines.join('\n') }) })],
        ['no BEGIN, no escape: the body and its END in separate fields', JSON.stringify({ b: bodyLines.join(' '), e: end })],
      ];
      for (const [name, text] of shapes) {
        for (const indent of [undefined, 2]) {
          const input = indent === undefined ? text : JSON.stringify(JSON.parse(text), null, indent);
          const out = redactSecrets(input);
          expectNoBody(out, bodyLines, name);
          // Every string and key name is the marker; numbers and structure are the input's.
          expect(JSON.parse(out), name).toEqual(maskStrings(JSON.parse(input)));
        }
      }
      // Numbers, booleans, null and the structure stay.
      expect(JSON.parse(redactSecrets(shapes[0][1]))).toEqual(['before', `${header}\n`, ...lined, 'End.', 42, true, null, { safe: 'x' }].map(maskStrings));
      // A whole key inside one string leaves the other strings alone; no key changes nothing.
      expect(JSON.parse(redactSecrets(JSON.stringify([[header, ...bodyLines, end].join('\n'), 'kept', 42])))).toEqual([REDACTED, 'kept', 42]);
      expect(redactSecrets(JSON.stringify(['a', 'MIIE\n', 7]))).toBe(JSON.stringify(['a', 'MIIE\n', 7]));
      // The same rule for strings stored together outside JSON: a memory's observations.
      for (const list of [[header, ...bodyLines, end], [...bodyLines, end], ['note', `${header}\n${bodyLines[0]}`, ...bodyLines.slice(1)]]) {
        const out = redactSecretList(list);
        expect(out).toEqual(list.map(() => REDACTED));
      }
      expect(redactSecretList(['a', [header, ...bodyLines, end].join('\n'), 'b'])).toEqual(['a', REDACTED, 'b']);
    });

    it('every credential family: a shadowed duplicate or a key name holding it is never returned (#523)', () => {
      const { header, end, body } = parts(keys['ec p256 pkcs8']);
      const r = (n: number) => 'Q7x'.repeat(Math.ceil(n / 3)).slice(0, n);
      // [family, credential, a part of it that must not survive]; assembled at runtime.
      const families: Array<[string, string, string]> = [
        ['private key', [header, ...wrap(body, [64]), end].join('\n'), body.slice(0, 40)],
        ['connection string', ['postgres://u', `pw${r(10)}@db/x`].join(':'), `pw${r(10)}`],
        ['JWT', ['eyJ' + r(12), r(12), r(12)].join('.'), r(12)],
        ['SendGrid', ['SG', r(20), r(20)].join('.'), r(20)],
        ['Stripe', `sk_${'live'}_${r(20)}`, r(20)],
        ['npm', `npm_${r(36)}`, r(36)],
        ['sk-', `sk-${r(24)}`, r(24)],
        ['Bearer', `Bearer ${r(24)}`, r(24)],
        ['name=value', `password=${r(12)}`, r(12)],
        ['GitHub classic', `ghp_${r(32)}`, r(32)],
        ['GitHub OAuth', `gho_${r(32)}`, r(32)],
        ['GitHub app', `ghs_${r(32)}`, r(32)],
        ['GitHub fine-grained', `github_pat_${r(24)}`, r(24)],
        ['AWS', `AKIA${'Q7X9'.repeat(4)}`, 'Q7X9'.repeat(4)],
        ['Google', `AIza${r(32)}`, r(32)],
        ['Slack', `xoxb-${r(16)}`, r(16)],
      ];
      for (const [family, credential, part] of families) {
        const q = JSON.stringify(credential);
        const shapes = [
          `{"k":${q},"k":"x"}`,
          `{"a":{"k":${q},"k":"x"},"b":1}`,
          `[{"k":${q},"k":"x"}]`,
          `{ "k" : ${q},\n  "k" : "x" }`,
          `{"k":"${[...credential].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')}","k":"x"}`,
          `{${q}:1}`,
          `{"a":[{${q}:{"n":2}}]}`,
        ];
        for (const shape of shapes) {
          const out = redactSecrets(shape);
          expect(out, `${family}: ${shape.slice(0, 60)}`).not.toContain(part);
          expect(redactSecrets(out), family).toBe(out);
        }
      }
    });

    it('key names that redact to one name keep every value', () => {
      const sk = (n: number) => `sk-${'abcd1234'}${n}x`;
      for (const doc of [
        `{"${REDACTED}":111,"${sk(1)}":222}`,
        `{"${sk(1)}":111,"${REDACTED}":222,"${sk(2)}":333}`,
        `{"${REDACTED}":111,"${sk(1)}":222,"k":"${marker('END')}"}`,
      ]) {
        const numbers = (o: Record<string, unknown>) => Object.values(o).filter((v) => typeof v === 'number').sort();
        expect(numbers(JSON.parse(redactSecrets(doc))), doc).toEqual(numbers(JSON.parse(doc)));
      }
    });

    it('glued credentials of any length, and chains of them: every body is masked', () => {
      const body = (n: number, seed: string) => seed.repeat(Math.ceil(n / seed.length)).slice(0, n);
      const jwt = (headerLength: number, seed: string) => ['eyJ' + body(headerLength - 3, seed), body(40, seed), body(43, seed)].join('.');
      for (const headerLength of [255, 256, 257, 512, 4096]) {
        const glued = `${jwt(headerLength, 'Aa1')}${jwt(headerLength, 'Zq9')}`;
        expect(redactSecrets(glued), `JWT header ${headerLength}`).not.toMatch(/Zq9Zq9|Aa1Aa1/);
      }
      const bearer = `Bearer ${body(4096, 'Aa1')}Bearer ${body(4096, 'Zq9')}`;
      expect(redactSecrets(bearer)).not.toMatch(/Zq9Zq9|Aa1Aa1/);
      const chain = ['Aa1', 'Bb2', 'Cc3', 'Dd4', 'Ee5'].map((seed) => jwt(600, seed)).join('');
      expect(redactSecrets(chain)).not.toMatch(/(Aa1|Bb2|Cc3|Dd4|Ee5){2}/);
      const crossFamily = `${jwt(300, 'Aa1')}ghp_${body(40, 'Zq9')}sk-${body(30, 'Yy7')}`;
      expect(redactSecrets(crossFamily)).not.toMatch(/Zq9Zq9|Aa1Aa1|Yy7Yy7/);
    });

    it('a key or name=value glued after another credential: its tail is masked; ordinary text after a token stays (#523 r18)', () => {
      const r = (n: number, seed: string) => seed.repeat(Math.ceil(n / seed.length)).slice(0, n);
      // No single pattern covers any of these whole: each first token stops where the second begins.
      const masked: Array<[string, string]> = [
        ['ghp then sk-', `ghp_${r(36, 'Aa1')}sk-proj-${r(30, 'Zq9')}`],
        ['github_pat then sk-', `github_pat_${r(30, 'Aa1')}sk-${r(30, 'Zq9')}`],
        ['ghp then token=', `ghp_${r(36, 'Aa1')}token=${r(24, 'Zq9')}`],
        ['ghp then a masked sk- key', `ghp_${r(36, 'Aa1')}sk-proj-****${r(12, 'Zq9')}`],
        ['AKIA then sk-', `AKIA${r(16, 'AB12')}sk-${r(30, 'Zq9')}`],
        ['AKIA then password=', `AKIA${r(16, 'AB12')}password=${r(24, 'Zq9')}`],
        ['JWT then token=', `${['eyJ' + r(30, 'Aa1'), r(20, 'Aa1'), r(24, 'Aa1')].join('.')}&token=${r(24, 'Zq9')}`],
      ];
      for (const [name, text] of masked) {
        const out = redactSecrets(text);
        expect(out, name).not.toMatch(/Zq9Zq9|Aa1Aa1/);
        expect(redactSecrets(out), name).toBe(out);
      }
      const ghp = `ghp_${r(36, 'Aa1')}`;
      for (const [name, tail] of [['-abcdefgh', '-abcdefgh'], ['=ordinary', '=ordinary'], ['.v2', '.v2'], [' and more prose', ' and more prose']]) {
        expect(redactSecrets(`${ghp}${tail}`), name).toBe(`${REDACTED}${tail}`);
      }
      // A JWT whose last segment holds the start of another one: a start inside the first
      // match that ends at the same place must not skip the one that ends later.
      const nestedJwt = `eyJAAeyJ${'A'.repeat(8)}.${'B'.repeat(8)}.CCCCeyJ${'D'.repeat(8)}.${r(9, 'Zq9')}.${r(9, 'Yy7')}`;
      expect(redactSecrets(nestedJwt)).not.toMatch(/Zq9|Yy7/);
      // A glued key that runs to the end of the text takes in every span after it: one marker, not two.
      expect(redactSecrets(`ghp_${r(36, 'Aa1')}sk-${r(10, 'q')}AKIA${r(16, 'AB12')}zzzzz`)).toBe(REDACTED);
      const conn = ['postgres://appuser', `${r(12, 'Aa1')}@db.example.com:5432/app`].join(':');
      expect(redactSecrets(conn)).toBe(`${REDACTED}db.example.com:5432/app`);
      expect(redactSecrets('task-runner and disk-usage and mytoken=abcdefghijkl')).toBe('task-runner and disk-usage and mytoken=abcdefghijkl');
    });

    it('r19: a chain of glued sk- and token= credentials is masked in time linear in its length', () => {
      // Each unit ends in a backslash: the sk- run stops there, and the next unit is only reached through token=.
      const chain = (n: number) => `ghp_${'A'.repeat(36)}${'sk-AAAAAAA&xtoken=BBBBBBBB\\x'.repeat(n)} prose`;
      expect(chain(8000).length).toBeGreaterThan(224_000);
      const started = Date.now();
      const out = redactSecrets(chain(8000));
      expect(Date.now() - started).toBeLessThan(1000);
      expect(out).toBe(`${REDACTED} prose`);
      expect(redactSecrets(chain(3))).toBe(`${REDACTED} prose`);
    });

    it('r19: escapes are read 8 levels deep; text escaped deeper is masked on its own, never its siblings', () => {
      const wrap = (levels: number) => { let t = 'ordinary café'; for (let i = 0; i < levels; i++) t = JSON.stringify(t); return t; };
      // wrap(n) quotes n times: n - 1 levels of escapes.
      expect(holdsSecret([wrap(9)])).toBe(false);
      expect(redactSecrets(wrap(9))).toBe(wrap(9));
      expect(redactSecretList([wrap(10), 'innocent sibling'])).toEqual([REDACTED, 'innocent sibling']);
      expect(redactSecretList([wrap(10).replace('ordinary café', 'token=abcdefghijkl'), 'innocent sibling'])).toEqual([REDACTED, 'innocent sibling']);
    });

    it('overlapping matches cost a bounded amount, and past the bound the rest is masked, never kept', () => {
      const pathological = 'sk-'.repeat(333_333);
      let started = Date.now();
      expect(redactSecrets(pathological)).not.toContain('sk-sk-');
      expect(Date.now() - started).toBeLessThan(2000);
      const tokens = Array.from({ length: 25_000 }, (_, i) => `ghp_${'A'.repeat(32)}${i.toString(36)}`).join(' ');
      started = Date.now();
      const out = redactSecrets(tokens);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(out).not.toContain('ghp_');
      // A JWT is made of segments, so its overlapping matches are not skipped
      // ahead: here every `eyJ` starts a match running to the end, and the cap
      // is what keeps it linear.
      const segmented = `${'eyJ'.repeat(40_000)}.${'b'.repeat(8)}.${'c'.repeat(8)}`;
      started = Date.now();
      expect(redactSecrets(segmented)).toBe(REDACTED);
      expect(Date.now() - started).toBeLessThan(2000);
      // A tail that no key can end in, after many `sk-` starts: each run is searched twice, not once per start.
      const tail = `${'sk-'.repeat(1400)}A${'*'.repeat(800_000)}`;
      started = Date.now();
      expect(redactSecrets(tail).startsWith(REDACTED)).toBe(true);
      expect(Date.now() - started).toBeLessThan(2000);
      // Ordinary prose around credentials is untouched by the bound.
      expect(redactSecrets(`keep this ${'ghp_' + 'A'.repeat(36)} and this`)).toBe(`keep this ${REDACTED} and this`);
    });

    it('two credentials glued together: the second one is masked too, not only the start of the first', () => {
      const r = (n: number, seed: string) => seed.repeat(Math.ceil(n / seed.length)).slice(0, n);
      // Each pair: the first token's run swallows the second token's prefix.
      const families: Array<[string, (body: string) => string, number]> = [
        ['GitHub classic', (b) => `ghp_${b}`, 32],
        ['GitHub OAuth', (b) => `gho_${b}`, 32],
        ['GitHub app', (b) => `ghs_${b}`, 32],
        ['Stripe', (b) => `sk_${'live'}_${b}`, 24],
        ['SendGrid', (b) => ['SG', b.slice(0, 20), b.slice(0, 22)].join('.'), 24],
        ['JWT', (b) => ['eyJ' + b.slice(0, 33), b.slice(0, 20), b.slice(0, 24)].join('.'), 40],
        ['Bearer', (b) => `Bearer ${b}`, 24],
      ];
      for (const [family, make, length] of families) {
        const first = make(r(length, 'Aa1'));
        const second = make(r(length, 'Zq9'));
        for (const glued of [`${first}${second}`, `${first} ${second}`, `note: ${first}${second} end`]) {
          const out = redactSecrets(glued);
          expect(out, `${family}: ${glued.slice(0, 40)}`).not.toMatch(/Zq9Zq9|Aa1Aa1/);
          expect(redactSecrets(out), family).toBe(out);
        }
      }
    });

    it('key names under the trigger, and many keys that redact to one name', () => {
      const { end, body } = parts(keys['ec p256 pkcs8']);
      const bodyLines = wrap(body, [64]);
      // A key line in a key name, its END in a value: the key names are masked too.
      const out = redactSecrets(JSON.stringify(Object.fromEntries([...bodyLines.map((l, i) => [l, i]), ['k', end]])));
      for (const line of bodyLines) expect(out).not.toContain(line.slice(0, 40));
      // 20,000 key names that all redact to the marker: each gets its own suffix, in linear time.
      const many = JSON.stringify(Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`sk-${'abcd'}${i}x`, i])));
      const started = Date.now();
      const masked = JSON.parse(redactSecrets(many)) as Record<string, number>;
      expect(Date.now() - started).toBeLessThan(2000);
      expect(Object.keys(masked)).toHaveLength(20_000);
      expect(masked[`${REDACTED} (20000)`]).toBe(19_999);
    });

    it('duplicate keys, credentials in key names, and number spelling', () => {
      const TOKEN = ['token', 'abc123abc123abc123'].join('=');
      const { header, end, body } = parts(keys['rsa-2048 pkcs8']);
      const bodyLines = wrap(body, [64]);
      const pem = [header, ...bodyLines, end].join('\n');
      const conn = ['postgres://admin', `${'hunter2'}pw@db/prod`].join(':');
      const escaped = (text: string) => [...text].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
      // JSON.parse keeps only the last of duplicate keys; the earlier value is never stored.
      for (const [name, text] of [
        ['connection string', `{"url":${JSON.stringify(conn)},"url":"none"}`],
        ['private key', `{"k":${JSON.stringify(pem)},"k":"x"}`],
        ['private key, every character \\u-escaped', `{"k":"${escaped(pem)}","k":"x"}`],
        ['connection string, every character \\u-escaped, nested', `{"a":{"u":"${escaped(conn)}","u":"none"}}`],
      ] as const) {
        const out = redactSecrets(text);
        expect(out, name).not.toContain('hunter2');
        expectNoBody(out, bodyLines, name);
        expect(redactSecrets(out), name).toBe(out);
      }
      // A key name is redacted like any string; one that would land on a sibling's name is kept beside it.
      expect(JSON.parse(redactSecrets(JSON.stringify({ [pem]: 1, keep: 'x' })))).toEqual({ [REDACTED]: 1, keep: 'x' });
      expect(redactSecrets(JSON.stringify({ [conn]: { x: 1 } }))).not.toContain('hunter2');
      expect(JSON.parse(redactSecrets(`{${JSON.stringify(`sk-${'abcd1234'}`)}:1,${JSON.stringify(REDACTED)}:2}`))).toEqual({ [REDACTED]: 1, [`${REDACTED} (2)`]: 2 });
      // `__proto__` stays an own key, with its value redacted.
      const proto = JSON.parse(redactSecrets(`{"__proto__":{"t":${JSON.stringify(TOKEN)}},"y":1}`));
      expect(Object.keys(proto)).toEqual(['__proto__', 'y']);
      expect(Object.getOwnPropertyDescriptor(proto, '__proto__')?.value).toEqual({ t: REDACTED });
      // A document that is written again keeps every number as spelled.
      expect(redactSecrets(`{"a":12345678901234567890,"b":1e400,"c":-0,"d":1.50,"e":[1E5,0.1],"s":${JSON.stringify(TOKEN)}}`))
        .toBe(`{"a":12345678901234567890,"b":1e400,"c":-0,"d":1.50,"e":[1E5,0.1],"s":"${REDACTED}"}`);
      // With nothing to redact and no escape, the text comes back byte for byte.
      const untouched = '{ "a" : 12345678901234567890,\n  "b": ["x" ,  "y"] }';
      expect(redactSecrets(untouched)).toBe(untouched);
      // JSON too deep to read or walk cannot be checked, so none of it is kept.
      const deep = `${'['.repeat(12_000)}"${escaped(`${header}\n${bodyLines.join('\n')}`)}"${']'.repeat(12_000)}`;
      expect(redactSecrets(deep)).toBe(REDACTED);
    });

    it('dispositions: what a fake or quoted header keeps and what it masks', () => {
      const header = marker('BEGIN');
      const end = marker('END');
      const dispositions: Array<[string, string, string]> = [
        ['a header quoted in prose masks the rest of the text (local prose loss, disclosed)', `The file must start with ${header}\nStep 2: chmod 600\nStep 3: ssh-add it`, `The file must start with ${REDACTED}`],
        ['a lone header', header, REDACTED],
        ['a canonical example keeps the text before it and after its END', `Format:\n\n${header}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw\n${end}\n\nThen run ssh-add.`, `Format:\n\n${REDACTED}\n\nThen run ssh-add.`],
        ['a fake header followed later by a genuine END masks through that END', `Use ${header} like so.\nStep 2: chmod 600\n${end}\nDone. Step 3: ssh-add it`, `Use ${REDACTED}\nDone. Step 3: ssh-add it`],
        ['two headers and one END: masked through the END', `${header}\nAAAA\n${header}\nBBBB\n${end}\nafter`, `${REDACTED}\nafter`],
        ['a header after a genuine block masks from there on', `${header}\nAAAA\n${end}\nkept line\n${header}\nlost line`, `${REDACTED}\nkept line\n${REDACTED}`],
        ['no header: prose is untouched', 'The private key file lists BEGIN and END lines, then "quoted", stuff.', 'The private key file lists BEGIN and END lines, then "quoted", stuff.'],
        ['a public key or certificate block is not a private key', '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0B\n-----END PUBLIC KEY-----\nCERT', '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0B\n-----END PUBLIC KEY-----\nCERT'],
      ];
      for (const [name, text, expected] of dispositions) expect(redactSecrets(text), name).toBe(expected);
    });

    it('redacting twice is redacting once, for raw text, JSON documents and arrays', () => {
      const { header, end, body } = parts(keys['rsa-2048 pkcs8']);
      const bodyLines = wrap(body, [64]);
      const corpus = [
        [header, ...bodyLines].join('\n'),
        `Saved.\n${[header, ...bodyLines, end].join('\n')}\nafter`,
        [header, ...bodyLines.slice(0, -1), `${bodyLines[0].slice(0, 5)} "x`].join('\n'),
        JSON.stringify({ k: [header, ...bodyLines].join('\n'), n: 1 }),
        JSON.stringify([`${header}\n`, ...bodyLines.map((l) => `${l}\n`), 'End.'], null, 2),
        JSON.stringify({ a: `${'AKIA' + 'B'.repeat(16)}password=${'hunter2hunter2'}`, b: [1, 'x'] }),
        `${header} "x", `.repeat(50),
        'plain text with no secret',
        '{"a":1}',
      ];
      for (const text of corpus) {
        const once = redactSecrets(text);
        expect(redactSecrets(once), text.slice(0, 50)).toBe(once);
      }
    });

    it('stays linear: 990 KB of repeated headers, and a fake header followed by 1 MB of prose, finish well inside the hook budget', () => {
      const header = marker('BEGIN');
      const shapes: Array<[string, string]> = [];
      for (const unit of [`${header} "a", `, `${header} "`, `${header}\n\n`, `${header}\n> \n`, `${header} x`]) {
        shapes.push([JSON.stringify(unit.slice(-14)), unit.repeat(Math.ceil(990_000 / unit.length))]);
      }
      shapes.push(['fake header then 1 MB of prose', `${header} is what ssh-keygen writes.\n${'Some prose, with "quotes" and more words.\n'.repeat(25_000)}`]);
      shapes.push(['1 MB of prose, no header', 'Some prose, with "quotes" and more words.\n'.repeat(25_000)]);
      for (const [name, text] of shapes) {
        const started = Date.now();
        redactSecrets(text);
        expect(Date.now() - started, name).toBeLessThan(2000);
      }
    });
  });

  it('catches a Bearer token split by a JSON-ESCAPED newline (the /v1/doctor shape)', () => {
    // The HTTP egress redacts JSON.stringify output, where a real newline
    // has become the two characters \n — plain \s+ cannot see it, and the
    // two egresses silently disagreed on what they masked.
    const stringified = JSON.stringify({ detail: 'Bearer\nabcdefghijklmnopqrstuvwxyz012345' });
    const out = redactSecrets(stringified);
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz012345');
  });

  it('leaves near-miss prose alone', () => {
    const prose = [
      'the ghost in the machine',           // ghp_-adjacent prose
      'skimming the surface of sk8er culture',
      'visit https://example.com/AKIAtutorial-page', // AKIA followed by lowercase
      'Bearer of good news arrived today',  // short tail, no 16-char token
      'a word:another@host mention',        // no scheme anchor
    ].join(' ');
    expect(redactSecrets(prose)).toBe(prose);
  });

  it('composes with path redaction the way both egresses call it', () => {
    // Both public egresses run redactUserPaths(redactSecrets(text)) — this
    // pins that the composition masks the credential AND the identifying
    // path in one pass, so neither redactor undoes the other's work.
    const home = os.homedir();
    const input = `key sk-ant-${'a1B2'.repeat(6)} found in ${home}/project/config.json`;
    const out = redactUserPaths(redactSecrets(input));
    expect(out).toContain('***REDACTED***');
    expect(out).not.toContain('a1B2'.repeat(6));
    expect(out, 'the machine-identifying home path must be gone too').not.toContain(home);
  });

  it('the shared pattern list is what this suite exercised', () => {
    // Guard-the-guard: if a pattern is added to SECRET_PATTERN_SOURCES
    // without a sample here, this count goes stale and forces the author
    // to add one. Update BOTH when the list grows.
    expect(SECRET_PATTERN_SOURCES.length).toBe(16);
  });
});

/**
 * The other half of the contract. redactSecrets runs over
 * `JSON.stringify(doctorResult)` for the WHOLE doctor payload, which is full
 * of credential-shaped strings that are not credentials: commit SHAs,
 * `sha256:` digests, installation ids, hook marker hashes, model names.
 *
 * Over-redaction here is not a cosmetic problem. A pattern of `.` once
 * compiled from a relative DB path and replaced every literal dot in the
 * payload — `4.5.0` was published as `4~5~0` — and nothing in the output
 * said redaction had done it. A corrupted diagnostic is worse than a verbose
 * one, because the reader cannot tell it is corrupt.
 *
 * The corpus is real `runDoctor` output captured against a throwaway
 * MEMESH_DIR, plus the diagnostic shapes this project's own evidence
 * artifacts carry. Any new pattern must leave every byte of it alone.
 */
describe('redactSecrets does not corrupt diagnostics', () => {
  const corpus = JSON.parse(
    fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/redaction-negative-corpus.json'),
      'utf8',
    ),
  ) as { doctorOutput: string; mustSurvive: string[] };

  it('leaves a real doctor payload byte-identical', () => {
    expect(corpus.doctorOutput.length).toBeGreaterThan(1000);
    expect(redactSecrets(corpus.doctorOutput)).toBe(corpus.doctorOutput);
  });

  it.each(corpus.mustSurvive.map((line) => [line.slice(0, 48), line]))(
    'leaves %s… untouched',
    (_label, line) => {
      expect(redactSecrets(line)).toBe(line);
    },
  );

  it('keeps the parameter name when the value is a credential', () => {
    // `?limit=200` must survive: the pattern matches the NAME, so an
    // ordinary query parameter is not collateral.
    const url = 'GET https://api.openai.com/v1/models?limit=200&api_key=A1b2C3d4E5f6G7h8I9j0';
    const out = redactSecrets(url);
    expect(out).toContain('limit=200');
    expect(out).not.toContain('A1b2C3d4E5f6G7h8I9j0');
  });

  it('ends a masked-key match on an alphanumeric, leaving sentence punctuation', () => {
    // `sk[-_]\S{4,}[A-Za-z0-9]` must not swallow the full stop, or the
    // redacted sentence loses its boundary and reads as one run-on.
    const out = redactSecrets('Incorrect API key provided: sk-proj-****ZfQ9. Find it at platform.openai.com.');
    expect(out).toContain('***REDACTED***. Find it at');
  });
});

/**
 * The pattern list has a THIRD consumer that the egress tests never exercised,
 * and it is a DROP gate rather than a masking one: `dreamer.ts:238` reads
 * `redactSecrets(s) !== s` as "this text is secret-shaped" and refuses the whole
 * submitted result with `secret_shaped_result`. A pattern that is merely noisy at
 * the egress destroys content there.
 *
 * This comment used to name `containsSecret()` in transcript-extractor. No such
 * function exists — `grep -rn containsSecret src/ scripts/ tests/` finds only
 * these comments — and the same false name was in `src/core/paths.ts` until it
 * was corrected. A comment that invents its own evidence is worse than none: it
 * is what a reader checks the design against.
 *
 * That is not hypothetical. `sk[-_]\S{4,}` without a word boundary matched
 * inside `task-runner`, `disk-usage`, `risk-level` and `ask-first`: six
 * ordinary English phrases, every one of them redacted at the egress and
 * dropped on the way in. The corpus above only asserted `redactSecrets`, so
 * it could not see the drop.
 */
describe('the pattern list is safe for the transcript drop gate too', () => {
  const corpusPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/redaction-negative-corpus.json');
  const negatives = (JSON.parse(fs.readFileSync(corpusPath, 'utf8')) as { mustSurvive: string[] }).mustSurvive;

  it.each(negatives.map((line) => [line.slice(0, 44), line]))(
    'does not drop %s…',
    (_label, line) => {
      expect(redactSecrets(line)).toBe(line);
    },
  );

  it('is case-insensitive, like the egress redactor', () => {
    // The drop gate compiled the shared list case-SENSITIVELY while the egress
    // used 'gi'. `DB_PASSWORD=…` therefore passed the gate and reached the LLM
    // prompt while the same bytes were masked on the way out.
    for (const s of ['DB_PASSWORD=hunter2secret', 'export OPENAI_API_KEY=abcdef0123456789', 'SK-ANT-API03-abcdefghij', 'BEARER abcdefghijklmnopqrstuvwxyz0123']) {
      expect(redactSecrets(s) !== s, s).toBe(true);
      expect(redactSecrets(s), s).not.toBe(s);
    }
  });

  it('still drops and scrubs a real credential', () => {
    const secret = 'sk-ant-' + 'a1B2'.repeat(6);
    expect(redactSecrets(`context ${secret} context`) !== `context ${secret} context`).toBe(true);
    expect(redactSecrets(`context ${secret} context`)).not.toContain(secret);
  });

  it('redacts an unusually long credential completely, with no tail left over', () => {
    // Bounding the run (e.g. \S{4,200}) was proposed to cap how much one match
    // can swallow. With the word boundary in place over-matching is no longer
    // the failure mode, and a cap creates the opposite one: this input would
    // redact its first 204 characters and publish the remaining 200.
    const long = 'sk-' + 'a'.repeat(400) + 'Z';
    const out = redactSecrets(`before ${long} after`);
    expect(out).toBe('before ***REDACTED*** after');
    expect(out).not.toContain('aaaa');
  });

  it('stops at a JSON string terminator, so a hit cannot swallow sibling fields', () => {
    // redactSecrets runs over JSON.stringify(doctorResult), which has no
    // whitespace between fields. With `\S{4,}` a repo named `sk-widgets` ran
    // through the closing quote, the comma and the next key, and deleted the
    // sibling `fix` field from the public issue body. The character class now
    // excludes `"` and `\`, which no real key contains.
    const doc = JSON.stringify({ checks: [
      { id: 'database', summary: 'Database opened at /home/me/Projects/sk-widgets/knowledge-graph.db', fix: 'Run: memesh doctor' },
      { id: 'config', summary: 'ok' },
    ] });
    const parsed = JSON.parse(redactSecrets(doc)) as { checks: Array<Record<string, string>> };
    expect(parsed.checks).toHaveLength(2);
    expect(parsed.checks[0].fix).toBe('Run: memesh doctor');
    expect(parsed.checks[0].summary).toContain('/home/me/Projects/');

    // And with a REAL credential in a JSON field, the neighbour row survives.
    const leak = JSON.stringify({ a: { summary: 'Incorrect API key provided: sk-proj-abcdef123456' }, b: { id: 'next', label: 'Hook activity' } });
    const p2 = JSON.parse(redactSecrets(leak)) as { a: { summary: string }; b: { label: string } };
    expect(p2.a.summary).not.toContain('sk-proj');
    expect(p2.b.label).toBe('Hook activity');
  });

  it('matches a name=value credential only as a whole name with a real value', () => {
    // Compound env names are the dominant shape in a shell transcript and
    // must match; prose that merely contains the word must not.
    for (const s of ['DB_PASSWORD=hunter2secret', 'export OPENAI_API_KEY=abcdef0123456789', 'MY-API-KEY=abcdef0123456789']) {
      expect(redactSecrets(s), s).not.toBe(s);
    }
    for (const s of ['is_secret=false', 'signature=valid', 'token=bucket', 'mytoken=abcdef0123456789', 'memesh serve --token=<value>']) {
      expect(redactSecrets(s), s).toBe(s);
    }
  });

  it('requires a word boundary before the key prefix', () => {
    // Removing the leading \b makes every one of these true.
    for (const word of ['task-runner-v2', 'disk-usage-report', 'risk-level-high']) {
      expect(redactSecrets(word) !== word).toBe(false);
    }
    expect(redactSecrets('sk-proj-**********ZfQ9') !== 'sk-proj-**********ZfQ9').toBe(true);
  });
});

describe('a JWT-shaped run that never completes is searched in linear time (#567)', () => {
  it('300 KB of `eyJ` with no dot is redacted in well under a second, unchanged', () => {
    const text = 'eyJ'.repeat(100_000);
    const started = Date.now();
    expect(redactSecrets(text)).toBe(text);
    // Was about 45 s: every `eyJ` rescanned the rest of the run.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a JWT still matches whole, also glued to another one, and a header holding `eyJ` is masked from there', () => {
    const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'].join('.');
    expect(redactSecrets(`a ${jwt} b`)).toBe('a ***REDACTED*** b');
    expect(redactSecrets(`${jwt}${jwt}`)).toBe('***REDACTED***');
    const inner = `eyJhbGciOieyJ0eXAiOiJKV1QifQ.${jwt.split('.').slice(1).join('.')}`;
    const out = redactSecrets(inner);
    expect(out).not.toContain('SflKxwRJ');
    expect(out).toContain('***REDACTED***');
    // Glued to a prefix, with a second `eyJ` inside the header: masked from the first `eyJ`, as before.
    const glued = `prefixeyJ${'A'.repeat(8)}eyJ${'B'.repeat(8)}.${'C'.repeat(8)}.${'D'.repeat(8)}`;
    expect(redactSecrets(glued)).toBe('prefix***REDACTED***');
  });

});

// Redis's usual URL has no username: `redis://:<password>@host`.
describe('a connection string whose username is empty', () => {
  it('is masked', () => {
    const url = ['redis://', ':hunter2hunter2@cache.internal:6379/0'].join('');
    const out = redactSecrets(`cache at ${url} ok`);
    expect(out).not.toContain('hunter2hunter2');
    expect(out).toBe('cache at ***REDACTED***cache.internal:6379/0 ok');
  });
});
