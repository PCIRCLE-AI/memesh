import type { AgentJsonObject, AgentMessagePayload } from '../core/agent-messaging.js';
export interface RouterHostIdentity {
    project: string;
    principal_id: string;
    session_instance_id: string;
    adapter_kind: string;
    work_summary?: string;
}
export interface RouterDelivery {
    attempt_id: string;
    delivery_id: string;
    connection_id: string;
    generation: number;
    hops: number;
    envelope: AgentMessagePayload;
}
export interface RouterHostConnection {
    readonly connection_id: string;
    readonly generation: number;
    close(): Promise<void>;
}
export interface RouterClientResilienceOptions {
    initial_retry_ms?: number;
    max_retry_ms?: number;
    retry_jitter?: number;
    initial_attempts?: number;
    registration_timeout_ms?: number;
    start_router?: () => void | Promise<void>;
    installed_version?: () => string;
    random?: () => number;
}
export interface ConnectRouterHostInput {
    socket_path: string;
    auth_token: string;
    identity: RouterHostIdentity;
    deliver(delivery: RouterDelivery): Promise<AgentJsonObject>;
    on_superseded?: () => void;
    resilience?: RouterClientResilienceOptions;
}
export declare function connectRouterHost(input: ConnectRouterHostInput): Promise<RouterHostConnection>;
export declare function routerOutdatedDetail(error: unknown): string;
//# sourceMappingURL=router-client.d.ts.map