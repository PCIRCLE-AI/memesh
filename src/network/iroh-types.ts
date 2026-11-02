// The subset of the native transport this module calls, written by hand because
// the package is installed on demand and is not a dependency of MeMesh. All byte
// arguments are arrays of numbers; a Buffer is not accepted.

export interface BiStream {
  send: {
    writeAll(data: number[]): Promise<void>;
    finish(): Promise<void>;
  };
  recv: {
    /** Throws when the stream is longer than `sizeLimit`; the connection survives. */
    readToEnd(sizeLimit: number): Promise<number[]>;
  };
}

export interface EndpointIdLike {
  toString(): string;
}

export interface Connection {
  alpn(): number[];
  remoteId(): EndpointIdLike;
  openBi(): Promise<BiStream>;
  acceptBi(): Promise<BiStream>;
  closed(): Promise<string>;
  close(errorCode: bigint, reason: number[]): void;
}

export interface Incoming {
  accept(): Promise<{ connect(): Promise<Connection> }>;
  refuse(): Promise<void>;
}

export type EndpointAddr = object;

export interface Endpoint {
  id(): EndpointIdLike;
  addr(): { directAddresses(): string[] };
  online(): Promise<void>;
  connect(addr: EndpointAddr, alpn: number[]): Promise<Connection>;
  /** Null once the endpoint has closed. */
  acceptNext(): Promise<Incoming | null>;
  close(): Promise<void>;
}

export type RelayMode = object;

export interface EndpointBuilder {
  applyMinimal(): void;
  secretKey(bytes: number[]): void;
  alpns(alpns: number[][]): void;
  relayMode(mode: RelayMode): void;
  bind(): Promise<Endpoint>;
}

export interface IrohModule {
  Endpoint: { builder(): EndpointBuilder };
  EndpointAddr: new (id: EndpointIdLike, relayUrl: string | null, addresses?: string[]) => EndpointAddr;
  EndpointId: { fromString(id: string): EndpointIdLike };
  RelayMode: { customFromUrls(urls: string[]): RelayMode; disabled(): RelayMode };
}
