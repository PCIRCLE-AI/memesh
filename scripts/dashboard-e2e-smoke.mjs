import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { buildIsolatedRuntimeEnv } from './lib/isolated-env.mjs';
import { npmSync } from './lib/npm-bin.mjs';

const repoRoot = process.cwd();
const smokeDir = path.join(repoRoot, 'tmp', 'dashboard-e2e-smoke');
const npmCacheDir = process.env.MEMESH_NPM_CACHE ?? path.join(os.tmpdir(), 'memesh-npm-cache');

const pageErrors = [];
const consoleErrors = [];

function getChromeExecutablePath() {
  const envPath = process.env.CHROME_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;

  const candidates = process.platform === 'darwin'
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      ]
    : process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/snap/bin/chromium',
        ];

  return candidates.find((candidate) => fs.existsSync(candidate));
}

async function launchBrowser() {
  const chromeExecutable = getChromeExecutablePath();
  if (chromeExecutable) {
    return chromium.launch({
      executablePath: chromeExecutable,
      headless: true,
    });
  }

  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `No browser available for dashboard e2e smoke. Install Playwright Chromium (for CI: "npx playwright install --with-deps chromium") or set CHROME_PATH. Original error: ${reason}`,
      { cause: error }
    );
  }
}

async function getAvailablePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to allocate local port'));
        return;
      }
      const { port } = address;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on('error', reject);
  });
}

async function waitForServer(url, child) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (child.exitCode !== null) {
      throw new Error(`Dashboard server exited early with code ${child.exitCode}`);
    }

    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server not ready yet.
    }

    await delay(250);
  }

  throw new Error(`Timed out waiting for ${url}`);
}

function runNode(scriptPath, args, env) {
  execFileSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
}

function cleanupDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

