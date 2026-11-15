// ============================================================================
// AUTO-GENERATED from src/network/types.ts — DO NOT EDIT BY HAND.
// Regenerate with: npm run build  (scripts/generate-hook-core.mjs)
//
// Claude Code hooks import this committed copy instead of dist/, so the
// always-on capture path survives a missing or stale dist/ while staying
// byte-locked to core — eliminating the hand-mirror drift behind the P0 FTS bug.
// ============================================================================
import path from 'node:path';
export const JOIN_ALPN = 'memesh/join/1';
export const NET_ALPN = 'memesh/net/2';
export const DEFAULT_RELAY_URL = 'https://relay.memesh.ai/';
export const RELAY_OFF = 'off';
export const EXIT_ALREADY_RUNNING = 3;
export const EXIT_HOLDER_UNRESPONSIVE = 4;
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
export function networkMetadataPath(dataDir) {
    return path.join(networkDir(dataDir), 'metadata.db');
}
export function runtimeDir(dataDir) {
    return path.join(networkDir(dataDir), 'runtime');
}
export function childEnv(ctx) {
    const inherited = Object.entries(ctx.env ?? process.env).filter(([key]) => key.toUpperCase() !== 'NODE_PATH');
    return { ...Object.fromEntries(inherited), MEMESH_DIR: ctx.dataDir, MEMESH_DB_PATH: ctx.dbPath };
}
export function safeForTerminal(text) {
    return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}
export function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
