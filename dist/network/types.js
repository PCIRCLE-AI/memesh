import path from 'node:path';
export const JOIN_ALPN = 'memesh/join/1';
export const NET_ALPN = 'memesh/net/1';
export const DEFAULT_RELAY_URL = 'https://relay.memesh.ai/';
export const RELAY_OFF = 'off';
export const EXIT_ALREADY_RUNNING = 3;
export const SINGLE_MACHINE_NOTE = 'Single-machine MeMesh keeps working; nothing else was changed.';
export class NetworkError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'NetworkError';
        this.code = code;
    }
}
export function networkDir(dataDir) {
    return path.join(dataDir, 'network');
}
export function runtimeDir(dataDir) {
    return path.join(networkDir(dataDir), 'runtime');
}
export function childEnv(ctx) {
    return { ...(ctx.env ?? process.env), MEMESH_DIR: ctx.dataDir, MEMESH_DB_PATH: ctx.dbPath };
}
export function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
//# sourceMappingURL=types.js.map