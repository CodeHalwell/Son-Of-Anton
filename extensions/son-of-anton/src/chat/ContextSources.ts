/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type ContextMention =
	| { kind: 'workspace' | 'problems' | 'terminal' }
	| { kind: 'file' | 'folder'; path?: string }
	| { kind: 'url'; url?: string };

/** Retained when an old excluded draft has no sources yet. Never authorizes a read. */
export const ALL_MENTIONS_EXCLUDED = 'mention:v1:all';

/** Lexical only: identity calculation must not read a source, even to resolve a symlink. */
function canonicalPath(value: string): string {
	const path = value.replaceAll('\\', '/');
	const prefix = path.startsWith('//') ? '//' : path.startsWith('/') ? '/' : '';
	const parts: string[] = [];
	for (const part of path.split('/')) {
		if (!part || part === '.') { continue; }
		if (part === '..' && parts.length && parts.at(-1) !== '..') { parts.pop(); }
		else if (part !== '..' || !prefix) { parts.push(part); }
	}
	return prefix + parts.join('/');
}

/** Full source identities, shared by the host and composer; positions and labels are irrelevant. */
export function mentionSourceId(mention: ContextMention): string {
	let kind: string = mention.kind;
	let identity = '';
	if (mention.kind === 'file' || mention.kind === 'folder') {
		kind = 'path';
		identity = canonicalPath(mention.path ?? '');
		if (mention.path === '[workspace]') { kind = 'workspace'; identity = ''; }
	} else if (mention.kind === 'url') {
		identity = (mention.url ?? '').trim();
		try { const url = new URL(identity); url.hash = ''; identity = url.href; } catch { /* Keep invalid references distinct without reading them. */ }
	}
	return `mention:v1:${encodeURIComponent(JSON.stringify([kind, identity]))}`;
}

/** Parse deferred URL chips identically for previews, persisted draft migration and submission. */
export function inlineUrlMentions(text = ''): { text: string; mentions: ContextMention[] } {
	const mentions: ContextMention[] = [];
	const cleaned = text.replace(/(^|\s)@url\s+(https?:\/\/[^\s]+)/g, (_match, lead: string, url: string) => {
		mentions.push({ kind: 'url', url });
		return lead;
	});
	return { text: mentions.length ? cleaned.replace(/\s{2,}/g, ' ').trim() : text, mentions };
}

/** Legacy path aliases and deferred URLs participate in the same source namespace. */
export function contextMentions(request: { mentionsKinded?: readonly ContextMention[]; mentions?: readonly string[]; text?: string }): ContextMention[] {
	const mentions = request.mentionsKinded?.length ? request.mentionsKinded : (request.mentions ?? []).map<ContextMention>(path => path === '[workspace]' ? { kind: 'workspace' } : { kind: 'file', path });
	return [...new Map([...mentions, ...inlineUrlMentions(request.text).mentions].map(mention => [mentionSourceId(mention), mention])).values()];
}

/** Old positions may already be stale, including in saved history. Never map them to an index. */
export function hasLegacyMentionExclusions(excluded: readonly string[] = []): boolean {
	return excluded.some(id => id === 'mentions' || /^mention:\d+$/.test(id));
}

/** Expand a conservative marker only over the complete current source list. */
export function expandMentionExclusions(excluded: readonly string[], mentions: readonly ContextMention[]): string[] {
	if (!excluded.includes(ALL_MENTIONS_EXCLUDED) || !mentions.length) { return [...new Set(excluded)]; }
	return [...new Set([...excluded.filter(id => id !== ALL_MENTIONS_EXCLUDED), ...mentions.map(mentionSourceId)])];
}

/** Restore-time privacy migration: every old positional/group exclusion excludes every source. */
export function migrateMentionExclusions(excluded: readonly string[] = [], mentions: readonly ContextMention[] = []): { excludedContext: string[]; migrated: boolean } {
	const migrated = hasLegacyMentionExclusions(excluded);
	const safe = migrated ? [...excluded.filter(id => !hasLegacyMentionExclusions([id])), ALL_MENTIONS_EXCLUDED] : [...excluded];
	return { excludedContext: expandMentionExclusions(safe, mentions), migrated };
}
