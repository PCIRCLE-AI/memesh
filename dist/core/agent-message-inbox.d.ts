interface InboxDb {
    prepare(sql: string): {
        get(...params: unknown[]): unknown;
    };
}
interface InboxListDb {
    prepare(sql: string): {
        all(...params: unknown[]): unknown[];
        get(...params: unknown[]): unknown;
    };
}
export declare function unreadDeliveryCount(db: InboxDb, project: string, recipient?: string, session?: string): number;
export declare function recipientEverSeen(db: InboxDb, project: string, recipient: string): boolean | undefined;
export declare function recipientEverSeenAnywhere(db: InboxDb, recipient: string, onError?: (err: unknown) => void): boolean | undefined;
export declare function unknownRecipientHint(recipient: string): string;
export declare const UNREAD_MESSAGE_REFS_LIMIT = 500;
export interface UnreadMessageRef {
    readonly project: string;
    readonly message_id: string;
}
export declare function unreadMessageRefsFor(db: InboxListDb, recipient?: string, session?: string, limit?: number): UnreadMessageRef[];
export declare function unreadInboxLines(count: number, project: string, recipient?: string, everSeen?: boolean, targetKind?: 'principal' | 'session'): string[];
export declare function unreadInboxLinesFor(db: InboxListDb, recipient?: string, session?: string): string[];
export {};
//# sourceMappingURL=agent-message-inbox.d.ts.map