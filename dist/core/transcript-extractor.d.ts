export interface ConversationTurn {
    role: 'user' | 'assistant';
    text: string;
}
export declare function parseVisibleConversation(transcript: Buffer): ConversationTurn[];
//# sourceMappingURL=transcript-extractor.d.ts.map