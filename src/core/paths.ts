// Centralised filesystem-path resolution for memesh.
//
// Before this module existed, `process.env.MEMESH_DB_PATH ?? path.join(...)`
// was inlined in 8+ core sites and the HOME-first override (needed for
// hermetic Windows tests) was applied in only 2 of them. Each site
// resolved roughly the same path with subtle differences (`??` vs `||`,
// with/without HOME-first), making path-related drift a recurring source
// of audit findings.
//
// Hooks cannot import from `dist/` (the F5 security boundary — `dist/`
// may be stale or absent at hook execution time), so the build copies this
// leaf module into `scripts/hooks/_generated/`. That generated copy is the
// hook implementation; there is no second hand-maintained identity parser.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';

export const AGENT_ROUTER_SOCKET_FILENAME = 'agent-router-v2.sock';
const LEGACY_AGENT_ROUTER_SOCKET_FILENAME = 'agent-router.sock';

/**
 * Resolve the user's home directory, honouring `HOME` first.
 *
 * On POSIX, `os.homedir()` already consults `HOME`. On Windows it ignores
 * env vars and reads `GetUserProfileDirectoryW` directly, which makes
 * tests unable to redirect home-dir lookups to a tmp dir. Honouring `HOME`
 * first lets tests set `HOME=<tmpdir>` and have it actually take effect
 * across platforms. Production users on Windows almost never set `HOME`,
 * so this falls through to `os.homedir()` unchanged.
 */
export function homeDir(): string {
  // `??` only falls through on null/undefined — an env that exports
  // HOME="" (some Docker base images, some CI sandboxes, broken nss
  // configs) would silently return "" and route memesh's data dir
  // under the process cwd via path.join("", ".memesh") === ".memesh".
  //
  // Three-step fallback:
  //   1. process.env.HOME (most explicit)
  //   2. os.homedir() — but on POSIX this ALSO reads HOME first, so
  //      with HOME="" it returns "" too
  //   3. os.userInfo().homedir — reads pw_dir via getpwuid syscall,
  //      bypassing env vars entirely. Final defence against HOME=""
  //      sandboxes.
  const home = process.env.HOME;
  if (home && home.length > 0) return home;
  const fromOs = os.homedir();
  if (fromOs && fromOs.length > 0) return fromOs;
  return os.userInfo().homedir;
}

/**
 * Resolve the memesh data directory.
 *
 * Precedence: `MEMESH_DIR` env var > `<home>/.memesh`. Note that
 * `MEMESH_DB_PATH` (the more granular override, used when the user wants
 * the DB file at a non-default location) is NOT consulted here — see
 * `getDbPath()` for that. Callers that need the directory containing the
 * active DB file should use `getMemeshDirFromDbPath()` instead.
 */
export function memeshDir(): string {
  return process.env.MEMESH_DIR ?? path.join(homeDir(), '.memesh');
}

/**
 * Resolve the active memesh DB path.
 *
 * Precedence: `MEMESH_DB_PATH` env var > `<memeshDir()>/knowledge-graph.db`.
 * Most callers want this rather than a hand-rolled `process.env.MEMESH_DB_PATH ?? ...`,
 * so they automatically inherit the HOME-first override on Windows tests.
 */
export function getDbPath(): string {
  return process.env.MEMESH_DB_PATH ?? path.join(memeshDir(), 'knowledge-graph.db');
}

/**
 * Resolve the directory containing the active DB file.
 *
 * When `MEMESH_DB_PATH` is set, returns its parent directory. Otherwise
 * returns `memeshDir()`. Use this when you need to write sibling files
 * next to the DB (e.g. session tracking, update-check cache) rather than
 * the global memesh dir.
 */
export function getMemeshDirFromDbPath(): string {
  return process.env.MEMESH_DB_PATH
    ? path.dirname(process.env.MEMESH_DB_PATH)
    : memeshDir();
}

/** The versioned local endpoint used when no owner-selected socket overrides it. */
export function getAgentRouterSocketPath(): string {
  return path.join(getMemeshDirFromDbPath(), AGENT_ROUTER_SOCKET_FILENAME);
}

/**
 * Migrate only the historic default beside the active database. An explicit
 * socket, including one with the old basename elsewhere, remains owner-owned.
 */
export function normalizeAgentRouterSocketPath(socketPath: string): string {
  const dataDir = getMemeshDirFromDbPath();
  return socketPath === path.join(dataDir, LEGACY_AGENT_ROUTER_SOCKET_FILENAME)
    ? getAgentRouterSocketPath()
    : socketPath;
}

/**
 * Derive the project name from a working directory.
 *
 * Five hooks and two core operations all derived this with subtly
 * different fallback chains:
 *   - hooks: `basename(data.cwd || process.cwd())`
 *   - core/operations: `basename(process.cwd())`
 *   - core/extractor: `basename(context.cwd)` (no fallback)
 *
 * This unified version takes an optional explicit cwd (e.g. from a hook
 * payload) and falls through to `process.cwd()`. Empty / missing inputs
 * also fall through, matching the most permissive caller's behaviour.
 */
export function getProjectName(cwdInput?: string | null): string {
  const cwd = cwdInput && cwdInput.length > 0 ? cwdInput : process.cwd();
  const cached = projectNameCache.get(cwd);
  if (cached !== undefined) return cached;
  const resolved = resolveProjectIdentity(cwd);
  projectNameCache.set(cwd, resolved);
  return resolved;
}

// Resolved names are stable for the life of a process (a cwd's git identity
// doesn't change mid-run), and getProjectName runs on hot paths — every hook
// invocation, every core operation. Cache so the git subprocess runs at most
// once per distinct cwd.
const projectNameCache = new Map<string, string>();

