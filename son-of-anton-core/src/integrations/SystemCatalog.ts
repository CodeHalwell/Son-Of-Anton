/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { parse as parseJson, type ParseError } from 'jsonc-parser';
import { parse as parseYaml } from 'yaml';
import { readBoundedFile } from '../util/readBoundedFile';

export type IntegrationSource = 'shared' | 'claude' | 'codex' | 'cursor';
export interface IntegrationEntry {
	id: string;
	kind: 'skill' | 'plugin' | 'mcp';
	name: string;
	description: string;
	source: IntegrationSource;
	scope: 'user' | 'workspace';
	path: string;
	enabled: boolean;
	version?: string;
	reason?: string;
}
export interface ImportedMcpServer {
	name: string;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	transport?: 'http' | 'sse';
}
export interface SystemCatalog {
	entries: IntegrationEntry[];
	/** Host-only launch descriptors. Never send these credentials to a webview or model. */
	servers: Map<string, ImportedMcpServer>;
	issues: Array<{ path: string; message: string }>;
}
export interface DiscoveryOptions { home?: string; codexHome?: string; workspace?: string }
const MAX_BYTES = 256 * 1024;
const MAX_ENTRIES = 2000;
const caches = new Map<string, { time: number; value: Promise<SystemCatalog> }>();
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const strings = (value: unknown): string[] => typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
const idFor = (kind: string, filename: string, name = '') => `${kind}-${createHash('sha256').update(filename + '\0' + name).digest('hex').slice(0, 20)}`;
const inside = (root: string, target: string) => target === root || target.startsWith(root + path.sep);

/** Cache discovery without blocking activation. Explicit refresh replaces a previous failed scan. */
export function getSystemCatalog(options: DiscoveryOptions = {}, refresh = false): Promise<SystemCatalog> {
	const key = JSON.stringify([options.home ?? homedir(), options.codexHome ?? process.env.CODEX_HOME, options.workspace]);
	const cached = caches.get(key);
	if (!refresh && cached && Date.now() - cached.time < 30_000) { return cached.value; }
	const value = discoverSystemCatalog(options);
	if (caches.size >= 16) { caches.delete(caches.keys().next().value!); }
	caches.set(key, { time: Date.now(), value });
	return value;
}

