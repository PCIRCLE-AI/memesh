export interface Identity {
    secret: Buffer;
    machineId: string;
    sign(message: Buffer): string;
}
export declare function isMachineId(value: unknown): value is string;
export declare function identityPath(dataDir: string): string;
export declare function ensureNetworkDir(dataDir: string): string;
export declare function loadIdentity(dataDir: string): Identity;
export declare function ensureIdentity(dataDir: string): Identity;
export declare function verifySignature(machineId: string, message: Buffer, signature: string): boolean;
//# sourceMappingURL=identity.d.ts.map