/**
 * Layered project identity, most-canonical first. Every result is a bounded
 * readable label plus a 128-bit SHA-256 prefix; the label is for humans and
 * the hash is the routing identity:
 *
 *   1. canonical git remote locator — host plus full namespace and repo. This is the
 *      only identity that is BOTH location-independent (same from any
 *      subdirectory, worktree, or clone path) AND case-canonical (the remote
 *      spells the name once). It fixes the real-data failures: a memory
 *      captured in `<repo>/backend` and one captured at `<repo>` now share an
 *      identity, and `tim` vs `TIM` collapse to whatever the remote says.
 *   2. native real path of the git repo root — for a real repo with no remote.
 *      Still fixes the subdirectory split.
 *   3. native real path of the cwd — for non-git directories
 *      used to be bare `basename(cwd)`, which made `~/a/notes` and `~/b/notes`
 *      one project and leaked memories across them. The hash pins identity to
 *      the directory itself; every host on the machine derives the same id
 *      for the same directory. (Existing non-git projects change identity
 *      once — `memesh kg rename-project --from <old> --to <new> --apply`
 *      merges the tags.)
 *
 * A `config.project` override would sit above all three, but adding a config
 * field with no setter is itself the "fake working" pattern this audit is
 * removing; it should land WITH its setter, not before.
 *
 * git failures at every layer fall through silently to the next — a missing
 * git binary, a non-repo cwd, or a deleted directory must never break capture.
 */
function resolveProjectIdentity(cwd: string): string {
  const remote = tryGit(cwd, ['config', '--get', 'remote.origin.url']);
  if (remote) {
    const locator = canonicalRemoteLocator(remote);
    if (locator) {
      const label = path.posix.basename(locator).replace(/\.git$/i, '');
      return projectIdentity(label, locator);
    }
  }
  const root = tryGit(cwd, ['rev-parse', '--show-toplevel']);
  // A linked worktree has its own top-level path but shares the primary
  // repository's common `.git` directory. Use that directory's parent when
  // available so no-remote worktrees do not split into separate projects.
  const commonDir = root
    ? tryGit(cwd, ['rev-parse', '--git-common-dir'])
    : null;
  const absoluteCommonDir = commonDir ? path.resolve(cwd, commonDir) : null;
  const localPath = absoluteCommonDir && path.basename(absoluteCommonDir) === '.git'
    ? path.dirname(absoluteCommonDir)
    : (root ?? cwd);
  let real: string;
  try {
    real = fs.realpathSync.native(localPath);
  } catch {
    real = path.resolve(localPath);
  }
  return projectIdentity(path.basename(real), real);
}

const PROJECT_HASH_HEX_LENGTH = 32;
const PROJECT_ID_MAX_LENGTH = 200;
const PROJECT_LABEL_MAX_LENGTH = PROJECT_ID_MAX_LENGTH - PROJECT_HASH_HEX_LENGTH - 1;

function projectIdentity(label: string, locator: string): string {
  const readable = label.normalize('NFC').slice(0, PROJECT_LABEL_MAX_LENGTH) || 'project';
  const suffix = createHash('sha256').update(locator).digest('hex').slice(0, PROJECT_HASH_HEX_LENGTH);
  return `${readable}~${suffix}`;
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    const out = execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * The git repository root containing `cwd`, or `null` when there is none —
 * a missing git binary, a non-repo directory, or a path that does not exist
 * all answer `null` here, same as everywhere else in this file.
 *
 * `scripts/hooks/pre-edit-recall.js` uses this for two things that both need
 * the ACTUAL root path, not just a yes/no: deciding whether to scope memory
 * recall by the edited file's own project or fall back to the session's cwd
 * (#358), and computing the edited file's path relative to its repo root for
 * the literal-confirmation path-suffix check (#358 round 3 item 3). One git
 * call serves both.
 */
export function gitRepoRoot(cwdInput?: string | null): string | null {
  const cwd = cwdInput && cwdInput.length > 0 ? cwdInput : process.cwd();
  return tryGit(cwd, ['rev-parse', '--show-toplevel']);
}

/**
 * Canonicalize a network git remote without retaining a password.
 *
 * Only standard GitHub HTTPS and `git@github.com` SSH spellings are known to
 * identify the same repository, so they converge. For a generic SSH host the
 * login and path mode are part of the repository locator: `alice@host:repo`
 * is relative to Alice's home, while `alice@host:/repo` is absolute, and Bob's
 * home may contain another repository with the same name. Other URL schemes
 * remain explicit rather than being guessed equivalent. Host case is
 * DNS-insensitive; repository path case is preserved. Local/file remotes
 * return null and use the repository-root identity instead.
 */
export function canonicalRemoteLocator(remote: string): string | null {
  const value = remote.trim();
  if (!value) return null;
  if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value)) return null;

  let host: string;
  let port = '';
  let user: string;
  let remotePath: string;
  let transport: string;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return null;
    }
    if (parsed.protocol === 'file:' || !parsed.hostname) return null;
    host = parsed.hostname.toLowerCase();
    port = parsed.port;
    const protocol = parsed.protocol.toLowerCase();
    if ((protocol === 'ssh:' || protocol === 'git+ssh:') && port === '22') port = '';
    user = parsed.username;
    remotePath = parsed.pathname;
    transport = protocol === 'ssh:' || protocol === 'git+ssh:'
      ? 'ssh-absolute'
      : protocol.slice(0, -1);
  } else {
    const scp = /^(?:([^@]+)@)?(\[[^\]]+\]|[^:/]+):(.+)$/.exec(value);
    if (!scp) return null;
    user = scp[1] ?? '';
    host = scp[2].toLowerCase();
    remotePath = scp[3];
    transport = remotePath.startsWith('/') ? 'ssh-absolute' : 'ssh-relative';
  }

  const pathWithoutSlashes = remotePath.replace(/^\/+|\/+$/g, '');
  if (!host || !pathWithoutSlashes) return null;
  const endpoint = `${host}${port ? `:${port}` : ''}`;
  const standardGithub = host === 'github.com'
    && port === ''
    && (transport === 'https' || ((transport === 'ssh-relative' || transport === 'ssh-absolute') && user === 'git'));
  const normalizedPath = standardGithub
    ? pathWithoutSlashes.replace(/\.git$/i, '')
    : pathWithoutSlashes;
  if (standardGithub) return `${endpoint}/${normalizedPath}`;
  const authority = transport.startsWith('ssh-') && user ? `${user}@${endpoint}` : endpoint;
  return `${transport}://${authority}/${normalizedPath}`;
}