/** Read known configuration locations only; discovery never launches or installs a package. */
export async function discoverSystemCatalog(options: DiscoveryOptions = {}): Promise<SystemCatalog> {
	const home = options.home ?? homedir();
	const codex = options.codexHome ?? (options.home ? path.join(home, '.codex') : process.env.CODEX_HOME || path.join(home, '.codex'));
	const catalog: SystemCatalog = { entries: [], servers: new Map(), issues: [] };
	const seenSkills = new Set<string>();
	const read = async (filename: string, maxBytes = MAX_BYTES): Promise<string | undefined> => {
		try {
			return (await readBoundedFile(filename, maxBytes)).content;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { catalog.issues.push({ path: filename, message: 'Could not read configuration (type, size, or permissions).' }); }
			return undefined;
		}
	};
	const json = async (filename: string): Promise<Record<string, unknown>> => {
		const text = await read(filename, 4 * 1024 * 1024);
		if (text === undefined) { return {}; }
		try {
			if (filename.endsWith('.toml')) { return object((await import('smol-toml')).parse(text)); }
			const errors: ParseError[] = [];
			const result = parseJson(text, errors, { allowTrailingComma: true });
			if (errors.length) { throw new Error('Invalid JSON'); }
			return object(result);
		} catch {
			catalog.issues.push({ path: filename, message: 'Could not parse configuration.' });
			return {};
		}
	};
	const directories = async (root: string): Promise<string[]> => {
		try { return (await fs.readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory() || entry.isSymbolicLink()).slice(0, MAX_ENTRIES).map(entry => path.join(root, entry.name)).sort(); }
		catch { return []; }
	};
	const skill = async (filename: string, source: IntegrationSource, scope: IntegrationEntry['scope'], enabled = true) => {
		if (catalog.entries.length >= MAX_ENTRIES) { return; }
		let canonical: string;
		try { canonical = await fs.realpath(filename); } catch { return; }
		if (seenSkills.has(canonical)) { return; }
		const text = await read(canonical);
		if (text === undefined) { return; }
		try {
			const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
			const metadata = frontmatter ? object(parseYaml(frontmatter[1], { maxAliasCount: 20 })) : {};
			seenSkills.add(canonical);
			catalog.entries.push({ id: idFor('skill', canonical), kind: 'skill', name: typeof metadata.name === 'string' ? metadata.name.slice(0, 200) : path.basename(path.dirname(filename)), description: typeof metadata.description === 'string' ? metadata.description.slice(0, 1000) : '', source, scope, path: canonical, enabled, reason: enabled ? undefined : 'Disabled in source application' });
		} catch { catalog.issues.push({ path: filename, message: 'Could not parse skill metadata.' }); }
	};
	const skillDirectory = async (root: string, source: IntegrationSource, scope: IntegrationEntry['scope'], enabled = true) => {
		const visited = new Set<string>();
		const walk = async (dir: string, depth: number): Promise<void> => {
			if (depth > 5 || visited.size >= MAX_ENTRIES || catalog.entries.length >= MAX_ENTRIES) { return; }
			let canonical: string;
			try { canonical = await fs.realpath(dir); } catch { return; }
			if (visited.has(canonical)) { return; }
			visited.add(canonical);
			await skill(path.join(dir, 'SKILL.md'), source, scope, enabled);
			for (const child of await directories(dir)) {
				if (!['node_modules', '.git', 'scripts', 'references', 'assets', 'resources'].includes(path.basename(child))) { await walk(child, depth + 1); }
			}
		};
		await walk(root, 0);
	};
	const mcp = (raw: unknown, filename: string, source: IntegrationSource, scope: IntegrationEntry['scope'], enabled = true, pluginRoot?: string) => {
		for (const [name, value] of Object.entries(object(raw)).slice(0, 200)) {
			if (catalog.entries.length >= MAX_ENTRIES) { return; }
			const config = object(value);
			let unresolved = false;
			const expand = (value: string) => value.replace(/\$\{([^}]+)\}/g, (match, key: string) => {
				const [variable, fallback] = key.replace(/^env:/, '').split(/:-(.*)/s);
				const replacement = /^(CLAUDE|CODEX|CURSOR)_PLUGIN_ROOT$/.test(key) ? pluginRoot : key === 'workspaceFolder' ? options.workspace : process.env[variable] ?? fallback;
				if (replacement === undefined) { unresolved = true; return match; }
				return replacement;
			});
			const record = (value: unknown) => Object.fromEntries(Object.entries(object(value)).filter((entry): entry is [string, string] => typeof entry[1] === 'string').map(([key, val]) => [key, expand(val)]));
			const command = typeof config.command === 'string' ? expand(config.command) : undefined;
			const url = typeof config.url === 'string' ? expand(config.url) : undefined;
			const server: ImportedMcpServer = { name: `${source}-${name.replace(/[^a-zA-Z0-9_-]/g, '-')}`, command, url, args: strings(config.args).map(expand), env: record(config.env), headers: record(config.headers ?? config.http_headers), cwd: typeof config.cwd === 'string' ? path.resolve(path.dirname(filename), expand(config.cwd)) : scope === 'workspace' ? options.workspace : undefined, transport: config.type === 'sse' || config.transport === 'sse' ? 'sse' : 'http' };
			for (const key of strings(config.env_vars)) { if (process.env[key]) { server.env![key] = process.env[key]!; } else { unresolved = true; } }
			for (const [header, envName] of Object.entries(object(config.env_http_headers))) { if (typeof envName === 'string' && process.env[envName]) { server.headers![header] = process.env[envName]!; } else { unresolved = true; } }
			if (typeof config.bearer_token_env_var === 'string') {
				const token = process.env[config.bearer_token_env_var];
				if (token) { server.headers!.Authorization = `Bearer ${token}`; } else { unresolved = true; }
			}
			let reason: string | undefined;
			if (!enabled || config.enabled === false || config.disabled === true) { reason = 'Disabled in source application'; }
			else if (unresolved) { reason = 'Requires environment variables from the source application'; }
			else if (!command && !url) { reason = 'No supported command or HTTP endpoint'; }
			else if (url) { try { const parsed = new URL(url); if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) { reason = 'Unsupported endpoint'; } } catch { reason = 'Invalid endpoint'; } }
			const id = idFor('mcp', filename, name + (scope === 'workspace' ? options.workspace ?? '' : ''));
			server.name += '-' + id.slice(-6);
			catalog.entries.push({ id, kind: 'mcp', name, description: url ? 'Remote MCP server' : 'Local MCP server', source, scope, path: filename, enabled: !reason, reason });
			if (!reason) { catalog.servers.set(id, server); }
		}
	};
	const claudeSettings = await json(path.join(home, '.claude/settings.json'));
	const enabledClaudePlugins = { ...object(claudeSettings.enabledPlugins) };
	if (options.workspace) {
		for (const file of ['.claude/settings.json', '.claude/settings.local.json']) {
			Object.assign(enabledClaudePlugins, object((await json(path.join(options.workspace, file))).enabledPlugins));
		}
	}
	const codexConfig = await json(path.join(codex, 'config.toml'));
	const roots: Array<[string, IntegrationSource, IntegrationEntry['scope']]> = [
		...(options.workspace ? [[path.join(options.workspace, '.agents'), 'shared', 'workspace'], [path.join(options.workspace, '.claude'), 'claude', 'workspace'], [path.join(options.workspace, '.codex'), 'codex', 'workspace'], [path.join(options.workspace, '.cursor'), 'cursor', 'workspace']] as Array<[string, IntegrationSource, 'workspace']> : []),
		[path.join(home, '.agents'), 'shared', 'user'], [path.join(home, '.claude'), 'claude', 'user'], [codex, 'codex', 'user'], [path.join(home, '.cursor'), 'cursor', 'user'],
	];
	for (const [root, source, scope] of roots) { await skillDirectory(path.join(root, 'skills'), source, scope); }
	const configs: Array<[string, IntegrationSource, IntegrationEntry['scope']]> = [[path.join(home, '.claude.json'), 'claude', 'user'], [path.join(home, '.cursor/mcp.json'), 'cursor', 'user'], [path.join(codex, 'config.toml'), 'codex', 'user']];
	configs.push([path.join(home, 'Library/Application Support/Claude/claude_desktop_config.json'), 'claude', 'user']);
	if (options.workspace) { configs.unshift([path.join(options.workspace, '.mcp.json'), 'claude', 'workspace'], [path.join(options.workspace, '.cursor/mcp.json'), 'cursor', 'workspace'], [path.join(options.workspace, '.codex/config.toml'), 'codex', 'workspace']); }
	for (const [filename, source, scope] of configs) {
		const config = filename === path.join(codex, 'config.toml') ? codexConfig : await json(filename);
		mcp(config.mcpServers ?? config.mcp_servers, filename, source, scope);
		if (source === 'claude' && scope === 'user' && options.workspace) { mcp(object(object(config.projects)[options.workspace]).mcpServers, filename, source, 'workspace'); }
	}
	const plugin = async (root: string, manifest: string, source: IntegrationSource, scope: IntegrationEntry['scope'], enabled: boolean) => {
		if (catalog.entries.length >= MAX_ENTRIES) { return; }
		const metadata = await json(path.join(root, manifest, 'plugin.json'));
		if (typeof metadata.name !== 'string') { return; }
		catalog.entries.push({ id: idFor('plugin', root), kind: 'plugin', name: metadata.name, description: typeof metadata.description === 'string' ? metadata.description.slice(0, 1000) : '', version: typeof metadata.version === 'string' ? metadata.version : undefined, source, scope, path: root, enabled, reason: enabled ? 'Skills and MCP components supported; application-specific hooks and UI remain in the source app' : 'Cached or disabled in source application' });
		const components = async (paths: unknown, fallback: string, consume: (filename: string) => Promise<void>) => {
			for (const relative of strings(paths).length ? strings(paths) : [fallback]) {
				const filename = path.resolve(root, relative);
				if (inside(root, filename)) { await consume(filename); }
			}
		};
		await components(metadata.skills, 'skills', async dir => { await skillDirectory(dir, source, scope, enabled); });
		if (metadata.mcpServers && typeof metadata.mcpServers === 'object' && !Array.isArray(metadata.mcpServers)) { mcp(metadata.mcpServers, root, source, scope, enabled, root); }
		else { await components(metadata.mcpServers, '.mcp.json', async file => { const data = await json(file); mcp(data.mcpServers ?? data, file, source, scope, enabled, root); }); }
	};
	const installed = object((await json(path.join(home, '.claude/plugins/installed_plugins.json'))).plugins);
	for (const [name, records] of Object.entries(installed)) {
		for (const record of Array.isArray(records) ? records : []) {
			const entry = object(record);
			if (typeof entry.installPath !== 'string' || !path.isAbsolute(entry.installPath)) { continue; }
			if (typeof entry.projectPath === 'string' && entry.projectPath !== options.workspace) { continue; }
			await plugin(entry.installPath, '.claude-plugin', 'claude', entry.projectPath ? 'workspace' : 'user', enabledClaudePlugins[name] !== false);
		}
	}
	for (const [root, source, manifest] of [[codex, 'codex', '.codex-plugin'], [path.join(home, '.cursor'), 'cursor', '.cursor-plugin']] as const) {
		for (const market of await directories(path.join(root, 'plugins/cache'))) {
			for (const packageRoot of await directories(market)) {
				const versions = await directories(packageRoot);
				const selected = versions.sort((a, b) => path.basename(b).localeCompare(path.basename(a), undefined, { numeric: true }))[0];
				if (!selected) { continue; }
				const key = `${path.basename(packageRoot)}@${path.basename(market)}`;
				const enabled = source === 'codex' ? object(object(codexConfig.plugins)[key]).enabled === true : false;
				await plugin(selected, manifest, source, 'user', enabled);
			}
		}
		for (const local of await directories(path.join(root, 'plugins/local'))) { await plugin(local, manifest, source, 'user', true); }
	}
	for (const override of Array.isArray(object(codexConfig.skills).config) ? object(codexConfig.skills).config as unknown[] : []) {
		const config = object(override);
		if (config.enabled !== false || typeof config.path !== 'string') { continue; }
		const filename = await fs.realpath(path.resolve(config.path)).catch(() => path.resolve(config.path as string));
		for (const entry of catalog.entries) { if (entry.kind === 'skill' && (entry.path === filename || path.dirname(entry.path) === filename)) { entry.enabled = false; entry.reason = 'Disabled in source application'; } }
	}
	if (catalog.entries.length >= MAX_ENTRIES) { catalog.issues.push({ path: home, message: 'Catalog limited to 2,000 entries. Narrow the installed skill or plugin directories to discover additional entries.' }); }
	return catalog;
}

/** Skills may read their own bundled resources, never arbitrary home-directory files. */
export async function readCatalogSkill(catalog: SystemCatalog, id: string, resource = 'SKILL.md'): Promise<string> {
	const entry = catalog.entries.find(entry => entry.id === id && entry.kind === 'skill' && entry.enabled);
	if (!entry || path.isAbsolute(resource) || resource.includes('\0')) { throw new Error('Unknown or disabled skill resource'); }
	const root = await fs.realpath(path.dirname(entry.path));
	const filename = await fs.realpath(path.resolve(root, resource));
	if (!inside(root, filename)) { throw new Error('Skill resource must remain inside its installed directory'); }
	return (await readBoundedFile(filename, MAX_BYTES, true)).content;
}
