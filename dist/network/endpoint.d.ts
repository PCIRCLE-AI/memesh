import type { Endpoint, IrohModule } from './iroh-types.js';
export declare function toBytes(value: string | Buffer): number[];
export declare function deadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T>;
export declare function bindEndpoint(iroh: IrohModule, secret: Buffer, relay: string, alpns: string[]): Promise<Endpoint>;
//# sourceMappingURL=endpoint.d.ts.map