/** Test seam: clear the per-cwd resolution cache between cases. */
export function _clearProjectNameCache(): void {
  projectNameCache.clear();
}

/**
 * The one list of secret-shaped patterns, shared by every redactor in the
 * codebase. Three copies used to exist at three different strengths — the
 * transcript scrubber (broadest), this module's egress redactor (middle),
 * and a private narrower copy — and a
 * cross-model review measured the gap: `github_pat_`, Stripe `sk_live_`,
 * JWTs, npm tokens and private keys sailed through the egress redactor into
 * a public GitHub issue URL. One list means one place to add the next token
 * format.
 *
 * Order matters for replacement: widest, whole-block patterns FIRST so a
 * full match is redacted as one unit and a later narrower pattern can never
 * leave part of the secret naked (the PEM body would otherwise survive its
 * own header being masked).
 *
 * Source strings, not RegExp objects, so a consumer can compile with the
 * flags it needs.
 *
 * This used to say a shared global-flag RegExp "would leak `lastIndex` state
 * between calls" — while, forty lines down, SECRET_PATTERNS compiles exactly
 * such a shared array. Both could not be true, and the array is the one that
 * ships. What makes it safe is narrower, and it is a rule about the
 * CONSUMER rather than about the pattern: `maskMatches` below — the only
 * thing that runs these — sets `lastIndex` to 0 before it searches and runs
 * `exec` until it returns null, which sets it back to 0. A future consumer
 * reaching for `.test()` or `.exec()` on a shared global regex without doing
 * the same WOULD carry `lastIndex` from one call into the next and skip
 * matches; such a consumer must compile its own, from these sources.
 */
/**
 * The `sk-` key and the `name=value` credential, without the boundary each
 * needs before it in the list below. `gluedAfter` runs them with no boundary
 * at the end of a masked span.
 */
const SK_KEY = 'sk[-_][^\\s"\\\\]{4,}[A-Za-z0-9]';
const NAMED_VALUE = '(?:api[-_]?key|access[-_]?token|auth[-_]?token|refresh[-_]?token|session[-_]?token|token|secret|password|passwd|pwd|signature)=[^&\\s"\'<>]{8,}';
/** The two patterns made of separate segments: a match starting inside one of them can end later (maskMatches). */
const JWT_TOKEN = 'eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}';
const SENDGRID_KEY = 'SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}';

export const SECRET_PATTERN_SOURCES: readonly string[] = [
  // PEM private key. A BEGIN..END region is sensitive as a whole, whatever is
  // inside it (a hard-wrapped key, per-line prefixes, junk characters, any kind
  // of line break). A header with no END after it has no trustworthy end, so
  // everything from it to the end of the text is masked: a note that quotes a
  // header loses the text after it (#523). Text before the header and text
  // after a genuine END stay. A key inside one JSON string is masked to the end
  // of that string, because redactSecrets redacts decoded strings.
  '-----BEGIN[A-Z ]*PRIVATE KEY-----(?:[\\s\\S]*?-----END[A-Z ]*PRIVATE KEY-----|[\\s\\S]*)',
  // DB / message-broker connection string with embedded credentials. Scheme
  // anchored so it cannot fire on ordinary `word:word@word` prose.
  '(?:postgres|postgresql|mysql|mariadb|mongodb(?:\\+srv)?|redis|rediss|amqp|amqps)://[^\\s:@/]+:[^\\s:@/]+@',
  // JWT — three base64url segments; `eyJ` is base64 of `{"`.
  JWT_TOKEN,
  // SendGrid API key.
  SENDGRID_KEY,
  // Stripe secret/restricted/publishable live+test keys.
  '[srp]k_(?:live|test)_[A-Za-z0-9]{16,}',
  // npm automation token.
  'npm_[A-Za-z0-9]{36}',
  // Anthropic / OpenAI-style keys. ONE pattern, anchored on the `sk-`/`sk_`
  // prefix and then any run of non-whitespace, rather than three that
  // enumerated the character class of an unmasked key.
  //
  // The narrow form missed what providers actually return. A rejected key
  // comes back quoted and PARTIALLY MASKED — `sk-proj-**********ZfQ9` — and
  // `[A-Za-z0-9_-]{16,}` stops dead at the first `*`, so the prefix and the
  // trailing characters were published. Which glyph a provider masks with
  // (`*`, `•`, `…`, or a bare truncation) is not knowable in advance, so the
  // class is "not whitespace" and the match ends on an alphanumeric — that
  // leaves the sentence's own punctuation outside the redaction.
  //
  // The leading \\b is load-bearing. Without it the pattern fires inside
  // ordinary words that happen to contain `sk-`: `task-runner`, `disk-usage`,
  // `risk-level`, `ask-first`. That is not merely noisy — a false positive
  // costs real content, not a masked word: dreamer.ts reads
  // `redactSecrets(s) !== s` as "this text is secret-shaped" and refuses the
  // whole submitted result with `secret_shaped_result`. That is the drop
  // gate this list feeds, and it is the reason to keep the patterns narrow.
  //
  // The run is unbounded in LENGTH but bounded in CHARACTER SET: `[^\s"\\]`,
  // not `\S`. This function runs over `JSON.stringify(doctorResult)` (see
  // server.ts /v1/doctor), where there is no whitespace between fields, so
  // `\S{4,}` anchored on a repo named `sk-widgets` ran through the closing
  // quote, the comma, the next key, and stopped at the first space inside a
  // LATER string — deleting the sibling `fix` field from the public issue
  // body. A real key never contains `"` or `\`, so excluding them costs no
  // coverage and makes a quote a hard stop. A length cap was tried instead
  // and rejected: `sk-` + 400 chars redacted the first 204 and published the
  // remaining 200. Measured, not assumed.
  `\\b${SK_KEY}`,
  // Bearer token. `(?:\\s|\\\\[nrt])+` instead of plain \\s+: the HTTP
  // doctor egress redacts JSON-STRINGIFIED text, where a real newline
  // between "Bearer" and the token has become the two characters \n — a
  // shape plain \s+ cannot see. It runs BEFORE the `name=value` pattern
  // below (#523): `password=Bearer` + newline + token redacted the token
  // to `password=***REDACTED***`, which a SECOND pass then matched again —
  // and every memory-tool edit is a second pass over the stored file.
  'Bearer(?:\\s|\\\\[nrt])+[A-Za-z0-9_.\\-]{16,}',
  // Credential passed as a URL query parameter or a `name=value` assignment.
  // No pattern covered this: an upstream error that echoes the request URL
  // (`GET /v1/models?api_key=…`) carried the key through every egress. The
  // parameter NAME is what is matched, so `?limit=200` and prose containing
  // the word "token" are untouched. No letter or digit may precede the name
  // (so `mytoken=` is not a hit) but `_` and `-` may: `DB_PASSWORD=…` and
  // `OPENAI_API_KEY=…` are the dominant credential shape in a shell
  // transcript and must match. The value must be 8+ characters so
  // `token=bucket` and `signature=valid` — prose, not credentials — survive.
  `(?<![A-Za-z0-9])${NAMED_VALUE}`,
  'ghp_[A-Za-z0-9]{30,}',              // GitHub PAT (classic)
  'gho_[A-Za-z0-9]{30,}',              // GitHub OAuth
  'gh[sur]_[A-Za-z0-9]{30,}',          // GitHub app/server/refresh tokens
  'github_pat_[A-Za-z0-9_]{20,}',      // GitHub PAT (fine-grained)
  'A(?:KIA|SIA)[A-Z0-9]{16}',          // AWS access key id (perm + temporary)
  'AIza[A-Za-z0-9_-]{30,}',            // Google API key
  'xox[baprs]-[A-Za-z0-9-]{10,}',      // Slack token
];

