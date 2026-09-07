/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
const readline = require('node:readline');
const fs = require('node:fs');
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
let initialized = false, session, count = 0, pending, permission, mode = 'act';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
	const message = JSON.parse(line);
	const { id, method, params } = message;
	if (method === 'initialize') {
		if (process.env.FIXTURE_NO_INIT) { return; }
		initialized = true;
		send({ id, result: { protocolVersion: process.env.FIXTURE_BAD_VERSION ? 999 : 1, agentCapabilities: {}, authMethods: [] } });
	} else if (method === 'session/new') {
		if (!initialized) { send({ id, error: { code: -32600, message: 'Initialize first' } }); return; }
		session = 'fixture-session';
		send({ id, result: { sessionId: session, ...(process.env.FIXTURE_MODES ? { modes: { currentModeId: mode, availableModes: [{ id: 'act', name: 'Act' }, { id: 'review', name: 'Read-only Review' }] } } : {}) } });
	} else if (method === 'session/set_mode') {
		mode = params.modeId;
		send({ id, result: {} });
	} else if (method === 'session/prompt') {
		count++;
		const text = params.prompt[0].text;
		if (text === 'crash') { process.exit(7); }
		if (text === 'oversize') { process.stdout.write('x'.repeat(5 * 1024 * 1024)); return; }
		if (text === 'slow' || text === 'ignore-cancel') { pending = { id, ignore: text === 'ignore-cancel' }; return; }
		if (text === 'leave-review-mode') { pending = { id }; send({ method: 'session/update', params: { sessionId: session, update: { sessionUpdate: 'current_mode_update', modeId: 'act' } } }); return; }
		const finish = outcome => {
			const content = JSON.stringify({ pid: process.pid, count, cwd: process.cwd(), text, outcome, mode });
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
