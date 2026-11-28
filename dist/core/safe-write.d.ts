export declare function refuse(label: string, target: string, what: string, ending?: string): Error;
export declare function whyFailed(err: unknown): string;
export declare function assertFolderWritable(dir: string): void;
export declare function assertCanWrite(file: string, label: string): void;
export declare function assertCanDelete(file: string, label: string): void;
export declare function readBytesOrNull(file: string): Buffer | null;
export declare class Changes {
    private undo;
    mkdir(dir: string): void;
    write(file: string, data: string): void;
    remove(file: string): void;
    copyNew(source: string, suffix: string): string;
    rollBack(): void;
}
//# sourceMappingURL=safe-write.d.ts.map