/**
 * Redact credential-shaped substrings before text leaves the machine.
 *
 * Belt-and-suspenders: nothing should put a secret in a diagnostic, but two
 * public egresses copy diagnostics verbatim into a pre-filled GitHub issue
 * body — the dashboard's `/v1/doctor` and the CLI's `memesh feedback` — and
 * both must run this BEFORE redactUserPaths (a home path inside a token,
 * once rewritten to `~`, would break the secret pattern and leak the rest).
 * It lived as a private function in the HTTP server, which left the CLI
 * egress path-redacted but not credential-redacted; it lives here because
 * this module owns redaction and both transports already import it.
 */
/** Compiled once. `maskMatches` starts each search at `lastIndex` 0 and ends
 *  it at null (which resets it), so reusing them across calls is safe. The
 *  Stop hook calls this per bash block and per errored tool result — hundreds
 *  of times per session, inside a 10-second budget — and it was recompiling
 *  every pattern each time. */
const SECRET_PATTERNS = SECRET_PATTERN_SOURCES.map((s) => new RegExp(s, 'gi'));
const SEGMENTED = new Set([JWT_TOKEN, SENDGRID_KEY].map((s) => SECRET_PATTERNS[SECRET_PATTERN_SOURCES.indexOf(s)]));

/** One string through the pattern list, repeated until nothing changes. */
function redactRaw(input: string): string {
  // A marker left by one pattern can complete another's match when credentials
  // are glued together with no separator — `AKIA…password=…` masked the key id
  // and left the password raw on a single pass. Most callers redact once, so
  // the result must already be a fixed point: redacting it again changes
  // nothing.
  // Repeated until nothing changes. It ends: the marker itself matches no
  // pattern, so every pass that changes the text masks at least one character
  // that was not masked before.
  let out = input;
  for (let before = ''; out !== before;) {
    before = out;
    out = maskMatches(out);
  }
  return out;
}

/**
 * Every pattern's matches in `input`, overlapping ones included, each span
 * replaced by one marker. A run can swallow the start of a credential glued
 * right after it (`ghp_…ghp_…` ends the first match at `…ghp`; a JWT's last
 * segment runs into the next JWT's header segment, of any length), and the
 * rest of the second credential then matches nothing. So after each match the
 * search starts again one character later, which finds every match however
 * much of it the previous one swallowed. Overlapping searches can cost more
 * than one pass over the text (`sk-sk-sk-…` matches from every `sk-` to the
 * end). Most patterns are one run of characters after a prefix, so a match
 * that starts inside another one of the same pattern ends where it ends: once
 * a search comes back with the same end, it skips ahead to that end, and a
 * run is searched twice, not once per start. A JWT and a SendGrid key are
 * made of segments, so a start inside one can end later; those keep
 * searching from every start. The work is capped too, and the cap fails
 * closed: once the matches found add up to more than four times the text,
 * everything from the current match to the end of the text is masked.
 */
function maskMatches(input: string): string {
  const spans: Array<[number, number]> = [];
  const budget = 4 * input.length + 1024;
  let work = 0;
  search: for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    let lastEnd = -1;
    for (let m = pattern.exec(input); m !== null; m = pattern.exec(input)) {
      const end = m.index + m[0].length;
      if (end === lastEnd && !SEGMENTED.has(pattern)) {
        pattern.lastIndex = end;
        continue;
      }
      lastEnd = end;
      work += m[0].length;
      if (work > budget) {
        spans.push([m.index, input.length]);
        pattern.lastIndex = 0;
        break search;
      }
      spans.push([m.index, end]);
      pattern.lastIndex = m.index + 1;
    }
  }
  if (spans.length === 0) return input;
  let out = '';
  let at = 0;
  for (const [start, end] of gluedAfter(input, merge(spans))) {
    out += `${input.slice(at, start)}${REDACTED}`;
    at = end;
  }
  return out + input.slice(at);
}

