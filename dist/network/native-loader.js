import { createRequire } from 'node:module';
import path from 'node:path';
import { errorMessage } from './types.js';
export function loadNative(runtimeDirectory) {
    const requireFromRuntime = createRequire(path.join(runtimeDirectory, 'package.json'));
    return requireFromRuntime('@number0/iroh');
}
export function explainLoadFailure(err) {
    const messages = [];
    for (let at = err; at instanceof Error && messages.length < 16; at = at.cause) {
        messages.push(at.message);
    }
    const specific = messages.find((message) => /^Unsupported /.test(message));
    if (specific)
        return `this computer is not supported (${specific})`;
    if (messages.length === 1 && err.code === 'MODULE_NOT_FOUND') {
        return 'the networking component is not installed';
    }
    const mismatch = messages.find((message) => /version mismatch/.test(message));
    if (mismatch)
        return `the installed networking files do not match each other (${mismatch})`;
    const damaged = messages.find((message) => /dlopen|slice is not valid|too short|file too|not a mach-o|invalid ELF|wrong ELF|code signature/i.test(message));
    if (damaged)
        return `the native networking file is damaged or cannot run here (${damaged.split('\n')[0].slice(0, 200)})`;
    if (messages.some((message) => /npm has a bug|Cannot find native binding/.test(message))) {
        return `the native networking file for ${process.platform}-${process.arch} is missing from the install`;
    }
    return errorMessage(err).split('\n')[0];
}
//# sourceMappingURL=native-loader.js.map