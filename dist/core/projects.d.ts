import type { MemeshDatabase } from '../storage/sqlite.js';
export { extractProjectFromName, extractProjectFromEntity } from './project-attribution.js';
export interface ProjectInfo {
    name: string;
    count: number;
    types: string[];
    source: 'tag' | 'heuristic' | 'mixed';
}
export declare function computeProjects(db: MemeshDatabase): ProjectInfo[];
//# sourceMappingURL=projects.d.ts.map