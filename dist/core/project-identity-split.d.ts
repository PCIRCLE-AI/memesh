import type { MemeshDatabase } from '../storage/sqlite.js';
export interface ProjectIdentitySplit {
    plain: string;
    ids: string[];
    activeMemories: number;
}
export declare function findProjectIdentitySplits(db: MemeshDatabase): ProjectIdentitySplit[];
//# sourceMappingURL=project-identity-split.d.ts.map