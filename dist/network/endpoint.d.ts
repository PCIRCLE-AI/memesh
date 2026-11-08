import type { Endpoint, IrohModule } from './iroh-types.js';
export declare function toBytes(value: string | Buffer): number[];
export declare function deadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T>;
export declare const TEST_BIND_VARIABLE = "MEMESH_TEST_NETWORK_BIND";
export declare function testBindAddress(value: string | undefined): string | null;
export declare function advertisedAddresses(endpoint: Endpoint, env?: NodeJS.ProcessEnv): string[];
export declare function bindEndpoint(iroh: IrohModule, secret: Buffer, relay: string, alpns: string[], env?: NodeJS.ProcessEnv): Promise<Endpoint>;
//# sourceMappingURL=endpoint.d.ts.map