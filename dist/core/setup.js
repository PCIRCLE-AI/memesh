import fs from 'fs';
import path from 'path';
import { detectPluginRuntime, settingsHaveMemeshHooks } from './install-hooks.js';
import { pluginHostConfigRoot } from './install-channel.js';
import { claudeCodePresent, codexPresent, geminiPresent } from './host-presence.js';
function inspectClaudeCode(seams) {
    const relocated = seams.claudeConfigDir ? seams.claudeConfigDir() : process.env.CLAUDE_CONFIG_DIR;
    const claudeDir = relocated ? path.resolve(relocated) : path.join(seams.home(), '.claude');
    const present = claudeCodePresent(fs.existsSync, seams.isOnPath, claudeDir);
    const status = {
        host: 'claude-code',
        title: 'Claude Code',
        present,
        presenceDetail: fs.existsSync(claudeDir) ? claudeDir : present ? 'claude on PATH' : `claude on PATH, or ${claudeDir}`,
        wired: null,
        wiredDetail: '',
        actions: [],
    };
    if (!present) {
        status.wiredDetail = 'not on this machine — nothing to wire';
        return status;
    }
    const plugin = detectPluginRuntime(seams.installedPluginsPath ?? path.join(claudeDir, 'plugins', 'installed_plugins.json'));
    if (plugin) {
        status.wired = true;
        status.wiredDetail = `plugin v${plugin.version} manages hooks, MCP and skills (installed_plugins.json)`;
        return status;
    }
    const settingsPath = path.join(claudeDir, 'settings.json');
    const hooksWired = settingsHaveMemeshHooks(settingsPath);
    let mcpWired = null;
    let mcpDetail;
    if (seams.isOnPath('claude')) {
        const probe = seams.run('claude', ['mcp', 'get', 'memesh']);
        mcpWired = probe.status === 0;
        mcpDetail = mcpWired ? 'claude mcp get memesh → registered' : 'claude mcp get memesh → not registered';
    }
    else {
        mcpDetail = 'claude CLI not on PATH — cannot probe MCP registration';
    }
    status.wired = hooksWired ? mcpWired : false;
    status.wiredDetail = `${hooksWired ? 'hooks wired (settings.json)' : 'hooks NOT wired (no _memesh marker in settings.json)'}; ${mcpDetail}`;
    if (!hooksWired) {
        status.actions.push({
            kind: 'install-hooks',
            label: `Wire the session hooks into ${path.join(claudeDir, 'settings.json')} (backs the file up first)`,
        });
    }
    if (mcpWired === false) {
        status.actions.push({
            kind: 'run',
            label: 'Register the MCP server with Claude Code (user scope, all folders)',
            cmd: 'claude',
            args: ['mcp', 'add', '-s', 'user', 'memesh', 'memesh-mcp'],
        });
    }
    return status;
}
function inspectCodex(seams) {
    const onPath = seams.isOnPath('codex');
    const codexDir = pluginHostConfigRoot('codex');
    const present = codexPresent(fs.existsSync, seams.isOnPath);
    const status = {
        host: 'codex',
        title: 'Codex CLI',
        present,
        presenceDetail: onPath ? 'codex on PATH' : present ? codexDir : `codex on PATH, or ${codexDir}`,
        wired: null,
        wiredDetail: present ? '' : 'not on this machine — nothing to wire',
        actions: [],
    };
    if (!present)
        return status;
    if (!onPath) {
        status.wiredDetail = 'Codex\'s config directory exists but the codex command is not on PATH — cannot probe MCP registration';
        status.unprobed = true;
        return status;
    }
    const probe = seams.run('codex', ['mcp', 'get', 'memesh']);
    if (probe.status === null) {
        status.wiredDetail = 'codex mcp get failed to run — could not determine';
        status.unprobed = true;
    }
    else {
        status.wired = probe.status === 0;
        status.wiredDetail = status.wired ? 'codex mcp get memesh → registered' : 'codex mcp get memesh → not registered';
        if (!status.wired) {
            status.actions.push({
                kind: 'run',
                label: 'Register the MCP server with Codex CLI',
                cmd: 'codex',
                args: ['mcp', 'add', 'memesh', '--', 'memesh-mcp'],
            });
        }
    }
    return status;
}
function inspectGemini(seams) {
    const present = geminiPresent(seams.isOnPath);
    const status = {
        host: 'gemini',
        title: 'Gemini CLI',
        present,
        presenceDetail: 'gemini on PATH',
        wired: null,
        wiredDetail: present ? '' : 'not on this machine — nothing to wire',
        actions: [],
    };
    if (!present)
        return status;
    const settingsPath = path.join(seams.home(), '.gemini', 'settings.json');
    let wired = false;
    try {
        const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        wired = Boolean(parsed.mcpServers && Object.prototype.hasOwnProperty.call(parsed.mcpServers, 'memesh'));
    }
    catch { }
    status.wired = wired;
    status.wiredDetail = wired
        ? 'mcpServers.memesh present in ~/.gemini/settings.json'
        : 'no mcpServers.memesh in ~/.gemini/settings.json';
    if (!wired) {
        status.actions.push({
            kind: 'run',
            label: 'Register the MCP server with Gemini CLI (user scope, all folders)',
            cmd: 'gemini',
            args: ['mcp', 'add', '-s', 'user', 'memesh', 'memesh-mcp'],
        });
    }
    return status;
}
export function inspectHosts(seams) {
    return [inspectClaudeCode(seams), inspectCodex(seams), inspectGemini(seams)];
}
export function unverifiedHosts(statuses) {
    return statuses.filter((s) => s.present && s.wired === null && !s.unprobed);
}
export function wiredClosing(statuses) {
    const unverified = unverifiedHosts(statuses);
    if (unverified.length === 0)
        return 'Everything present is wired. Nothing to do.';
    const what = unverified.map((s) => `${s.title} (${s.wiredDetail.split('; ').pop()})`).join(' and ');
    return `Everything that could be checked is wired. Not checked: ${what}. To check it, put the command on PATH and run \`memesh setup --check\` again.`;
}
export function allWired(statuses) {
    return statuses.every((s) => !s.present || (s.actions.length === 0 && s.wired !== false && !s.unprobed));
}
export function noHostMessage(statuses) {
    if (statuses.length === 0 || statuses.some((s) => s.present))
        return null;
    const looked = statuses.map((s) => `  - ${s.title}: ${s.presenceDetail}`).join('\n');
    return `No supported agent host was found on this machine, so memesh changed nothing and connected to nothing. Looked for:\n${looked}\n\nInstall Claude Code or Codex (or Gemini CLI), then run \`memesh setup\` again.`;
}
//# sourceMappingURL=setup.js.map