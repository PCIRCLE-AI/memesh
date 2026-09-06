export interface MeMeshConfig {
    autoCapture?: boolean;
    sessionLimit?: number;
    autoUpdate?: 'off' | 'patch' | 'minor' | 'major';
    setupCompleted?: boolean;
}
export type ConfigReadState = 'ok' | 'absent' | 'unreadable';
export interface ConfigReadResult {
    config: MeMeshConfig;
    state: ConfigReadState;
}
export declare function readConfigResult(): ConfigReadResult;
export declare function readConfig(): MeMeshConfig;
export declare class ConfigUnreadableError extends Error {
    constructor(p: string);
}
export declare function updateConfig(partial: Partial<MeMeshConfig>): MeMeshConfig;
export declare function getConfigDir(): string;
export declare function getConfigPath(): string;
//# sourceMappingURL=config.d.ts.map