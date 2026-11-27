import { MemeshDatabase } from '../storage/sqlite.js';
export declare const MESSAGE_MAX_BYTES = 8000;
export type ConversationHost = 'claude-code' | 'codex' | 'hermes';
export type ConversationMessageKind = 'task' | 'question' | 'review_request' | 'result';
export interface ConversationRegistration {
    id: string;
    host: ConversationHost;
    machine: string;
    pid: number;
    wake: {
        socket?: string;
        thread?: string;
    };
}
export interface ConversationMessage {
    id: string;
    sender: string;
    sender_host: string;
    sender_machine: string;
    recipient: string;
    recipient_host: string | null;
    recipient_machine: string;
    kind: ConversationMessageKind | 'legacy';
    body: string | null;
    body_bytes: number;
    reply_to: string | null;
    sent_at: string;
}
export interface ConversationMessageEvent {
    message_id: string;
    at: string;
    event: string;
    detail: string;
}
export interface ConversationMessageStatus extends ConversationMessage {
    state: string;
    events: ConversationMessageEvent[];
}
export interface ConversationNetworkSnapshot {
    network_id: string;
    self: {
        id: string;
        name: string;
    };
    members: readonly {
        id: string;
        name: string;
    }[];
}
export interface RemoteConversationRegistration {
    id: string;
    host: ConversationHost;
    online: boolean;
}
export interface NetworkConversationMessage {
    network_id: string;
    sender_machine_id: string;
    recipient_machine_id: string;
    message: ConversationMessage;
}
export interface ConversationDeliveryReceipt {
    message_id: string;
    event: 'delivered' | 'read';
    at: string;
    actor: string;
}
export declare function renderConversationMessage(message: ConversationMessage): string;
export declare class ConversationMessages {
    private readonly db;
    readonly machine: string;
    private readonly clock;
    private readonly processAlive;
    private readonly network?;
    readonly networkIssue?: string;
    constructor(options?: {
        file?: string;
        machine?: string;
        clock?: () => number;
        processAlive?: (pid: number) => boolean;
        legacySource?: MemeshDatabase;
        legacyMessageIds?: readonly string[];
        busyTimeoutMs?: number;
        network?: ConversationNetworkSnapshot;
    });
    close(): void;
    private upgradeRoutingSchema;
    maintainMessages(): void;
    registerChannel(caller: string, hostPid: number): void;
    channelBatch(caller: string, hostPid: number): {
        text: string;
        ids: string[];
    };
    recordChannelPush(caller: string, hostPid: number, ids: readonly string[]): void;
    private channelRegistration;
    wakeTarget(messageId: string): ConversationRegistration | undefined;
    recordPush(sender: string, messageId: string, route: 'claude-socket' | 'codex-queue'): void;
    register(input: ConversationRegistration): void;
    discover(): Array<ConversationRegistration & {
        online: boolean;
    }>;
    send(sender: string, input: {
        recipient: string;
        kind: ConversationMessageKind;
        body: string;
        reply_to?: string;
    }): {
        message: ConversationMessage;
        accepted: boolean;
        reason?: string;
        recipients?: string[];
        warning?: string;
    };
    read(caller: string, id: string): ConversationMessage;
    status(caller?: string, id?: string): ConversationMessageStatus[];
    hookBatch(caller: string, excludedIds?: readonly string[]): {
        text: string;
        ids: string[];
    };
    private messageBatch;
    recordHookDelivery(caller: string, ids: string[], hook: string): void;
    exportRegistrations(): RemoteConversationRegistration[];
    replaceRemoteRegistrations(peerId: string, registrations: readonly RemoteConversationRegistration[]): void;
    upsertRemoteRegistrations(peerId: string, registrations: readonly RemoteConversationRegistration[]): void;
    private writeRemoteRegistrations;
    outgoingFor(peerId: string): NetworkConversationMessage[];
    receiveFrom(peerId: string, wire: NetworkConversationMessage): 'accepted' | 'duplicate';
    recordCopyAccepted(peerId: string, messageId: string): void;
    recordNetworkPush(peerId: string, messageId: string, route: 'claude-socket' | 'codex-queue'): void;
    receiptsFor(peerId: string): ConversationDeliveryReceipt[];
    recordReceiptAccepted(peerId: string, receipt: ConversationDeliveryReceipt): void;
    receiveReceipt(peerId: string, receipt: ConversationDeliveryReceipt): 'accepted' | 'duplicate';
    private member;
    private requirePeer;
    private remoteRegistration;
    private outboundMessage;
    private receiptKey;
    private receiptAcknowledged;
    private unknownRecipient;
    private now;
    private findRegistration;
    private registration;
    private get;
    private findMessage;
    private rejected;
    private pending;
    private insert;
    private event;
    private eventOnce;
    private maintain;
}
//# sourceMappingURL=conversation-messages.d.ts.map