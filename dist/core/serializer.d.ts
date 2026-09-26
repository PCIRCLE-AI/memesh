import type { ExportInput, ExportResult, ImportInput, ImportResult } from './types.js';
export declare const IMPORTABLE_METADATA_KEYS: ReadonlySet<string>;
export declare const AUTHORITY_METADATA_KEYS: ReadonlySet<string>;
export declare function exportMemories(args: ExportInput): ExportResult;
export declare function importMemories(args: ImportInput, options?: {
    trust?: boolean;
}): ImportResult;
//# sourceMappingURL=serializer.d.ts.map