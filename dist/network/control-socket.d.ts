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
export declare function askBridgeToStop(dataDir: string): Promise<boolean>;
export interface ControlHandlers {
    isReady(): boolean;
    stop(): void;
    onProblem(message: string): void;
}
export type ControlHold = {
    kind: 'held';
    close(): void;
} | {
    kind: 'already-running';
} | {
    kind: 'holder-unresponsive';
};
export declare function holdControlSocket(dataDir: string, handlers: ControlHandlers): Promise<ControlHold>;
//# sourceMappingURL=control-socket.d.ts.map