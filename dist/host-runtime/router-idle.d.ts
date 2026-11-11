import type { MemeshDatabase } from '../storage/sqlite.js';
export declare const DEFAULT_ROUTER_IDLE_MS: number;
export declare const DEFAULT_ROUTER_IDLE_CHECK_MS = 30000;
export declare function routerIdleSettings(env: NodeJS.ProcessEnv, warn?: (line: string) => void): {
    idleMs: number;
    checkMs: number;
};
export declare function routerHasWork(db: MemeshDatabase, nowMs: number): boolean;
export declare const ROUTER_IDLE_EXIT_KEY = "router_idle_exit_at";
export declare function recordRouterIdleExit(db: MemeshDatabase, at?: Date): void;
export declare function readRouterIdleExit(db: MemeshDatabase): string | undefined;
export interface RouterIdleWatch {
    check(): void;
    stop(): void;
}
export declare function watchRouterIdle(options: {
    db: MemeshDatabase;
    idleMs: number;
    checkMs: number;
    onIdle: () => void;
    now?: () => number;
}): RouterIdleWatch;
//# sourceMappingURL=router-idle.d.ts.map