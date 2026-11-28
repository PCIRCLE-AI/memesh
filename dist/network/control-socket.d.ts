import fs from 'node:fs';
import { type MembershipAction, type MembershipResult } from './membership.js';
export declare function controlPath(dataDir: string): string;
export declare function controlPathFits(dataDir: string): boolean;
export declare function assertControlPathFits(dataDir: string): void;
export type BridgeProbe = {
    kind: 'running';
    pid: number;
    ready: boolean;
} | {
    kind: 'not-running';
} | {
    kind: 'unresponsive';
};
export declare function probeBridge(dataDir: string, deadlineMs?: number): Promise<BridgeProbe>;
export declare function askBridgeToStop(dataDir: string, expectedPid?: number): Promise<boolean>;
export declare function askBridgeMembership(dataDir: string, action: MembershipAction, expectedPid: number): Promise<MembershipResult>;
interface FileIdentity {
    dev: number;
    ino: number;
}
export declare function identityOf(file: string): FileIdentity | null;
export declare function readPidLock(lock: string): {
    stat: fs.Stats;
    raw: string;
} | null;
export declare function takeOverStaleLock(lock: string, judged: FileIdentity): void;
export declare function processIsGone(pid: number): boolean;
export declare function removeStaleSocket(target: string, judged: FileIdentity | null): void;
export interface ControlHandlers {
    isReady(): boolean;
    stop(): void;
    onProblem(message: string): void;
    membership?(action: MembershipAction): Promise<{
        result: MembershipResult;
        afterReply?: () => void;
    }>;
}
export type Ownership = 'ours' | 'lost' | 'unreadable';
export type ControlHold = {
    kind: 'held';
    ownership(): Ownership;
    stillOurs(): boolean;
    close(): void;
} | {
    kind: 'already-running';
} | {
    kind: 'holder-unresponsive';
};
export declare function holdControlSocket(dataDir: string, handlers: ControlHandlers): Promise<ControlHold>;
export {};
//# sourceMappingURL=control-socket.d.ts.map