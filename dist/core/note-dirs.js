import { createHash } from 'crypto';
export function noteDirId(realDir) {
    return createHash('sha256').update(realDir).digest('hex').slice(0, 16);
}
//# sourceMappingURL=note-dirs.js.map