import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// Plain JS build helper with no type declarations — the same derivation the
// build's chmod step and the packaged-artifact smoke test use.
const { hookCommands, binTargets } = require('../scripts/lib/executable-targets.mjs') as {
  hookCommands: (packageDir: string) => string[];
  binTargets: (packageDir: string) => string[];
};

describe('Installation Verification', () => {
  describe('Prerequisites', () => {
    it('runs on a supported Node security release', () => {
      const version = execFileSync('node', ['-v'], { encoding: 'utf8' }).trim();
      const [major, minor, patch] = version.slice(1).split('.').map(Number);
      const floors: Record<number, [number, number]> = { 22: [23, 5], 24: [22, 3], 26: [13, 1] };
      const floor = floors[major];
      expect(floor && (minor > floor[0] || (minor === floor[0] && patch >= floor[1]))).toBe(true);
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      expect(pkg.engines.node).toBe('^22.23.5 || ^24.22.3 || ^26.13.1');
      for (const floor of ['22.23.5', '24.22.3', '26.13.1']) {
        expect(fs.readFileSync('llms-install.md', 'utf8')).toContain(floor);
      }
    });

    it('llms-install.md states the floor at each place a reader acts on it, and no older one', () => {
      const guide = fs.readFileSync('llms-install.md', 'utf8');
      // section 1 (plugin): the banner on a Node that cannot be used; section 2: the check, and the failure table
      for (const phrase of ['MeMesh supports Node 26.13.1', 'supported security floors are 22.23.5, 24.22.3', '`v22.23.5` or later within 22.x', 'Upgrade to one of the supported security releases above']) {
        expect(guide, phrase).toContain(phrase);
      }
      expect(guide).not.toMatch(/22\.1[0-5](\.|\b)/);
    });
  });

  describe('Configuration Files', () => {
    it('should have package.json with correct name', () => {
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      expect(pkg.name).toBe('@pcircle/memesh');
    });

    it('should have .claude-plugin/plugin.json with matching version', () => {
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      const plugin = JSON.parse(fs.readFileSync('.claude-plugin/plugin.json', 'utf8'));
      expect(plugin.version).toBe(pkg.version);
    });

    it('declares the Claude MCP manifest on a path Claude Code does NOT auto-discover as a project config', () => {
      // The root `.mcp.json` this replaced was auto-discovered TWICE: by the
      // plugin loader, where `${CLAUDE_PLUGIN_ROOT}` resolves, and as a
      // project-scoped config for anyone who merely opened this repository,
      // where it does not — `claude mcp list` reported "Missing environment
      // variables: CLAUDE_PLUGIN_ROOT" and the server died with `-32000
      // Connection closed`. The old test here asserted `.mcp.json` EXISTS,
      // so it held the defect in place for three and a half months.
      //
      // Custom component paths SUPPLEMENT the defaults rather than replacing
      // them, so declaring a path is only half of it: the root file has to be
      // gone, or both still load.
      const plugin = JSON.parse(fs.readFileSync('.claude-plugin/plugin.json', 'utf8'));
      expect(plugin.mcpServers).toBe('./.claude-plugin/mcp.json');
      expect(fs.existsSync('.mcp.json')).toBe(false);

      const mcp = JSON.parse(fs.readFileSync('.claude-plugin/mcp.json', 'utf8'));
      expect(mcp.mcpServers.memesh).toEqual({
        command: 'node',
        args: ['${CLAUDE_PLUGIN_ROOT}/dist/mcp/server.js'],
      });
    });

    it('declares the bundled MCP server in the Codex plugin manifest', () => {
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      const plugin = JSON.parse(fs.readFileSync('.codex-plugin/plugin.json', 'utf8'));
      expect(plugin.version).toBe(pkg.version);
      expect(plugin.mcpServers).toBe('./.codex-plugin/mcp.json');
      const mcp = JSON.parse(fs.readFileSync(plugin.mcpServers, 'utf8'));
      expect(Object.keys(mcp)).toEqual(['mcpServers']);
      // The exact server entry is pinned in plugin-mcp-manifest.test.ts.
      expect(mcp.mcpServers.memesh).toMatchObject({
        command: 'node',
        args: ['./dist/mcp/server.js'],
        cwd: '.',
      });
    });

    it('hooks.json declares the canonical Claude Code hook event types and references real script files', () => {
      // Asserts shape and integrity, NOT a hardcoded count. Hardcoded
      // counts drift silently when a new hook is added (this test
      // previously required N=5 but the project shipped N=6 for an
      // entire release cycle without anyone noticing — only a
      // pre-release verify caught it). New hooks now extend this
      // assertion automatically as long as they reference a real script.
      const hooks = JSON.parse(fs.readFileSync('hooks/hooks.json', 'utf8'));
      const hookTypes = Object.keys(hooks.hooks);

      // 1. Must be non-empty and a subset of Claude Code's known event types.
      const ALLOWED_HOOK_EVENTS = [
        'PreToolUse', 'PostToolUse',
        'SessionStart', 'SessionEnd',
        'Stop', 'SubagentStop',
        'PreCompact',
        'UserPromptSubmit',
        'Notification',
      ];
      expect(hookTypes.length).toBeGreaterThan(0);
      for (const event of hookTypes) {
        expect(ALLOWED_HOOK_EVENTS).toContain(event);
      }

      // 2. Every declared hook must reference a script file that exists
      //    on disk under scripts/hooks/. This catches the inverse drift
      //    (hooks.json grows but the script never lands in the package).
      const declaredScripts = new Set<string>();
      // Each value in hooks.hooks is an ARRAY of matcher objects, so the cast
      // needs both levels — the previous one-level version described the
      // element type and made `for (const entry of arr)` a type error.
      const matcherGroups = Object.values(hooks.hooks) as Array<
        Array<{ hooks?: Array<{ command?: string }> }>
      >;
      for (const arr of matcherGroups) {
        for (const entry of arr ?? []) {
          for (const h of entry.hooks ?? []) {
            if (typeof h.command === 'string') {
              const m = h.command.match(/scripts\/hooks\/([\w-]+\.js)/);
              if (m) declaredScripts.add(m[1]);
            }
          }
        }
      }
      expect(declaredScripts.size).toBeGreaterThan(0);
      for (const script of declaredScripts) {
        expect(fs.existsSync(`scripts/hooks/${script}`)).toBe(true);
      }
    });

    it('ships skills via the default-discovery `skills/` directory', () => {
      // The new Claude Code plugin schema auto-discovers components from
      // default locations; explicit refs in plugin.json are only needed
      // for non-default paths. So this asserts the directory itself
      // exists rather than checking plugin.json for an explicit `skills`
      // field (which we deliberately omit so the manifest stays minimal).
      expect(fs.existsSync('skills')).toBe(true);
      expect(fs.statSync('skills').isDirectory()).toBe(true);
    });
  });

  describe('Hook Scripts', () => {
    // Derived from both host manifests, not written out here. The hand-written
    // version of this list said five while the project shipped seven, and
    // ci.yml documents that exact drift as a past incident that "went
    // unnoticed for a full release cycle". A list that has to be updated by
    // hand when a hook is added is a list that will be wrong.
    const hookFiles = hookCommands(process.cwd());

    it('covers every hook the plugin manifest declares', () => {
      // Guards the derivation itself: if the shape of hooks.json changes and
      // the parse silently yields nothing, every case below would vacuously
      // pass by iterating an empty list.
      expect(hookFiles.length).toBeGreaterThanOrEqual(6);
    });

    it('includes executable hooks declared only by the Codex plugin', () => {
      expect(hookFiles).toContain('scripts/hooks/codex-busy-message-notice.js');
      expect(hookFiles).toContain('scripts/hooks/codex-plan-activity.js');
      expect(new Set(hookFiles).size).toBe(hookFiles.length);
    });

    it.each(hookFiles)('%s should exist and be executable', (hookPath) => {
      expect(fs.existsSync(hookPath)).toBe(true);
      if (process.platform !== 'win32') {
        const stat = fs.statSync(hookPath);
        expect(stat.mode & 0o111).toBeTruthy();
      }
    });
  });

  describe('Declared commands', () => {
    // package.json `bin` is the other manifest the executable-bit list is
    // derived from. `dist/transports/cli/cli.js` — the `memesh` command — and
    // `dist/transports/http/server.js` were both committed at mode 100644
    // because the hand-written chmod list had drifted from `bin` in both
    // directions.
    const commands = binTargets(process.cwd());

    it.each(commands)('%s should exist and be executable', (binPath) => {
      expect(fs.existsSync(binPath)).toBe(true);
      if (process.platform !== 'win32') {
        const stat = fs.statSync(binPath);
        expect(stat.mode & 0o111).toBeTruthy();
      }
    });
  });

  describe('Skills', () => {
    it('should have memesh skill', () => {
      expect(fs.existsSync('skills/memesh/SKILL.md')).toBe(true);
    });

    it('should have memesh-review skill', () => {
      expect(fs.existsSync('skills/memesh-review/SKILL.md')).toBe(true);
    });

    it('teaches durable message delivery without claiming stopped-session wakeup', () => {
      const skill = fs.readFileSync('skills/memesh/SKILL.md', 'utf8');
      expect(skill).toContain('exactly four actions');
      for (const action of ['discover', 'send', 'read', 'status']) {
        expect(skill).toContain(`\`${action}\``);
      }
      expect(skill).toContain('Queued is not delivery, read, reply, completion, wakeup, or authorization');
      expect(skill).toContain('Output must succeed before delivery is recorded');
      expect(skill).toContain('Private hook/MCP checks do not establish native-host/model reading or wakeup');
      expect(skill).toContain('older HTTP agent-message protocol remains compatibility-only');
    });

    it('separates conversation actions from optional owner-only legacy host setup', () => {
      const install = fs.readFileSync('llms-install.md', 'utf8');
      const guide = fs.readFileSync('docs/platforms/agent-messaging.md', 'utf8');
      expect(install).toContain('Optional legacy local-host setup');
      expect(install).toContain('conversation MCP/CLI interface needs no router setup command');
      expect(install).toContain('Keep its private configuration owner-only and require explicit Channel admission');
      expect(install).toContain('`memesh-router` is its owner diagnostic/legacy entrypoint, not a prerequisite');
      expect(install).toContain('Host-native/Codex acceptance remains separate runtime verification');
      for (const document of [install, guide]) {
        for (const action of ['discover', 'send', 'read', 'status']) {
          expect(document).toContain(`\`${action}\``);
        }
        expect(document).toContain('--payload-stdin');
        expect(document).toContain('8,000 UTF-8 bytes');
        expect(document).toContain('14 days');
      }
      expect(guide).toContain('Identity is derived from the host session');
      expect(guide).toContain('Do not pass `project`, `sender`');
      expect(guide).toContain('`send` reads its body from stdin, never an argv body flag');
      expect(guide).toContain('Do not mix its `poll`, `fetch`, `intake`, `ack`, `disposition`, or `receipts` fields into a conversation call');
      expect(guide).toContain('Private subprocess/MCP checks do not prove native-host execution, wakeup or model reading');
    });
  });

  describe('Bin Entries', () => {
    it('should have exactly the supported user, server, router, and host-adapter bin entries', () => {
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      const bins = Object.keys(pkg.bin);
      // memesh-view was retired: it was a third dashboard implementation
      // (static snapshot) alongside view-live.ts and the Preact dashboard,
      // and every dashboard change was a three-place edit.
      expect(bins.sort()).toEqual([
        'memesh',
        'memesh-http',
        'memesh-mcp',
        'memesh-router',
        'memesh-host-claude',
        'memesh-host-codex',
        'memesh-host-codex-session',
        'memesh-host-acp',
      ].sort());
    });
  });

  describe('Retired web UI', () => {
    it('does not retain dashboard or HTML fallback build output', () => {
      expect(fs.existsSync('dashboard/dist/index.html')).toBe(false);
      expect(fs.existsSync('dist/cli/view-live.js')).toBe(false);
    });
  });
});
