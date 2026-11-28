import fs from 'node:fs';
import path from 'node:path';
export function npmInvocation(args, platform = process.platform, execPath = process.execPath, exists = fs.existsSync) {
    if (platform !== 'win32')
        return { command: 'npm', args };
    const cli = path.win32.join(path.win32.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    return exists(cli) ? { command: execPath, args: [cli, ...args] } : null;
}
export class NpmStartError extends Error {
}
export function requireNpmInvocation(args) {
    const invocation = npmInvocation(args);
    if (!invocation)
        throw new NpmStartError('could not start npm: npm-cli.js was not found beside Node');
    return invocation;
}
//# sourceMappingURL=npm-launch.js.map