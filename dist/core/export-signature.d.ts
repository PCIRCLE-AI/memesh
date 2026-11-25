export interface ExportSignature {
    alg: 'hmac-sha256';
    mac: string;
}
export type ExportSignatureStatus = 'valid' | 'invalid' | 'absent';
export declare function signExport(bundle: Record<string, unknown>, key: Buffer): ExportSignature;
export declare function verifyExport(data: unknown, key: Buffer): ExportSignatureStatus;
export declare function exportSigningKey(dataDir: string, options: {
    create: boolean;
}): Buffer;
//# sourceMappingURL=export-signature.d.ts.map