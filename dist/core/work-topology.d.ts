export declare const LESSON_TYPE_LIST: readonly string[];
export declare function canonicalEntityType(type: string): string;
export declare const WORK_LAYER_TYPES: ReadonlySet<string>;
export declare const DECISION_LAYER_TYPES: readonly string[];
export declare const EVIDENCE_LAYER_TYPES: ReadonlySet<string>;
export declare function isAutoInjectable(metadata: unknown): boolean;
export type TopologyLayer = 'work' | 'knowledge' | 'evidence';
export declare function layerOf(type: string): TopologyLayer;
export interface TopologyEntity {
    name: string;
    type: string;
    id?: number;
    title?: string | null;
    snippet?: string | null;
    signalScore?: number | null;
    recency?: string | null;
    global?: boolean;
    foreign?: boolean;
}
export declare function topologyLine(entity: TopologyEntity, maxChars: number): string;
export declare function extractCitedMemoryIds(text: string): Set<number>;
export declare function sliceWholeChars(text: string, maxUnits: number): string;
export interface TopologySection {
    heading: string;
    entities: TopologyEntity[];
}
export declare function groupTopology(entities: TopologyEntity[], projectName: string): TopologySection[];
export interface TopologyBudget {
    maxChars: number;
    maxLineChars?: number;
}
export declare const DEFAULT_TOPOLOGY_BUDGET: Readonly<Required<TopologyBudget>>;
export declare const GLOBAL_TOPOLOGY_LIMIT = 3;
export declare const TOPOLOGY_CANDIDATE_CAP = 400;
export declare const SNIPPET_FETCH_CHARS: number;
export declare function buildTopologyLines(entities: TopologyEntity[], projectName: string, budget: TopologyBudget): string[];
export interface TopologyPool {
    entities: TopologyEntity[];
    foreign: boolean;
    global?: boolean;
}
export declare function assembleTopologyBlock(stateLines: readonly string[], pools: readonly TopologyPool[], projectName: string, budget?: TopologyBudget, { reserve }?: {
    reserve?: number;
}): string[];
export declare function joinedLength(lines: readonly string[]): number;
export declare function prioritizeDecisions<T extends {
    id: number;
}>(decisions: readonly T[], ranked: readonly T[], cap: number): T[];
export declare const TASK_STATE_DISPLAY_MAX_CHARS = 1200;
export declare function boundTaskStateLines(lines: readonly string[]): string[];
export declare function hasBriefingContent(lines: readonly string[]): boolean;
export declare function buildReferenceContext(memoryLines: ReadonlyArray<string | null | undefined>): string;
export declare function projectLabel(projectId: string): string;
//# sourceMappingURL=work-topology.d.ts.map