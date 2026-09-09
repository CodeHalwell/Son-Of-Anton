"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.AcpSessionStore = void 0;
const node_crypto_1 = require("node:crypto");
const protocol_1 = require("./protocol");
/** Host-owned recovery records, separate from the adapter's opaque session storage. */
class AcpSessionStore {
    storage;
    writes = Promise.resolve();
    constructor(storage) {
        this.storage = storage;
    }
    get(key) {
        const value = this.storage.get(this.storageKey(key));
        if (!(0, protocol_1.object)(value) || value.version !== 1 || typeof value.conversationId !== 'string' || typeof value.sessionId !== 'string'
            || !['running', 'settled', 'interrupted'].includes(value.state) || !Array.isArray(value.transcript) || !value.transcript.every(turn => typeof turn === 'string')) {
            return undefined;
        }
        return { ...value, transcript: [...value.transcript] };
    }
    async save(key, record) {
        // Retain recent conversational context, not raw image payloads, tool inputs or provider credentials.
        const transcript = record.transcript.map(turn => turn.slice(-64 * 1024));
        while (transcript.length && Buffer.byteLength(transcript.join('\n')) > 256 * 1024) {
            transcript.shift();
        }
        await this.serialize(async () => {
            const index = this.storage.get('sota.acp.session.index.v1') ?? {};
            const storageKey = this.storageKey(key);
            await this.storage.update('sota.acp.session.index.v1', { ...index, [storageKey]: record.conversationId });
            await this.storage.update(storageKey, { ...record, transcript });
        });
    }
    async forgetConversation(conversationId) {
        await this.serialize(async () => {
            const index = { ...(this.storage.get('sota.acp.session.index.v1') ?? {}) };
            for (const [key, owner] of Object.entries(index)) {
                if (typeof owner === 'string' && (owner === conversationId || owner.endsWith(`:${conversationId}`))) {
                    await this.storage.update(key, undefined);
                    delete index[key];
                }
            }
            await this.storage.update('sota.acp.session.index.v1', index);
        });
    }
    serialize(action) {
        const result = this.writes.then(action);
        this.writes = result.catch(() => { });
        return result;
    }
    storageKey(key) {
        return `sota.acp.session.v1.${(0, node_crypto_1.createHash)('sha256').update(key).digest('hex')}`;
    }
}
exports.AcpSessionStore = AcpSessionStore;
//# sourceMappingURL=AcpSessionStore.js.map