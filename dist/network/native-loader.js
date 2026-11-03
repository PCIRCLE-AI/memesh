import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { currentLibc, nativeFileName, platformPackage } from './runtime-platform.js';
import { errorMessage } from './types.js';
export function loadNative(runtimeDirectory) {
    const lockText = fs.readFileSync(path.join(runtimeDirectory, 'package-lock.json'), 'utf8');
    const name = platformPackage(lockText, process.platform, process.arch, currentLibc());
    const missing = `the native networking file for ${process.platform}-${process.arch} is missing from the install`;
    if (name === null)
        throw new Error(missing);
    let file;
    try {
        file = fs.realpathSync(path.join(runtimeDirectory, 'node_modules', name, nativeFileName(name)));
    }
    catch {
        throw new Error(missing);
    }
    if (!file.startsWith(fs.realpathSync(runtimeDirectory) + path.sep)) {
        throw new Error('the native networking file points outside the install, so it was not loaded');
    }
    return createRequire(path.join(runtimeDirectory, 'package.json'))(file);
}
export function explainLoadFailure(err) {
    const message = errorMessage(err).split('\n')[0];
    if (/is missing from the install$|points outside the install/.test(message))
        return message;
    if (err.code === 'ENOENT')
        return 'the networking component is not installed';
    return `the native networking file is damaged or cannot run here (${message.slice(0, 200)})`;
}
//# sourceMappingURL=native-loader.js.map