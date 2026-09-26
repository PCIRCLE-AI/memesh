interface InboxDb {
    prepare(sql: string): {
        get(...params: unknown[]): unknown;
    };
}
interface InboxListDb {
    prepare(sql: string): {
        all(...params: unknown[]): unknown[];
    };
}
export declare function unreadDeliveryCount(db: InboxDb, project: string, recipient?: string): number;
export declare function recipientEverSeen(db: InboxDb, project: string, recipient: string): boolean | undefined;
export declare function recipientEverSeenAnywhere(db: InboxDb, recipient: string, onError?: (err: unknown) => void): boolean | undefined;
export declare function unknownRecipientHint(recipient: string): string;
export declare function unreadInboxLines(count: number, project: string, recipient?: string, everSeen?: boolean): string[];
export declare function unreadInboxLinesFor(db: InboxListDb, recipient?: string): string[];
export {};
//# sourceMappingURL=agent-message-inbox.d.ts.map