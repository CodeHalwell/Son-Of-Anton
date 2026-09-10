/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import path from 'node:path';
import { readBoundedFile } from '../util/readBoundedFile';
import { object } from '../acp/protocol';

export interface LocalModelInventory {
	source: string;
	updatedAt: number;
	models: Array<{ id: string; label: string }>;
}

function modelId(value: unknown): value is string {
	return typeof value === 'string' && value.length <= 512 && /^[\w][\w./:@+\[\]-]*$/.test(value) && !/^(?:sk-|Bearer|eyJ)/i.test(value);
}

/** Reads only model metadata; local catalogs never grant API credentials or ACP execution access. */
export async function readLocalModelInventory(tool: string, home: string, env: NodeJS.ProcessEnv): Promise<LocalModelInventory | undefined> {
	const filename = tool === 'codex' ? path.join(env.CODEX_HOME || path.join(home, '.codex'), 'models_cache.json')
		: tool === 'claude' ? path.join(home, '.claude.json')
			: tool === 'cursor' ? path.join(home, '.cursor', 'cli-config.json') : undefined;
	if (!filename) { return undefined; }
	try {
		const { content, info } = await readBoundedFile(filename, 8 * 1024 * 1024);
		const data: unknown = JSON.parse(content);
		if (!object(data)) { return undefined; }
		const models = new Map<string, { id: string; label: string }>();
		const add = (id: unknown, label: unknown) => {
			if (!modelId(id)) { return; }
			models.set(id, { id, label: typeof label === 'string' && label.trim() && label.length <= 200 && !/[\u0000-\u001f\u007f]/.test(label) ? label : id });
		};
		let updatedAt = info.mtimeMs;
		if (tool === 'codex') {
			if (!Array.isArray(data.models) || data.models.length > 10000) { return undefined; }
			for (const model of data.models) {
				if (object(model) && model.visibility === 'list') { add(model.slug, model.display_name); }
			}
			const timestamp = typeof data.fetched_at === 'string' ? Date.parse(data.fetched_at) : NaN;
			if (Number.isFinite(timestamp) && timestamp > 0 && timestamp <= Date.now() + 60_000) { updatedAt = timestamp; }
		} else if (tool === 'claude') {
			if (!Array.isArray(data.additionalModelOptionsCache) || data.additionalModelOptionsCache.length > 10000) { return undefined; }
			for (const model of data.additionalModelOptionsCache) { if (object(model)) { add(model.value, model.label); } }
			if (typeof data.additionalModelOptionsAnsweredAt === 'number' && data.additionalModelOptionsAnsweredAt > 0 && data.additionalModelOptionsAnsweredAt <= Date.now() + 60_000) { updatedAt = data.additionalModelOptionsAnsweredAt; }
		} else {
			// Cursor's selected model is a partial inventory, not its account-wide catalog.
			if (object(data.model)) { add(data.model.modelId, data.model.displayName); }
			if (object(data.selectedModel) && !models.has(String(data.selectedModel.modelId))) { add(data.selectedModel.modelId, undefined); }
		}
		return { source: filename, updatedAt, models: [...models.values()] };
	} catch { return undefined; /* Absent, unreadable, oversized or changed formats remain unverified. */ }
}
