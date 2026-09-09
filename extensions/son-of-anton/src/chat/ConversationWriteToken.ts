/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** A transcript's write lineage. Only successful saves advance its revision. */
export interface ConversationWriteToken { revision: string | null }

/** Keep internal concurrency state out of history exports while retaining it across local queued saves. */
export function attachConversationWriteToken<T extends object>(record: T, token: ConversationWriteToken): T & { readonly writeToken: ConversationWriteToken } {
	return Object.defineProperty(record, 'writeToken', { value: token, configurable: true }) as T & { readonly writeToken: ConversationWriteToken };
}
