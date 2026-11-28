export interface NetworkAddress {
    person: string;
    target: string;
    machine: string;
}
export declare function parseNetworkAddress(value: string): NetworkAddress | null;
export declare function formatNetworkAddress(person: string, target: string, machine: string): string;
export declare function projectHash(networkId: string, project: string): string;
export declare function isLocalSenderName(value: string): boolean;
//# sourceMappingURL=address.d.ts.map