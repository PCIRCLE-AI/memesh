export interface MemoryEditFields {
    title: string;
    observations: string[];
}
export interface MemoryEditView {
    title: string;
    body: string;
    observations: string[];
    name: string;
    project: string | null;
    type: string;
    createdAt: string;
}
export declare function editMemoryInteractively(name: string, project: string | null, sourceHost: string | undefined, ask: (view: MemoryEditView, observations: readonly string[]) => Promise<MemoryEditFields | null | undefined>, expectedRevision?: string): Promise<{
    status: string;
    memory: MemoryEditView;
    revision: string;
} | {
    status: string;
    memory: MemoryEditView;
    revision?: undefined;
}>;
//# sourceMappingURL=native-memory-editor.d.ts.map