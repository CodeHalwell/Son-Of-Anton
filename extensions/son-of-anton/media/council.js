/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
(() => {
	'use strict';
	const vscode = acquireVsCodeApi();
	const labels = JSON.parse(document.getElementById('labels').textContent);
	const t = (key, ...args) => (labels[key] || key).replace(/\{(\d+)\}/g, (_, index) => String(args[Number(index)] ?? ''));
	const byId = id => document.getElementById(id);
	const node = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) { element.textContent = text; } if (className) { element.className = className; } return element; };
	const button = (label, action, data = {}) => { const element = node('button', t(label)); element.type = 'button'; element.dataset.action = action; Object.assign(element.dataset, data); element.dataset.key = [action, data.id, data.stage, data.index].join(':'); return element; };
	const saved = vscode.getState() || {};
	const reports = new Map(); let groups = []; let selected = saved.selected; let starting = false;
	document.querySelectorAll('[data-label]').forEach(element => { element.textContent = t(element.dataset.label); });
	byId('objective').value = saved.objective ?? t('objectiveHint'); byId('report').textContent = t('loading');
	byId('revision').value = saved.revision ?? 'HEAD'; byId('rounds').value = saved.rounds ?? '1'; byId('finalReview').checked = !!saved.finalReview;
	const saveDraft = () => vscode.setState({ selected, objective: byId('objective').value, revision: byId('revision').value, rounds: byId('rounds').value, groupId: byId('group').value, finalReview: byId('finalReview').checked });
	byId('startForm').addEventListener('input', saveDraft);
	function showError(error) { byId('error').textContent = error || ''; byId('error').hidden = !error; }
	function controls() {
		const group = groups.find(group => group.id === byId('group').value);
		byId('start').disabled = starting || !group || [...reports.values()].some(report => report.status === 'running' && report.owned);
		if (group) { byId('parameters').textContent = t('parameters', group.members.length, group.quorum, group.concurrency, group.runTimeoutMs / 60000); byId('finalReview').disabled = !group.reviewer; }
	}
	function render() {
		const history = byId('history'); history.replaceChildren();
		for (const report of [...reports.values()].sort((a, b) => b.createdAt - a.createdAt)) {
			const row = button('', 'select', { id: report.id }); row.textContent = ''; row.className = 'history-row'; row.setAttribute('aria-current', String(selected === report.id)); const wrapper = node('div'); wrapper.setAttribute('role', 'listitem');
			row.append(node('span', report.objective.slice(0, 100)), node('span', `${t(report.status === 'completed' ? 'complete' : report.status)} · ${new Date(report.createdAt).toLocaleString()}`, 'meta')); wrapper.append(row); history.append(wrapper);
		}
		if (!reports.size) { history.append(node('p', t('empty'), 'muted')); }
		const target = byId('report'); const focused = document.activeElement.dataset.key;
		const open = new Set([...target.querySelectorAll('details[open]')].map(element => element.dataset.key));
		target.replaceChildren(); const report = reports.get(selected);
		if (!report) { target.append(node('p', t('noSelection'), 'muted')); controls(); return; }
		if (!report.snapshot) { target.append(node('p', t('loading'), 'muted')); controls(); return; }
		const heading = node('div', undefined, 'stage-heading'); heading.append(node('h2', report.objective), node('span', t(report.status === 'completed' ? 'complete' : report.status), 'badge')); target.append(heading);
		if (report.error) { target.append(node('p', report.error, 'prose')); }
		const actions = node('div', undefined, 'actions');
		if (report.status === 'running' && report.owned) { actions.append(button('cancel', 'cancel', { id: report.id })); }
		actions.append(button('export', 'export', { id: report.id })); target.append(actions);
		const scope = node('details', undefined, 'scope'); scope.dataset.key = 'scope'; scope.open = open.has('scope'); scope.append(node('summary', t('scope')));
		scope.append(node('p', `Base ${report.snapshot.base}\nHEAD ${report.snapshot.head}\nSHA-256 ${report.snapshot.digest}`, 'prose'), node('p', report.snapshot.limitations.join('\n'), 'prose')); target.append(scope);
		const completed = report.stages.filter(stage => stage.status === 'completed').length;
		const total = report.group.members.length * report.group.rounds + 1 + (report.group.reviewer ? 1 : 0);
		target.append(node('p', t('progress', completed, total), 'muted'));
		for (const stage of report.stages) {
			const card = node('article', undefined, 'stage'); card.dataset.status = stage.status;
			const header = node('div', undefined, 'stage-heading'); header.append(node('h3', `${stage.member.label} · ${t(stage.kind)} · ${t('round', stage.round)}`), node('span', t(stage.status === 'completed' ? 'complete' : stage.status), 'badge')); card.append(header);
			card.append(node('p', stage.member.acpAgent ? `ACP · ${stage.member.acpAgent} · ${stage.member.readOnlyMode}` : stage.member.model, 'muted'));
			card.append(node('p', stage.usage ? t('tokens', stage.usage.inputTokens, stage.usage.outputTokens) : t('usage'), 'muted'));
			if (stage.error) { card.append(node('p', stage.error, 'prose')); }
			if (stage.answer) {
				card.append(node('p', stage.answer.summary, 'prose'));
				if (stage.status === 'completed' && stage.answer.findings.length && report.status !== 'running') { card.append(button('promote', 'promote', { id: report.id, stage: stage.id })); }
				stage.answer.findings.forEach((finding, index) => { const item = node('div', undefined, 'finding'); item.append(node('h3', `${finding.severity.toUpperCase()} · ${finding.title}`), node('p', `${finding.file}:${finding.line}`, 'muted'), node('p', finding.detail, 'prose'), node('pre', finding.evidence), button('evidence', 'evidence', { id: report.id, stage: stage.id, index: String(index) })); card.append(item); });
				for (const [key, values] of [['disagreements', stage.answer.dissent], ['questions', stage.answer.questions]]) { if (values.length) { card.append(node('h3', t(key))); const list = node('ul'); values.forEach(value => list.append(node('li', value))); card.append(list); } }
			} else if (stage.text) { const raw = node('details'); raw.dataset.key = stage.id; raw.open = stage.status === 'running' || open.has(stage.id); raw.append(node('summary', t('raw')), node('pre', stage.text)); card.append(raw); }
			target.append(card);
		}
		if (focused) { [...document.querySelectorAll('button')].find(element => element.dataset.key === focused)?.focus({ preventScroll: true }); }
		controls();
	}
	function merge(report) { const previous = reports.get(report?.id); if (!report?.id || (previous?.sequence ?? -1) > report.sequence || (!report.snapshot && previous?.snapshot && previous.sequence === report.sequence)) { return; } reports.set(report.id, report); }
	window.addEventListener('message', event => {
		// VS Code's same-origin wrapper shadows window.parent inside the webview.
		if (event.origin !== window.origin) { return; }
		const message = event.data;
		if (!message || typeof message !== 'object') { return; }
		if (message.type === 'councilState') {
			if (message.groups) { const initial = !groups.length; const current = byId('group').value || saved.groupId; groups = message.groups; byId('group').replaceChildren(...groups.map(group => { const option = node('option', group.name); option.value = group.id; return option; })); if (groups.some(group => group.id === current)) { byId('group').value = current; } if (initial && saved.rounds === undefined) { byId('rounds').value = String(groups.find(group => group.id === byId('group').value)?.rounds ?? 1); } }
			(message.reports || []).forEach(merge); if (message.selected) { selected = message.selected; } selected ||= message.reports?.[0]?.id;
			starting = false; showError(message.error); render();
		} else if (message.type === 'councilReport') { merge(message.report); selected ||= message.report.id; render(); }
	});
	byId('group').addEventListener('change', () => { const group = groups.find(group => group.id === byId('group').value); if (group) { byId('rounds').value = String(group.rounds); } saveDraft(); controls(); });
	byId('startForm').addEventListener('submit', event => { event.preventDefault(); if (byId('start').disabled) { return; } starting = true; controls(); showError(''); vscode.postMessage({ type: 'start', objective: byId('objective').value, groupId: byId('group').value, revision: byId('revision').value, rounds: Number(byId('rounds').value), finalReview: byId('finalReview').checked }); });
	byId('refresh').addEventListener('click', () => vscode.postMessage({ type: 'ready', selected }));
	byId('groups').addEventListener('click', () => vscode.postMessage({ type: 'groups' }));
	document.addEventListener('click', event => { const target = event.target.closest('button[data-action]'); if (!target) { return; } const { action, id, stage, index } = target.dataset; if (action === 'select') { selected = id; saveDraft(); render(); vscode.postMessage({ type: 'select', id }); } else { vscode.postMessage({ type: action, id, stageId: stage, index: index === undefined ? undefined : Number(index) }); } });
	vscode.postMessage({ type: 'ready', selected });
})();
