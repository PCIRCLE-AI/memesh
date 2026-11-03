import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { currentLibc, platformPackage } from './runtime-platform.js';
import { errorMessage } from './types.js';
export function loadNative(runtimeDirectory) {
    const lockText = fs.readFileSync(path.join(runtimeDirectory, 'package-lock.json'), 'utf8');
    const name = platformPackage(lockText, process.platform, process.arch, currentLibc());
    const directory = path.join(runtimeDirectory, 'node_modules', name ?? 'none');
    let main;
    try {
        main = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).main;
    }
    catch {
        throw new Error(`the native networking file for ${process.platform}-${process.arch} is missing from the install`);
    }
    return createRequire(path.join(runtimeDirectory, 'package.json'))(path.join(directory, main));
}
export function explainLoadFailure(err) {
    const message = errorMessage(err).split('\n')[0];
    if (/is missing from the install$/.test(message))
        return message;
    if (err.code === 'ENOENT')
        return 'the networking component is not installed';
    return `the native networking file is damaged or cannot run here (${message.slice(0, 200)})`;
}
//# sourceMappingURL=native-loader.js.map