import type { MementoStore } from '../host';
export interface AcpSessionRecord {
    version: 1;
    conversationId: string;
    sessionId: string;
    state: 'running' | 'settled' | 'interrupted';
    transcript: string[];
    updatedAt: number;
}
/** Host-owned recovery records, separate from the adapter's opaque session storage. */
export declare class AcpSessionStore {
    private readonly storage;
    private writes;
    constructor(storage: MementoStore);
    get(key: string): AcpSessionRecord | undefined;
    save(key: string, record: AcpSessionRecord): Promise<void>;
    forgetConversation(conversationId: string): Promise<void>;
    private serialize;
    private storageKey;
}
//# sourceMappingURL=AcpSessionStore.d.ts.map