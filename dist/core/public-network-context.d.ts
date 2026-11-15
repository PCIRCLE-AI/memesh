import { MemeshDatabase } from '../storage/sqlite.js';
import type { ConversationNetworkSnapshot } from './conversation-messages.js';
export declare function openPublicNetworkDatabase(file: string, consistentSnapshot?: boolean): MemeshDatabase | undefined;
export declare function readPublicNetworkContext(dataDir: string): ConversationNetworkSnapshot | undefined;
//# sourceMappingURL=public-network-context.d.ts.map