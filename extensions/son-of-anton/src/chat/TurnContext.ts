/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { randomUUID } from 'node:crypto';

export interface ContextSection { id: string; label: string; markdown: string; estimatedTokens: number; excluded: boolean }
export interface TurnContext {
	id: string;
	createdAt: number;
	sections: ContextSection[];
	workspaceMarkdown: string;
	attachmentMarkdown: string;
	estimatedTokens: number;
}

/** A bounded, explicit manifest used by both the preview and the next request. */
export async function assembleTurnContext(sources: Array<{ id: string; label: string; resolve: () => Promise<string> }>, excluded: readonly string[] = []): Promise<TurnContext> {
	if (sources.length > 32) { throw new Error('Select at most 32 context sources. Remove attachments or mentions and preview again; no sources were read or silently omitted.'); }
	const pending = sources.map(async source => {
		if (excluded.includes(source.id)) { return { id: source.id, label: source.label, markdown: '', estimatedTokens: 0, excluded: true }; }
		const content = await source.resolve();
		const notice = '\n[Context truncated to 40,000 characters]';
		const markdown = content.length > 40_000 ? `${content.slice(0, 40_000 - notice.length)}${notice}` : content;
		return { id: source.id, label: source.label, markdown, estimatedTokens: Math.ceil(markdown.length / 4), excluded: false };
	});
	const sections = await Promise.all(pending);
	let remaining = 120_000;
	for (const section of sections) {
		if (section.markdown) {
			// Reserve separators as well as section content so the assembled payload stays bounded.
			remaining = Math.max(0, remaining - 2);
			if (section.markdown.length > remaining) {
				const notice = '\n[Context truncated to the combined request budget]';
				if (remaining > notice.length) { section.markdown = `${section.markdown.slice(0, remaining - notice.length)}${notice}`; }
				else { section.markdown = ''; section.label += ' (omitted: combined context budget reached)'; }
			}
			remaining = Math.max(0, remaining - section.markdown.length);
		}
		section.estimatedTokens = Math.ceil(section.markdown.length / 4);
	}
	return {
		id: randomUUID(), createdAt: Date.now(), sections,
		workspaceMarkdown: sections.find(section => section.id === 'workspace')?.markdown ?? '',
		attachmentMarkdown: sections.filter(section => section.id !== 'workspace' && section.markdown).map(section => section.markdown).join('\n\n'),
		estimatedTokens: sections.reduce((total, section) => total + section.estimatedTokens, 0),
	};
}
