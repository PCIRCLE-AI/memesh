export interface ProjectRetag {
    from: string;
    to: string;
}
export declare function withFullProjectTag(tags: readonly string[] | undefined, projectId: string | undefined): {
    tags: string[] | undefined;
    retagged?: ProjectRetag;
};
//# sourceMappingURL=plain-project-tag.d.ts.map