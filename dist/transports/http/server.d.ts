#!/usr/bin/env node
import { checkForUpdate, getLastUpdateCheck } from '../../core/version-check.js';
declare const app: import("express-serve-static-core").Express;
export declare function isLoopbackRequest(req: {
    ip?: string;
}): boolean;
export interface RemoteTokenLoad {
    token: Buffer;
    freshlyCreated: boolean;
    source: 'env' | 'file';
    envIgnored: boolean;
    tokenPath: string;
}
export declare function loadOrCreateRemoteToken(): RemoteTokenLoad;
export declare function remoteTokenStartupNotice(load: Pick<RemoteTokenLoad, 'freshlyCreated' | 'source' | 'envIgnored' | 'tokenPath'>): string;
export declare function isLoopbackHost(host: string): boolean;
export declare function startServer(host?: string, port?: number, opts?: {
    allowRemote?: boolean;
    autoUpdateCheck?: boolean;
    agentMessageExpiry?: boolean;
    updateCheckImpl?: typeof checkForUpdate;
    lastUpdateCheckImpl?: typeof getLastUpdateCheck;
}): ReturnType<typeof app.listen>;
export declare function __setRemoteTokenForTest(value: Buffer | null): void;
export { app };
//# sourceMappingURL=server.d.ts.map