async function main() {
  cleanupDir(smokeDir);
  fs.mkdirSync(smokeDir, { recursive: true });
  const runtimeHome = path.join(smokeDir, 'runtime-home');
  const memeshDir = path.join(runtimeHome, '.memesh');
  const dbPath = path.join(memeshDir, 'knowledge-graph.db');
  fs.mkdirSync(memeshDir, { recursive: true });
  const isolatedEnv = buildIsolatedRuntimeEnv(process.env, { runtimeHome, memeshDir, dbPath });

  const packJson = npmSync(
    ['pack', '--json', '--pack-destination', smokeDir],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...isolatedEnv,
        npm_config_cache: npmCacheDir,
      },
    }
  );

  const [{ filename }] = JSON.parse(packJson);
  const tarballPath = path.join(smokeDir, filename);
  const extractDir = path.join(smokeDir, 'extract');
  fs.mkdirSync(extractDir, { recursive: true });

  const tarCommand = process.platform === 'win32' ? 'tar.exe' : 'tar';
  execFileSync(tarCommand, ['-xf', tarballPath, '-C', extractDir], {
    cwd: repoRoot,
    stdio: 'inherit',
  });

  const packageRoot = path.join(extractDir, 'package');

  // Install the tarball's PRODUCTION dependencies, rather than symlinking
  // this repo's `node_modules` in.
  //
  // The symlink handed the packaged CLI the whole dev tree — vitest, the
  // TypeScript compiler, every transitive dev dependency — so an import that
  // resolved here would also resolve for a user only if that package
  // happened to be a runtime dependency too. A `dependencies` entry moved to
  // `devDependencies`, or forgotten entirely, passed this smoke test and
  // broke on the first real install. `smoke-packed-artifact.mjs` already
  // makes this distinction and says why in its own comment; this one
  // borrowed the dev tree instead.
  npmSync(['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: packageRoot,
    stdio: 'inherit',
    env: { ...isolatedEnv, npm_config_cache: npmCacheDir },
  });
  const cliEntry = path.join(packageRoot, 'dist', 'transports', 'cli', 'cli.js');
  const commonEnv = {
    ...isolatedEnv,
    // This spawns the REAL CLI serve, which opts into the background npm
    // update-check. CI must not depend on the npm registry here.
    MEMESH_SKIP_UPDATE_CHECK: '1',
  };

  // Use a work-layer type (lesson_learned) instead of 'note'. The
  // Memories tab defaults to Signal Mode = ON, which scopes the list to
  // the work layer (WORK_LAYER_TYPES in src/core/work-topology.ts).
  // 'note' sits outside that layer and gets hidden under the default;
  // lesson_learned is work-layer and is visible without the user
  // toggling Signal Mode off.
  //
  // UX-1 change: dashboard now shows entity.title (or best observation) as
  // the primary display text, not entity.name. Set title explicitly so the
  // test can find it by the expected text. Without title, displayTitle()
  // falls back to the observation, which would be "Dashboard smoke test memory".
  runNode(cliEntry, [
    'remember',
    '--name', 'dashboard-e2e-memory',
    '--type', 'lesson_learned',
    '--title', 'dashboard-e2e-memory',
    '--obs', 'Dashboard smoke test memory',
    '--tags', 'project:dashboard-e2e',
  ], commonEnv);

  const port = await getAvailablePort();
  const healthUrl = `http://127.0.0.1:${port}/v1/health`;
  const dashboardUrl = `http://127.0.0.1:${port}/dashboard`;

  const server = spawn(process.execPath, [cliEntry, 'serve', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: packageRoot,
    env: commonEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Pipe server stdout/stderr through to ours so CI logs include them
  // when the smoke fails. Previously buffered into an unused string.
  server.stdout.on('data', (chunk) => { process.stdout.write(`[server] ${chunk.toString()}`); });
  server.stderr.on('data', (chunk) => { process.stderr.write(`[server] ${chunk.toString()}`); });

  try {
    await waitForServer(healthUrl, server);
    const configResponse = await fetch(`http://127.0.0.1:${port}/v1/config`);
    assert.equal(configResponse.status, 200, 'isolated config readback should succeed');
    const configPayload = await configResponse.json();
    assert.equal(configPayload.success, true, 'isolated config readback should return success');
    assert.equal(typeof configPayload.data.config, 'object', 'isolated config readback should expose current settings');
    assert.equal('capabilities' in configPayload.data, false, 'retired provider capabilities must not be exposed');
    const browser = await launchBrowser();

    try {
      const context = await browser.newContext();
      await context.addInitScript(() => {
        localStorage.setItem('memesh-locale', 'en');
      });

      const page = await context.newPage();
      page.on('pageerror', (error) => {
        pageErrors.push(error.message);
      });
      page.on('console', (message) => {
        if (message.type() === 'error') {
          consoleErrors.push(message.text());
        }
      });

      // Open the dashboard with ?tab=Memories to land on the "All Memories"
      // library view directly. Default tab is "Home" (the 8→5 tab merge),
      // which leads with insights, not the entity list this smoke seeds.
      await page.goto(`${dashboardUrl}?tab=Memories`, { waitUntil: 'networkidle' });
      await expectVisible(page, 'All Memories');
      await expectVisible(page, 'dashboard-e2e-memory');

      // The ranked server search lives inside the Memories tab now: typing
      // filters client-side, the Search button (inside .search-bar) POSTs
      // /v1/recall. "ranked by relevance" only renders in recall mode, so
      // its presence proves the server search answered — the row alone
      // would, since UX-2, already be visible from the browsing list.
      await page.getByPlaceholder(/Filter as you type/i).fill('dashboard-e2e-memory');
      await page.locator('.search-bar').getByRole('button', { name: 'Search' }).click();
      await expectVisible(page, 'ranked by relevance');
      await expectVisible(page, 'dashboard-e2e-memory');
      await page.getByRole('button', { name: /Back to list/i }).click();
      await expectVisible(page, 'All Memories');
      await expectVisible(page, 'dashboard-e2e-memory');
      assert.equal(await page.getByPlaceholder(/Filter as you type/i).inputValue(), '', 'Back to list clears the ranked-search filter');

      // Tab switching on a real browser: the nav is a WAI-ARIA tablist
      // (tabs are role=tab, not plain buttons). The Project tab derives its
      // project list from the seeded `project:dashboard-e2e` tag and
      // auto-selects the only project. Scope the assertion to the Project
      // panel — the Memories panel stays mounted (hidden) after the switch
      // and also contains the project name.
      await page.getByRole('navigation').getByRole('tab', { name: 'Project' }).click();
      await page.locator('#panel-Project').getByText('dashboard-e2e', { exact: false }).first()
        .waitFor({ state: 'visible', timeout: 10000 });

      await page.getByRole('navigation').getByRole('tab', { name: 'Settings' }).click();
      // Target the language <select> specifically — Settings has multiple
      // <select> elements (model picker, auto-update policy, locale), so
      // a bare `select` selector is ambiguous. Find the one that contains
      // the zh-TW option, which only the language select does.
      const languageSelect = page.locator('select:has(option[value="zh-TW"])');
      await languageSelect.waitFor({ state: 'visible', timeout: 10000 });

      await page.evaluate(() => {
        window.__memeshSmokeMarker = 'persist';
      });
      await languageSelect.selectOption('zh-TW');
      await expectVisible(page, '語言');
      assert.equal(
        await page.evaluate(() => window.__memeshSmokeMarker),
        'persist',
        'Locale switch triggered a full reload'
      );

      await languageSelect.selectOption('en');
      await expectVisible(page, 'Language');
      assert.equal(
        await page.evaluate(() => window.__memeshSmokeMarker),
        'persist',
        'Locale switch back to English triggered a full reload'
      );

      // Exercise the current staged-work-package review path. The dashboard
      // may review an existing proposal, but must never call a provider,
      // generate a proposal, or rebuild a retired vector index.
      const reviewPage = await context.newPage();
      const reviewPageErrors = [];
      const reviewConsoleErrors = [];
      const reviewRequests = [];
      // Build these paths from segments so the repository's static client-route
      // inventory does not mistake this negative assertion for an HTTP call.
      const forbiddenRoutes = [
        'config/test', 'reindex', 'telemetry', 'dream/run',
        'consolidate', 'report-issue', 'report_issue',
      ].map((segment) => ['', 'v1', segment].join('/'));
      const proposal = {
        id: 1,
        project: 'dashboard-e2e',
        cluster_key: 'transcript:dashboard-e2e-session',
        source_count: 1,
        digest_name: 'dashboard-e2e-work-package',
        digest_observations_preview: 'Staged transcript proposal',
        status: 'pending',
        created_at: '2026-08-31 00:00:00',
        kind: 'digest',
        source_kind: 'transcript',
      };
      let proposalReads = 0;
      let rejectAttempts = 0;
      let proposalStatus = 'pending';
      let markDetailRequestStarted;
      let releaseDetailResponse;
      const detailRequestStarted = new Promise((resolve) => { markDetailRequestStarted = resolve; });
      const detailResponseReleased = new Promise((resolve) => { releaseDetailResponse = resolve; });
      reviewPage.on('request', (request) => reviewRequests.push(new URL(request.url()).pathname));
      reviewPage.on('pageerror', (error) => reviewPageErrors.push(error.message));
      reviewPage.on('console', (message) => {
        if (message.type() === 'error') reviewConsoleErrors.push(message.text());
      });
      reviewPage.on('dialog', (dialog) => dialog.accept());
      await reviewPage.route(/\/v1\/dream\/proposals\/1\/reject$/, async (route) => {
        assert.equal(route.request().method(), 'POST');
        rejectAttempts += 1;
        if (rejectAttempts === 1) {
          await route.fulfill({
            status: 404,
            contentType: 'application/json',
            body: JSON.stringify({ success: false, errorCode: 'resource.not-found', error: 'proposal disappeared' }),
          });
          return;
        }
        proposalStatus = 'rejected';
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { status: 'rejected' } }) });
      });
      await reviewPage.route(/\/v1\/dream\/proposals\/1$/, async (route) => {
        assert.equal(route.request().method(), 'GET');
        markDetailRequestStarted();
        await detailResponseReleased;
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: {
              ...proposal,
              status: proposalStatus,
              proposed_digest: {
                name: proposal.digest_name,
                type: 'decision',
                observations: ['A local agent staged this visible transcript finding.'],
                tags: ['project:dashboard-e2e'],
              },
              source_ids: {
                sessionId: 'dashboard-e2e-session',
                source: { host: 'claude-code', scope: 'mcp-workspace-root' },
                workspaceHash: 'a'.repeat(64),
                coverage: { truncated: true, total_turns: 3, included_turns: 2 },
                sources: [
                  { role: 'user', text: 'Visible redacted evidence: ***REDACTED***' },
                  { role: 'assistant', text: 'Bounded transcript conclusion.' },
                ],
                trust: 'untrusted',
              },
              reason: null,
              reviewed_at: null,
            },
          }),
        });
      });
      await reviewPage.route(/\/v1\/dream\/proposals(?:\?.*)?$/, async (route) => {
        assert.equal(route.request().method(), 'GET');
        proposalReads += 1;
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: [{ ...proposal, status: proposalStatus }] }),
        });
      });
      await reviewPage.goto(`${dashboardUrl}?tab=Home`, { waitUntil: 'networkidle' });
      await expectVisible(reviewPage, 'Staged memory proposals');
      await expectVisible(reviewPage, 'The Dashboard reviews proposals that are already staged');
      await expectVisible(reviewPage, 'dashboard-e2e-work-package');
      const acceptButton = reviewPage.getByRole('button', { name: 'Accept', exact: true });
      assert.equal(
        await acceptButton.isVisible(),
        false,
        'Accept must stay hidden while only the truncated summary is available',
      );
      await reviewPage.getByRole('button', { name: 'View detail', exact: true }).click();
      await detailRequestStarted;
      assert.equal(
        await acceptButton.isVisible(),
        false,
        'Accept must stay hidden until full proposal detail has loaded',
      );
      releaseDetailResponse();
      await expectVisible(reviewPage, 'A local agent staged this visible transcript finding.');
      const transcriptEvidence = reviewPage.getByTestId('transcript-source-evidence');
      await transcriptEvidence.waitFor({ state: 'visible', timeout: 10000 });
      const transcriptEvidenceText = await transcriptEvidence.innerText();
      assert.match(transcriptEvidenceText, /2\/3 sources/);
      assert.match(transcriptEvidenceText, /user\s+Visible redacted evidence: \*\*\*REDACTED\*\*\*/);
      assert.match(transcriptEvidenceText, /assistant\s+Bounded transcript conclusion\./);
      assert.equal(await acceptButton.isVisible(), true, 'Accept must appear after full proposal detail loads');
      assert.equal(await acceptButton.isEnabled(), true, 'Accept must be enabled after full proposal detail loads');

      await reviewPage.getByRole('button', { name: 'Reject', exact: true }).click();
      await expectVisible(reviewPage, 'That item no longer exists on the server');
      await reviewPage.getByRole('button', { name: 'Reject', exact: true }).click();
      await reviewPage.getByRole('button', { name: 'Rejected', exact: true }).click();
      await expectVisible(reviewPage, 'dashboard-e2e-work-package');
      assert.equal(rejectAttempts, 2, 'Reject should expose one stale-item failure and succeed on retry');
      assert.ok(proposalReads >= 2, `Proposal list should refresh after review (got ${proposalReads})`);
      assert.deepEqual(
        [...new Set(reviewRequests.filter((requestPath) => forbiddenRoutes.includes(requestPath)))],
        [],
        'Dashboard called a retired provider/vector route',
      );
      assert.deepEqual(reviewPageErrors, [], `Review page errors detected:\n${reviewPageErrors.join('\n')}`);
      assert.equal(reviewConsoleErrors.length, 1, 'The intentional stale-proposal 404 should be the only review console error');
      assert.match(reviewConsoleErrors[0], /404 \(Not Found\)/, 'The expected review console error must be the exercised 404');

      // Exercise the dependency-free fallback directly from the packed
      // module. A 200 with a malformed body must render an error, never a
      // truthful-looking empty state or editable default settings.
      const legacyPage = await context.newPage();
      const legacyPageErrors = [];
      legacyPage.on('pageerror', (error) => legacyPageErrors.push(error.message));
      const legacyModule = await import(pathToFileURL(path.join(packageRoot, 'dist', 'cli', 'view-live.js')).href);
      const legacyHtml = legacyModule.generateLiveDashboardHtml();
      await legacyPage.route('http://legacy.memesh.invalid/**', (route) => {
        const routeUrl = new URL(route.request().url());
        if (routeUrl.pathname === '/') {
          return route.fulfill({ contentType: 'text/html', body: legacyHtml });
        }
        if (routeUrl.pathname === '/v1/health') {
          return route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ success: true, data: { version: 'packaged', entity_count: 1 } }),
          });
        }
        if (['/v1/recall', '/v1/entities', '/v1/graph', '/v1/config'].includes(routeUrl.pathname)) {
          return route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ success: true, data: {} }),
          });
        }
        return route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, error: 'unexpected legacy route' }),
        });
      });
      await legacyPage.goto('http://legacy.memesh.invalid/', { waitUntil: 'networkidle' });

      await legacyPage.locator('#search-query').fill('malformed-shape');
      await legacyPage.locator('#search-btn').click();
      await expectVisible(legacyPage, 'Invalid search results response');

      await legacyPage.getByRole('button', { name: 'Browse', exact: true }).click();
      await legacyPage.locator('#browse-table-wrap').getByText('Invalid entities response').waitFor({ state: 'visible' });
      await legacyPage.getByRole('button', { name: 'Graph', exact: true }).click();
      await legacyPage.locator('#graph-svg-wrap').getByText('Invalid graph response').waitFor({ state: 'visible' });
      await legacyPage.getByRole('button', { name: 'Timeline', exact: true }).click();
      await legacyPage.locator('#timeline-body').getByText('Invalid graph response').waitFor({ state: 'visible' });
      await legacyPage.getByRole('button', { name: 'Manage', exact: true }).click();
      await legacyPage.locator('#manage-table-wrap').getByText('Invalid entities response').waitFor({ state: 'visible' });
      await legacyPage.getByRole('button', { name: 'Settings', exact: true }).click();
      await expectVisible(legacyPage, 'Failed to load config: Invalid config response');
      assert.deepEqual(legacyPageErrors, [], `Legacy dashboard page errors detected:\n${legacyPageErrors.join('\n')}`);

      assert.deepEqual(pageErrors, [], `Dashboard page errors detected:\n${pageErrors.join('\n')}`);
      assert.deepEqual(consoleErrors, [], `Dashboard console errors detected:\n${consoleErrors.join('\n')}`);
    } finally {
      await browser.close();
    }
  } finally {
    if (server.exitCode === null) {
      server.kill('SIGTERM');
      await onceExit(server);
    }
    fs.rmSync(smokeDir, { recursive: true, force: true });
  }

  console.log('Dashboard packaged e2e smoke passed');
}

async function expectVisible(page, text) {
  await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout: 10000 });
}

async function onceExit(child) {
  await new Promise((resolve) => {
    child.once('exit', () => resolve());
  });
}

// Guard so importing this module never fires npm pack / install / a browser
// launch as a side effect. Matches the idiom already used in
// scripts/hooks/auto-update-runner.mjs — realpathSync + pathToFileURL rather
// than `new URL(import.meta.url).pathname`, which
// tests/release-scripts-safety.test.ts's "resolves module paths with
// fileURLToPath" gate forbids repo-wide (it breaks on Windows drive paths).
const invokedPath = process.argv[1]
  ? pathToFileURL(fs.realpathSync(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
