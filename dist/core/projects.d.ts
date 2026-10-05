import type { MemeshDatabase } from '../storage/sqlite.js';
export { extractProjectFromName, extractProjectFromEntity } from './project-attribution.js';
export declare const NOT_A_PROJECT_MEMORY: {
    readonly sql: "e.type <> ?";
    readonly param: "session-handoff";
};
export interface ProjectInfo {
    name: string;
    count: number;
    types: string[];
    source: 'tag' | 'heuristic' | 'mixed';
}
export declare function computeProjects(db: MemeshDatabase): ProjectInfo[];
//# sourceMappingURL=projects.d.ts.map