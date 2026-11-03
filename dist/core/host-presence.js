import fs from 'fs';
import path from 'path';
import { pluginHostConfigRoot } from './install-channel.js';
export function isOnPath(tool) {
    const exts = process.platform === 'win32'
        ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
        : [''];
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
        if (!dir)
            continue;
        for (const ext of exts) {
            try {
                const candidate = path.join(dir, tool + ext);
                fs.accessSync(candidate, fs.constants.X_OK);
                if (fs.statSync(candidate).isFile())
                    return true;
            }
            catch { }
        }
    }
    return false;
}
export function claudeCodePresent(existsSyncImpl = fs.existsSync, onPath = isOnPath, configDir = pluginHostConfigRoot('claude-code')) {
    return existsSyncImpl(configDir) || onPath('claude');
}
export function codexPresent(existsSyncImpl = fs.existsSync, onPath = isOnPath) {
    return existsSyncImpl(pluginHostConfigRoot('codex')) || onPath('codex');
}
export function geminiPresent(onPath = isOnPath) {
    return onPath('gemini');
}
//# sourceMappingURL=host-presence.js.map