/** Spans sorted, overlapping ones joined. */
function merge(spans: Array<[number, number]>): Array<[number, number]> {
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of spans) {
    const last = merged[merged.length - 1];
    if (last && start < last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** `sk-…` and `name=value` with no boundary before them, tried at one position. */
const GLUED = [SK_KEY, NAMED_VALUE].map((s) => new RegExp(s, 'iy'));

/**
 * Masked spans, each grown over an `sk-` key or a `name=value` credential
 * that starts inside it or right at its end and runs past it. Those two
 * patterns need a boundary before them (`task-runner` is not a key,
 * `mytoken=` is not a credential), and a credential glued before them takes
 * that boundary away: `ghp_…sk-…` ends the GitHub token at `…sk`, and the
 * `sk-` key that starts there no longer has a word boundary, so its tail
 * would stay. Inside a masked span there is no ordinary word to protect.
 * One sweep from left to right: each position is tried once per pattern, a
 * span grows as matches run past its end and takes in the spans it reaches,
 * and a position inside a match already found is not tried again (a start
 * inside that run ends where the run ends).
 */
function gluedAfter(input: string, spans: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let next = 0;
  while (next < spans.length) {
    const [start] = spans[next];
    let end = spans[next][1];
    next++;
    const skipTo = GLUED.map(() => start);
    for (let at = start; at <= end && end < input.length; at++) {
      GLUED.forEach((pattern, i) => {
        if (at < skipTo[i]) return;
        pattern.lastIndex = at;
        const m = pattern.exec(input);
        if (m === null) return;
        skipTo[i] = at + m[0].length;
        end = Math.max(end, skipTo[i]);
      });
      while (next < spans.length && spans[next][0] <= end) end = Math.max(end, spans[next++][1]);
    }
    out.push([start, end]);
  }
  return out;
}

const PRIVATE_KEY_MARKER = /-----(BEGIN|END)[A-Z ]*PRIVATE KEY-----/gi;
const PRIVATE_KEY_END = /-----END[A-Z ]*PRIVATE KEY-----/i;
const ANY_PRIVATE_KEY_MARKER = /-----(?:BEGIN|END)[A-Z ]*PRIVATE KEY-----/i;
const REDACTED = '***REDACTED***';
/** JSON.rawJSON and JSON.isRawJSON (Node 21+): TypeScript's lib does not declare them yet, and an older Node does without them. */
const nativeJson = JSON as JSON & { rawJSON?: (text: string) => unknown; isRawJSON?: (value: unknown) => boolean };
const looksLikeJson = (text: string) => /^\s*[[{"]/.test(text);

const JSON_ESCAPE = /\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/g;
const ESCAPED_CHAR: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

/**
 * JSON text with its escapes read (`\u0074` is `t`, `\n` a newline), level
 * after level, without parsing it: a member JSON.parse drops (the first value
 * of a duplicate key) is still there. Undefined when the escapes nest more
 * than eight levels deep: that text cannot be read, so it is stored as the
 * marker on its own (redactOne), like JSON nested too deep to parse.
 */
function readEscapes(text: string): string | undefined {
  for (let level = 0; level <= 8; level++) {
    const read = text.replace(JSON_ESCAPE, (_, hex: string | undefined, c: string) =>
      hex === undefined ? ESCAPED_CHAR[c] : String.fromCharCode(parseInt(hex, 16)));
    if (read === text) return text;
    text = read;
  }
  return undefined;
}

/**
 * True when a string holds one part of a private key that goes on in another
 * string: a BEGIN with no END after it, or an END with no BEGIN before it.
 */
function holdsPartOfKey(text: string): boolean {
  let open = false;
  for (const [, marker] of text.matchAll(PRIVATE_KEY_MARKER)) {
    if (marker.toUpperCase() === 'BEGIN') open = true;
    else if (open) open = false;
    else return true;
  }
  return open;
}

/** Every string and key name in a decoded JSON value, without growing the call stack. */
function* jsonTexts(value: unknown): Generator<string> {
  const stack = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node === 'string') yield node;
    else if (Array.isArray(node)) for (const item of node) stack.push(item);
    else if (node !== null && typeof node === 'object' && !nativeJson.isRawJSON?.(node)) {
      for (const [key, inner] of Object.entries(node)) { yield key; stack.push(inner); }
    }
  }
}

/**
 * holdsPartOfKey as the decoder reads the text: a string that is itself a
 * JSON document is checked string by string, so a header written as
 * `-…` or a key split across the strings of a JSON document inside it
 * counts too. JSON too deep to read cannot be cleared, so it counts.
 */
function holdsPartOfKeyDecoded(text: string): boolean {
  if (holdsPartOfKey(text)) return true;
  if (!looksLikeJson(text) || !(text.includes('\\') || ANY_PRIVATE_KEY_MARKER.test(text))) return false;
  // Read lexically too: a duplicate key's dropped value is not in the parse.
  const read = readEscapes(text);
  if (read !== undefined && holdsPartOfKey(read)) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return !(err instanceof SyntaxError);
  }
  for (const inner of jsonTexts(parsed)) if (inner !== text && holdsPartOfKeyDecoded(inner)) return true;
  return false;
}

/**
 * A decoded JSON value with each string through `text` and each key name
 * through `key`. Numbers, booleans, null and the structure are kept; the
 * values of the top-level `skipKeys` are kept as given. Key names that land
 * on one name all stay: each later one gets ` (2)`, ` (3)`…, so no value is
 * ever dropped.
 */
function mapJson(node: unknown, text: (s: string) => string, key: (k: string) => string, skipKeys?: ReadonlySet<string>): unknown {
  if (typeof node === 'string') return text(node);
  if (Array.isArray(node)) return node.map((item) => mapJson(item, text, key));
  if (node === null || typeof node !== 'object' || nativeJson.isRawJSON?.(node)) return node;
  const out: Record<string, unknown> = {};
  const lastSuffix = new Map<string, number>();
  for (const [name, inner] of Object.entries(node)) {
    const safe = key(name);
    let unique = safe;
    if (Object.prototype.hasOwnProperty.call(out, unique)) {
      let n = lastSuffix.get(safe) ?? 1;
      do { n++; unique = `${safe} (${n})`; } while (Object.prototype.hasOwnProperty.call(out, unique));
      lastSuffix.set(safe, n);
    }
    // defineProperty, so a `__proto__` key stays an own data property.
    Object.defineProperty(out, unique, {
      value: skipKeys?.has(name) ? inner : mapJson(inner, text, key),
      enumerable: true, writable: true, configurable: true,
    });
  }
  return out;
}

/** Redacted text, and whether anything was masked (a JSON document written again with nothing masked is not a change). */
interface Redaction { text: string; masked: boolean }

/**
 * Strings stored together, redacted together. Each is redacted on its own,
 * except when one of them holds only part of a private key (a key split one
 * line per string, or across the fields of a JSON document): which strings
 * hold the rest cannot be told from their order, because JSON.parse reorders
 * integer-like keys. So every string in the set becomes the marker.
 */
function redactSet(items: readonly string[]): { texts: string[]; masked: boolean } {
  if (items.some(holdsPartOfKeyDecoded)) return { texts: items.map(() => REDACTED), masked: true };
  let masked = false;
  const texts = items.map((item) => {
    const r = redactOne(item, true);
    if (r.masked) masked = true;
    return r.text;
  });
  return { texts, masked };
}

export function redactSecretList(items: readonly string[]): string[] {
  return redactSet(items).texts;
}

/**
 * A memory's title and observations, redacted as one set: a key split between
 * the title and an observation is masked as a whole. Only what was given
 * comes back.
 */
export function redactTitleAndObservations(
  title: string | undefined,
  observations: readonly string[] | undefined,
): { title?: string; observations?: string[] } {
  const head = title === undefined ? [] : [title];
  const texts = redactSecretList([...head, ...(observations === undefined ? [] : observations)]);
  return {
    ...(title === undefined ? {} : { title: texts[0] }),
    ...(observations === undefined ? {} : { observations: texts.slice(head.length) }),
  };
}

/**
 * Whether redacting these strings as one set masks anything. A caller that
 * asks "is this secret-shaped?" uses this, not a comparison of bytes: a JSON
 * document is written again when it has an escape, which changes its bytes
 * and masks nothing.
 */
export function holdsSecret(items: readonly string[]): boolean {
  return redactSet(items).masked;
}

/** JSON.parse reviver: a number keeps its source spelling (12345678901234567890 stays exact). */
const keepNumberSpelling = (_key: string, value: unknown, context?: { source?: string }) =>
  typeof value === 'number' && context?.source !== undefined && nativeJson.rawJSON ? nativeJson.rawJSON(context.source) : value;

/**
 * `partChecked`: the caller already found no part of a private key in this
 * text, at any depth (redactSet, or the document this string came from), so
 * that walk is not repeated for every level of a nested document.
 */
function redactOne(input: string, partChecked = false): Redaction {
  const raw = redactRaw(input);
  const asRaw = { text: raw, masked: raw !== input };
  // Only an object, an array or a string can hold text to redact.
  if (!looksLikeJson(input)) return asRaw;
  // With no escape in it, every JSON string reads in the text exactly as it
  // decodes, shadowed duplicates and key names included. So when the patterns
  // match nothing in the text and it holds no END marker (a lone END is part
  // of a split key), no string in it holds anything to redact: it comes back
  // byte for byte.
  if (!asRaw.masked && !input.includes('\\') && !PRIVATE_KEY_END.test(input)) return asRaw;
  // Otherwise text that is, as a whole, one JSON document is redacted by
  // value, as one set: its string values and key names. When one of them
  // holds part of a private key, every string AND every key name becomes the
  // marker (a key line can sit in a key name too); the structure, numbers,
  // booleans and null stay. The document is written again with
  // JSON.stringify: whitespace between tokens goes, numbers keep their
  // spelling, and of duplicate keys only the last stays (JSON.parse drops the
  // others).
  try {
    const parsed = JSON.parse(input, keepNumberSpelling);
    if (!partChecked && holdsPartOfKeyDecoded(input)) {
      return { text: JSON.stringify(mapJson(parsed, () => REDACTED, () => REDACTED)), masked: true };
    }
    // Escapes nested too deep to read: none of it can be checked.
    const read = readEscapes(input);
    if (read === undefined) return { text: REDACTED, masked: true };
    let masked = false;
    const value = mapJson(
      parsed,
      (s) => { const r = redactOne(s, true); if (r.masked) masked = true; return r.text; },
      (k) => { const r = redactRaw(k); if (r !== k) masked = true; return r; },
    );
    // The raw rules matching the source text, or the text with its escapes
    // read, is masking too: a credential in a duplicate key that JSON.parse
    // dropped is in the text, not in `value`, and may be written in escapes.
    const maskedInText = asRaw.masked || redactRaw(read) !== read;
    return { text: JSON.stringify(value), masked: masked || maskedInText };
  } catch (err) {
    // Not JSON: the raw rules over the whole text. JSON nested too deep to
    // read or walk (about a thousand levels): none of it can be checked.
    return err instanceof SyntaxError ? asRaw : { text: REDACTED, masked: true };
  }
}

export function redactSecrets(input: string): string {
  return redactOne(input).text;
}

/**
 * Replace every path that identifies this machine's user with `~`.
 *
 * `memesh feedback` composes a GitHub issue body out of `doctor` output, and
 * doctor names paths: the database, the config file, where `memesh` resolves
 * on `PATH`. On a normal install every one of those begins with the home
 * directory, so the pre-filled body carried the account name into a **public**
 * issue tracker, twice, inside a diagnostics block long enough that nobody
 * reads it before submitting. The paths stay just as useful with the home part
 * cut off: `~/.memesh/knowledge-graph.db` says everything the absolute form
 * said.
 *
 * It lives here, in the module that owns path resolution, because it has to
 * redact the SAME set of roots that module produces, and because two surfaces
 * publish this text: the CLI, and the dashboard's feedback widget via
 * `/v1/doctor`. The CLI-only version left the dashboard leaking.
 *
 * Three roots, longest-first so a nested one cannot be half-replaced:
 *   - `homeDir()`, and its realpath — on macOS a temp HOME resolves through
 *     `/private`, so redacting only one spelling leaves the other in the body.
 *   - `memeshDir()` and the DB's directory, which `MEMESH_DIR` /
 *     `MEMESH_DB_PATH` can move outside home entirely. That is a supported
 *     configuration, and in a real deployment such a path typically carries an
 *     account or organisation name.
 */
export function redactUserPaths(text: string): string {
  const home = homeDir();
  const roots = new Set<string>();
  const add = (root: string) => {
    // Absolute directories only. `getDbPath()` returns `MEMESH_DB_PATH`
    // verbatim, so a relative value like `kg.db` makes `path.dirname(...)`
    // exactly `"."` — which compiled to `\.` and replaced EVERY literal dot in
    // the payload: `4.5.0` became `4~5~0`, `knowledge-graph.db` became
    // `knowledge-graph~db`. This function runs on the `/v1/doctor` response
    // that the dashboard turns into a public issue, so a corrupted diagnostic
    // is published with nothing saying redaction did it.
    if (!root || !path.isAbsolute(root)) return;
    roots.add(root);
    try { roots.add(fs.realpathSync(root)); } catch { /* may not exist yet */ }
  };
  add(home);

  // The data directories only need their OWN entry when an override has moved
  // them outside home. Inside home, redacting home already covers them — and
  // adding them anyway makes it worse, not better: they are longer, so they
  // match first and turn `/Users/x/.memesh/knowledge-graph.db` into
  // `~/knowledge-graph.db`, throwing away the `.memesh` part that tells the
  // reader which file it is.
  const isInside = (child: string) => {
    const rel = path.relative(home, child);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  for (const dir of [memeshDir(), path.dirname(getDbPath())]) {
    if (dir && !isInside(dir)) add(dir);
  }

  // Case-insensitive except on Linux: macOS and Windows filesystems are
  // case-insensitive, so the same directory can be spelled either way.
  const flags = process.platform === 'linux' ? 'g' : 'gi';
  let out = text;
  for (const root of [...roots].sort((a, b) => b.length - a.length)) {
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Either separator, once or twice. Twice matters: the HTTP path redacts a
    // JSON string, where a Windows `C:\Users\x` is serialised as
    // `C:\\Users\\x` — a single-separator pattern matches the live path and
    // silently misses the JSON-encoded one, which is the copy that gets
    // published.
    //
    // A root has to match at a path boundary on BOTH sides, and it takes two
    // assertions to say that — one is the bug this had.
    //
    // Trailing lookahead: without it `MEMESH_DIR=/data` rewrote
    // `/var/lib/postgres/database` to `/var/lib/postgres~base` and `/datasets/x`
    // to `~sets/x`.
    //
    // Leading lookbehind: the trailing one alone still let a root match in the
    // MIDDLE of an unrelated path, because there the next character IS a
    // separator — `/var/lib/data/file` became `/var/lib~/file`. The comment here
    // used to cite only the `database` case and read as though the whole class
    // was closed; it was half closed, and the test below matched the comment
    // rather than the claim in its own name.
    //
    // What "mid-path" means, precisely: the root is glued to the END of a path
    // component. That is a component character (`\w~`) directly before the
    // match, or such a character with only separators between it and the match
    // — the latter is the `/var/lib//data` doubling, where the match can start
    // one character to the right of the pair. Both shapes, one variable-length
    // lookbehind: `[\w~]` optionally followed by the same `{1,2}` separator
    // run the body uses.
    //
    // The first version of this fix forbade `.`, `-` and bare separators as
    // predecessors too, and those rejections UNREDACTED text that is real and
    // on its way into a public issue: `file:///Users/x` — every frame of a
    // Node ESM stack trace; the match starts at a separator preceded by
    // another separator — and `-/Users/x`, a diff's removed line. This
    // function is a security control; when a predecessor is ambiguous, the
    // cost of matching is a slightly over-redacted diagnostic, the cost of
    // not matching is an account name published on a public tracker. So the
    // lookbehind names the two component-glue shapes and nothing else.
    const body = escaped.replace(/\\\\|\//g, '[\\\\/]{1,2}');
    out = out.replace(new RegExp(`(?<![\\w~](?:[\\\\/]{1,2})?)${body}(?=[\\\\/]|$)`, flags), '~');
  }
  return out;
}

/**
 * How a stored memory's text is redacted before it is shown to an agent —
 * secrets first, then user paths (the order documented on `redactSecrets`).
 *
 * One definition for the three places that render memory lines: the
 * durable-memory index (briefing-index.ts), the ranked sections of the MCP/CLI
 * `briefing` (briefing.ts) and the SessionStart hook's ranked sections
 * (scripts/hooks/session-start.js). #464: the ranked sections used to print
 * the stored text as it was while the index redacted it, so one memory could
 * appear twice in one injected block, once each way. The shared line builder
 * (work-topology.ts) cannot call this — the dashboard bundles it for the
 * browser, and this module needs fs and os — so each caller applies it in its
 * row → line mapping, and the tests hold them to the same treatment.
 */
export function redactMemoryText(text: string): string {
  return redactUserPaths(redactSecrets(text));
}

/**
 * Credential redaction for the TEXT inside a structured value — strings at
 * any depth of a plain object or array; every other value (a number, a
 * boolean, null) is returned as it was, so a validated shape is not
 * disturbed. Used for metadata a caller can set (#523): import's allow-listed
 * fields and the public graph writers.
 *
 * `skipKeys` names top-level keys left exactly as given: the graph writers
 * pass `replaced_history`, an accepted old record that a replace re-persists
 * from stored text and must not rewrite.
 */
export function redactTextValues(value: unknown, skipKeys: ReadonlySet<string> = new Set()): unknown {
  // Redact what will actually be SERIALIZED, not the object handed in: a
  // null-prototype dictionary and a nested object with a `toJSON()` both
  // survived a walk that only descended into plain objects, and then
  // `JSON.stringify` wrote their credential text out (#523).
  // One JSON round-trip first turns the value into exactly the plain shape
  // the store will hold — `toJSON` resolved, prototypes dropped, undefined
  // and functions gone — and the walk below then sees every string.
  if (value === undefined) return undefined;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return undefined;
  // Each string on its own, and each key name: a metadata record mixes text
  // with fields like `trust`, `kind` and timestamps that must never become the
  // marker. A caller that stores text which belongs together redacts it as a
  // set first (redactSecretList, redactVersionText), and the graph writer
  // refuses metadata that still holds part of a private key
  // (metadataRefusal).
  return mapJson(JSON.parse(serialized), redactSecrets, redactRaw, skipKeys);
}

/**
 * A replaced version (a `replaced_history` entry, or one about to become
 * one): its title and observations are one set, everything else is redacted
 * per string.
 */
export function redactVersionText(entry: unknown): unknown {
  const rest = redactTextValues(entry, new Set(['title', 'observations']));
  if (rest === null || typeof rest !== 'object' || Array.isArray(rest)) return rest;
  const version = rest as { title?: unknown; observations?: unknown };
  const observations = Array.isArray(version.observations) && version.observations.every((o) => typeof o === 'string')
    ? version.observations as string[] : undefined;
  // Observations that are not a list of text: string by string, like other metadata.
  if (observations === undefined) return redactTextValues(entry);
  // The title's text (none for a missing or null title, every string for one
  // that is not text) joins the observations as one set.
  const title = version.title;
  const titleTexts = typeof title === 'string' ? [title] : title === undefined || title === null ? [] : [...textsIn(title)];
  if ([...titleTexts, ...observations].some(holdsPartOfKeyDecoded)) {
    return {
      ...version,
      ...(titleTexts.length === 0 ? {} : { title: typeof title === 'string' ? REDACTED : mapJson(JSON.parse(JSON.stringify(title)), () => REDACTED, () => REDACTED) }),
      observations: observations.map(() => REDACTED),
    };
  }
  return {
    ...version,
    ...(typeof title === 'string' ? { title: redactSecrets(title) } : titleTexts.length === 0 ? {} : { title: redactTextValues(title) }),
    observations: observations.map(redactSecrets),
  };
}

/** Every string and key name in a structured value, as it would be stored. */
export function textsIn(value: unknown): Set<string> {
  const serialized = value === undefined ? undefined : JSON.stringify(value);
  return new Set(serialized === undefined ? [] : jsonTexts(JSON.parse(serialized)));
}

/**
 * Why metadata cannot be stored, or undefined when it can: a string or key
 * name that holds part of a private key (its other parts may sit in strings
 * that are redacted one by one), or a key name that holds a credential (its
 * redacted name would sit beside the field's earlier copy instead of
 * replacing it). Text already stored (`known`) is not checked again, so a
 * memory written before #523 can still be updated.
 *
 * `beside` is the rest of the same write: the stored text it keeps and the
 * title and observations it carries. When one of those holds part of a
 * private key and the metadata adds any new string, the write is refused:
 * the new string may be the rest of that key, and nothing tells it apart
 * from a timestamp. A lone BEGIN or END line is not proof of a key; the
 * write is refused because it cannot be told apart, not because a key was
 * found.
 */
export function metadataRefusal(value: unknown, known: ReadonlySet<string>, beside: Iterable<string> = []): string | undefined {
  const serialized = value === undefined ? undefined : JSON.stringify(value);
  if (serialized === undefined) return undefined;
  const stack: unknown[] = [JSON.parse(serialized)];
  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node === 'string') {
      if (!known.has(node) && holdsPartOfKeyDecoded(node)) return 'its metadata holds part of a private key (a BEGIN or END line without the rest). Nothing was written; remove that text and try again';
    } else if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
    } else if (node !== null && typeof node === 'object') {
      for (const [key, inner] of Object.entries(node)) {
        if (!known.has(key) && (holdsPartOfKeyDecoded(key) || redactRaw(key) !== key)) return 'a metadata key name holds a credential or part of a private key. Nothing was written; remove that text and try again';
        stack.push(inner);
      }
    }
  }
  return besideRefusal(addsNewText(value, known), beside);
}

/**
 * Why a write that adds text cannot be stored beside the rest of the same
 * write (`beside`: the text the memory keeps, and the title and observations
 * written with it), or undefined when it can: one of those holds part of a
 * private key, and the new text may be the rest of it.
 */
export function besideRefusal(addsText: boolean, beside: Iterable<string>): string | undefined {
  if (!addsText) return undefined;
  for (const text of beside) {
    if (holdsPartOfKeyDecoded(text)) {
      return 'it adds new text to a memory that holds a BEGIN or END line of a private key without the rest, '
        + 'so MeMesh cannot tell whether the new text continues that key (the line alone is not proof of a key). '
        + 'Nothing was written. To clear such a line in the memory\'s metadata, run `memesh unpin --name <name>` first '
        + '(it adds no text, and masks every part of a key in the metadata, history included); to remove such a line '
        + 'from its observations, run `memesh forget --name <name> --observation "<that line>"`; to replace such a title, '
        + 'run `memesh remember --name <name> --type <its type> --title "<new title>"`';
    }
  }
  return undefined;
}

/** Whether a structured value holds a string or a key name that is not in `known`. */
export function addsNewText(value: unknown, known: ReadonlySet<string>): boolean {
  const serialized = value === undefined ? undefined : JSON.stringify(value);
  if (serialized === undefined) return false;
  const stack: unknown[] = [JSON.parse(serialized)];
  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node === 'string') {
      if (!known.has(node)) return true;
    } else if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
    } else if (node !== null && typeof node === 'object') {
      for (const [key, inner] of Object.entries(node)) {
        if (!known.has(key)) return true;
        stack.push(inner);
      }
    }
  }
  return false;
}

/**
 * Metadata as a write that adds no new text stores it (#523): a
 * `replaced_history` entry that holds part of a private key is redacted as
 * its set (redactVersionText), and then every string and key name that
 * still holds part of one becomes the marker. Everything else, and every
 * other history entry, is kept as it was. This is how a memory written
 * before #523 with a lone BEGIN or END line takes new text again.
 */
export function clearPartsOfKey(metadata: Record<string, unknown>): Record<string, unknown> {
  const history = metadata.replaced_history;
  const entries = Array.isArray(history)
    ? { replaced_history: history.map((entry) => ([...textsIn(entry)].some(holdsPartOfKeyDecoded) ? redactVersionText(entry) : entry)) }
    : {};
  const clear = (text: string) => (holdsPartOfKeyDecoded(text) ? REDACTED : text);
  return mapJson({ ...metadata, ...entries }, clear, clear) as Record<string, unknown>;
}
