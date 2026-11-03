import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
export function findPackageRoot(moduleUrl) {
    let dir = path.dirname(fileURLToPath(moduleUrl));
    for (;;) {
        if (fs.existsSync(path.join(dir, 'package.json')))
            return dir;
        const up = path.dirname(dir);
        if (up === dir)
            throw new Error(`no package.json above ${fileURLToPath(moduleUrl)}`);
        dir = up;
    }
}
//# sourceMappingURL=package-root.js.map