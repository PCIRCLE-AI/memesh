import { type BriefingIndex } from './briefing-index.js';
import type { MemeshDatabase } from '../storage/sqlite.js';
import { type BriefingLevel } from './briefing-level.js';
export interface BriefingResult {
    project: string;
    text: string;
    entityCount: number;
    hasTaskState: boolean;
    hasHandoff: boolean;
    index: BriefingIndex;
    level: BriefingLevel;
    empty: boolean;
}
export declare function readBriefingIndex(db: MemeshDatabase, projectName: string, now?: number, projectIds?: readonly string[]): BriefingIndex;
export declare function assembleBriefing(project?: string, _recipient?: string, projectIds?: readonly string[], continuationScope?: {
    workspace: string | null;
    session?: string;
}): BriefingResult;
//# sourceMappingURL=briefing.d.ts.map