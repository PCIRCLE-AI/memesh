import path from 'node:path';
export const JOIN_ALPN = 'memesh/join/1';
export const NET_ALPN = 'memesh/net/1';
export const DEFAULT_RELAY_URL = 'https://relay.memesh.ai/';
export const RELAY_OFF = 'off';
export const EXIT_ALREADY_RUNNING = 3;
export const EXIT_LOCK_UNCONFIRMED = 4;
export const SINGLE_MACHINE_NOTE = 'Single-machine MeMesh keeps working.';
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
    const inherited = Object.entries(ctx.env ?? process.env).filter(([key]) => {
        const name = key.toUpperCase();
        return name !== 'NODE_PATH' && !name.startsWith('NAPI_RS_');
    });
    return { ...Object.fromEntries(inherited), MEMESH_DIR: ctx.dataDir, MEMESH_DB_PATH: ctx.dbPath };
}
export function safeForTerminal(text) {
    return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}
export function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
//# sourceMappingURL=types.js.map