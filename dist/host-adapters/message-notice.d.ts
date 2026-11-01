import { type AgentMessagePayload } from '../core/agent-messaging.js';
export declare function messageNotice(envelope: AgentMessagePayload, deliveryId: string): {
    message_type: string;
    handling: string;
    project: string;
    recipient: string;
    target_kind: import("../core/agent-messaging.js").AgentTargetKind;
    message_id: string;
    delivery_id: string;
};
//# sourceMappingURL=message-notice.d.ts.map