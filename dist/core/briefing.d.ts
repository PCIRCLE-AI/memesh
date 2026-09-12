import { type BriefingIndex } from './briefing-index.js';
import type { MemeshDatabase } from '../storage/sqlite.js';
export interface BriefingResult {
    project: string;
    text: string;
    entityCount: number;
    hasTaskState: boolean;
    index: BriefingIndex;
}
export declare function readBriefingIndex(db: MemeshDatabase, projectName: string, now?: number): BriefingIndex;
export declare function assembleBriefing(project?: string, recipient?: string): BriefingResult;
//# sourceMappingURL=briefing.d.ts.map