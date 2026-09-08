/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { CoreHost } from 'son-of-anton-core/dist/host';
import { ProtectedSecretStore } from 'son-of-anton-core/dist/credentials/ProtectedSecretStore';
import { SECRET_KEYS } from 'son-of-anton-core/dist/credentials/credentialDetection';
import { providerForModel, supportsAgenticToolLoop, type ModelId } from 'son-of-anton-core/dist/llm/LlmClient';
import { buildCliHost } from '../cliHost';

interface Diagnostic { name: string; status: 'ok' | 'info' | 'repair'; detail: string; action?: string }

/** Local inspection only: never print credentials or contact a model provider. */
export async function collectDiagnostics(host: CoreHost, runtimeOverride?: string): Promise<Diagnostic[]> {
	const diagnostics: Diagnostic[] = [];
	const nodeReady = Number(process.versions.node.split('.')[0]) === 22;
	diagnostics.push({ name: 'Node', status: nodeReady ? 'ok' : 'repair', detail: process.versions.node, ...(!nodeReady ? { action: 'Use Node 22 as declared in .nvmrc.' } : {}) });
	try { execFileSync('git', ['--version'], { timeout: 3000, stdio: 'pipe' }); diagnostics.push({ name: 'Git', status: 'ok', detail: 'Available for retained workspace checkpoints.' }); }
	catch { diagnostics.push({ name: 'Git', status: 'repair', detail: 'Unavailable.', action: 'Install Git and add it to PATH.' }); }
	const model = host.config.get<string>('defaultModel', 'sonnet') as ModelId;
	diagnostics.push({ name: 'Model', status: 'info', detail: `${model}; provider=${providerForModel(model)}; tools=${supportsAgenticToolLoop(model)}` });
	let protectedKeys = 0;
	let credentialStoreAvailable = true;
	for (const key of Object.values(SECRET_KEYS)) {
		try { if (await host.secrets.get(key)) { protectedKeys++; } }
		catch { credentialStoreAvailable = false; }
	}
	const environmentKeys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'AWS_PROFILE', 'AWS_ACCESS_KEY_ID'].filter(key => !!process.env[key]);
	diagnostics.push({ name: 'Credentials', status: credentialStoreAvailable ? 'info' : 'repair', detail: `${protectedKeys} stored credential fields; ${environmentKeys.length} provider environment fields. Presence does not verify account access.`, ...(!credentialStoreAvailable ? { action: 'Unlock the OS credential store; Linux requires secret-tool and a running Secret Service.' } : {}) });
	if (!protectedKeys && !environmentKeys.length) { diagnostics.push({ name: 'Provider setup', status: 'info', detail: 'No API credentials detected; local models and authenticated subscription CLIs are separate options.', action: 'Run sota auth status, then configure a provider in the editor or run sota auth login.' }); }
	const candidates = [runtimeOverride, process.env.SOTA_CODEGRAPH_RUNTIME, path.resolve(__dirname, '../../../../extensions/son-of-anton/runtime/codegraph'), path.join(path.dirname(process.execPath), 'runtime/codegraph')].filter((entry): entry is string => !!entry);
	const runtime = candidates.find(candidate => existsSync(path.join(candidate, 'manifest.json')));
	try {
		if (!runtime) { throw new Error('Runtime is not installed.'); }
		const manifest = JSON.parse(readFileSync(path.join(runtime, 'manifest.json'), 'utf8')) as { platform: string; arch: string; nodeMajor: number };
		if (manifest.platform !== process.platform || manifest.arch !== process.arch || manifest.nodeMajor !== 22 || !existsSync(path.join(runtime, 'index.cjs')) || !existsSync(path.join(runtime, 'node_modules/@son-of-anton/codegraph-napi/engine.node'))) { throw new Error('Runtime assets are missing or target another platform.'); }
		diagnostics.push({ name: 'Code graph', status: 'ok', detail: 'Native runtime installed for this platform. Live index readiness is reported by codegraph_status in the editor.' });
	} catch {
		diagnostics.push({ name: 'Code graph', status: 'repair', detail: 'No compatible installed runtime found.', action: 'In a development checkout run npm run bootstrap:sota. For an installed editor, reinstall the matching platform artifact. Set SOTA_CODEGRAPH_RUNTIME for a separate runtime.' });
	}
	const embedder = host.config.get<string>('codeGraph.embedder', 'none');
	diagnostics.push({ name: 'Semantic search', status: 'info', detail: embedder === 'none' ? 'Disabled; structural code search remains available.' : `Configured embedder: ${embedder}. Availability is checked when the graph starts.`, action: 'Configure sota.codeGraph.embedder in the editor. Provider embeddings send selected source code to that provider.' });
	return diagnostics;
}

export async function runDoctor(options: { output?: string; runtime?: string }): Promise<void> {
	const host = buildCliHost();
	// Normal chat tolerates unavailable secure storage when environment credentials
	// suffice. Diagnostics must expose that failure instead of hiding it.
	const diagnostics = await collectDiagnostics(process.env.SOTA_ALLOW_PLAINTEXT_SECRETS === '1' ? host : { ...host, secrets: new ProtectedSecretStore() }, options.runtime);
	process.stdout.write(options.output === 'json' ? JSON.stringify({ diagnostics }, null, 2) + '\n' : diagnostics.map(item => `${item.status.toUpperCase()} ${item.name}: ${item.detail}${item.action ? '\n  ' + item.action : ''}`).join('\n') + '\n');
	if (diagnostics.some(item => item.status === 'repair')) { process.exitCode = 1; }
}
