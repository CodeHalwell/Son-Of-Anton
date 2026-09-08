/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
const readline = require('node:readline');
const fs = require('node:fs');
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
let initialized = false, session, count = 0, pending, permission, mode = 'act', selectedModel;
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
	const message = JSON.parse(line);
	const { id, method, params } = message;
	if (method === 'initialize') {
		if (process.env.FIXTURE_NO_INIT) { return; }
		initialized = true;
		send({ id, result: { protocolVersion: process.env.FIXTURE_BAD_VERSION ? 999 : 1, agentCapabilities: { loadSession: !!process.env.FIXTURE_SESSIONS_FILE, promptCapabilities: { image: !!process.env.FIXTURE_IMAGES } }, authMethods: [] } });
	} else if (method === 'session/new') {
		if (!initialized) { send({ id, error: { code: -32600, message: 'Initialize first' } }); return; }
		session = 'fixture-session';
		send({ id, result: { sessionId: session, ...(process.env.FIXTURE_MODELS ? { models: { availableModels: [{ modelId: 'fixture-fast', name: 'Fast fixture' }, { modelId: 'fixture-deep', name: 'Deep fixture' }] } } : {}), ...(process.env.FIXTURE_MODES ? { modes: { currentModeId: mode, availableModes: [{ id: 'act', name: 'Act' }, { id: 'review', name: 'Read-only Review' }, { id: 'plan', name: 'Plan' }] } } : {}) } });
	} else if (method === 'session/load') {
		if (process.env.FIXTURE_LOAD_FAIL || !process.env.FIXTURE_SESSIONS_FILE || !fs.existsSync(process.env.FIXTURE_SESSIONS_FILE)) { send({ id, error: { code: -32602, message: 'Session not found' } }); return; }
		session = params.sessionId;
		count = JSON.parse(fs.readFileSync(process.env.FIXTURE_SESSIONS_FILE, 'utf8')).count;
		// Replay should never surface as a fresh response or trigger host permissions.
		send({ method: 'session/update', params: { sessionId: session, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD REPLAY' } } } });
		send({ id, result: { modes: { availableModes: [{ id: 'act' }, { id: 'plan' }] } } });
	} else if (method === 'session/set_model') {
		selectedModel = params.modelId; send({ id, result: {} });
	} else if (method === 'session/set_mode') {
		mode = params.modeId;
		send({ id, result: {} });
	} else if (method === 'session/prompt') {
		count++;
		if (process.env.FIXTURE_SESSIONS_FILE) { fs.writeFileSync(process.env.FIXTURE_SESSIONS_FILE, JSON.stringify({ count })); }
		const text = params.prompt[0].text;
		if (text === 'usage-report') {
			send({ method: 'session/update', params: { sessionId: session, update: { sessionUpdate: 'usage_update', used: 1200, size: 200000, cost: { amount: 0.25, currency: 'USD' } } } });
		}
		if (text === 'many-tools') {
			for (const toolCallId of ['one', 'one', 'two']) { send({ method: 'session/update', params: { sessionId: session, update: { sessionUpdate: 'tool_call', toolCallId, kind: 'read', status: 'in_progress' } } }); }
		}
		if (text.includes('partial-tool-updates')) {
			for (const update of [
				{ sessionUpdate: 'tool_call', toolCallId: 'read', title: 'Read file', kind: 'read', status: 'in_progress' },
				{ sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'completed', rawOutput: 'First heading' },
				{ sessionUpdate: 'tool_call_update', toolCallId: 'read', title: 'Read README.md' },
			]) { send({ method: 'session/update', params: { sessionId: session, update } }); }
		}
		if (text === 'crash') { process.exit(7); }
		if (text === 'oversize') { process.stdout.write('x'.repeat(5 * 1024 * 1024)); return; }
		if (text === 'slow' || text === 'ignore-cancel') { pending = { id, ignore: text === 'ignore-cancel' }; return; }
		if (text === 'leave-review-mode') { pending = { id }; send({ method: 'session/update', params: { sessionId: session, update: { sessionUpdate: 'current_mode_update', modeId: 'act' } } }); return; }
		const finish = outcome => {
			const content = JSON.stringify({ pid: process.pid, count, cwd: process.cwd(), text, images: params.prompt.filter(part => part.type === 'image'), outcome, mode, model: selectedModel ?? process.env.ANTHROPIC_MODEL });
			const frame = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: session, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: content + ' 😀' } } } }) + '\n');
			const split = frame.indexOf(Buffer.from('😀')) + 1;
			process.stdout.write(frame.subarray(0, split)); process.stdout.write(frame.subarray(split));
			send({ id, result: { stopReason: 'end_turn' } });
		};
		if (text === 'permission') {
			permission = { id, finish };
			// Deliberately reuse the client's request id in the opposite direction.
			send({ id, method: 'session/request_permission', params: { sessionId: session, toolCall: { toolCallId: 'edit-1', title: 'Edit fixture', kind: 'edit' }, options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] } });
		} else { finish(); }
	} else if (method === 'session/cancel') {
		if (process.env.FIXTURE_CANCEL_FILE) { fs.writeFileSync(process.env.FIXTURE_CANCEL_FILE, 'cancelled'); }
		if (pending && !pending.ignore) { send({ id: pending.id, result: { stopReason: 'cancelled' } }); pending = undefined; }
	} else if (!method && permission && id === permission.id) {
		permission.finish(message.result?.outcome); permission = undefined;
	} else if (id !== undefined) { send({ id, error: { code: -32601, message: `Unexpected method ${method}` } }); }
});
