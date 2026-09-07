/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * @fileoverview Top-level layout for the Task Board webview.
 *
 * Hosts the kanban grid + the embedded "Talk to the board" chat sidebar.
 * Subscribes to host snapshot pushes via window.message events. Re-fires
 * `refresh` on mount so the host pushes the current state immediately
 * (the host already does this on construction, but the React tree may
 * mount after that initial push if the bundle is still loading).
 */

import { useEffect, useMemo, useState } from 'react';
import { BoardChat } from './BoardChat';
import { KanbanColumn } from './KanbanColumn';
import { postToHost } from './vscode';
import type { BoardSnapshotView, PersonaView, SubtaskState, HostToWebviewMessage } from './protocol';
import { boardStyles } from './styles';

interface BoardState {
	readonly conversationId: string | null;
	readonly conversationTitle: string;
	readonly snapshot: BoardSnapshotView | null;
	readonly personas: ReadonlyArray<PersonaView>;
}

const INITIAL_STATE: BoardState = {
	conversationId: null,
	conversationTitle: '',
	snapshot: null,
	personas: [],
};

const COLUMNS: ReadonlyArray<{ state: SubtaskState; title: string }> = [
	{ state: 'backlog', title: 'Backlog' },
	{ state: 'ready', title: 'Ready' },
	{ state: 'in-progress', title: 'In Progress' },
	{ state: 'review', title: 'In Review' },
	{ state: 'done', title: 'Done' },
	{ state: 'failed', title: 'Failed' },
];

export function BoardApp(): JSX.Element {
	const [state, setState] = useState<BoardState>(INITIAL_STATE);

	useEffect(() => {
		const handler = (ev: MessageEvent): void => {
			const msg = ev.data as HostToWebviewMessage | undefined;
			if (!msg || msg.type !== 'snapshot') {
				return;
			}
			setState({
				conversationId: msg.conversationId,
				conversationTitle: msg.conversationTitle,
				snapshot: msg.snapshot,
				personas: msg.personas,
			});
		};
		window.addEventListener('message', handler);
		// Ask the host for the latest snapshot — covers the case where the
		// React mount happened after the host's initial pushSnapshot().
		postToHost({ type: 'refresh' });
		return () => window.removeEventListener('message', handler);
	}, []);

	return (
		<>
			<style>{boardStyles}</style>
			<BoardInner state={state} />
		</>
	);
}

interface BoardInnerProps {
	readonly state: BoardState;
}

/**
 * Task filters and assistant controls. The host supplies board context and validates actions.
 */
function BoardInner({ state }: BoardInnerProps): JSX.Element {
	const [query, setQuery] = useState('');
	const [assignee, setAssignee] = useState('');
	const [filter, setFilter] = useState<'all' | 'active' | 'attention' | 'done'>('all');
	const [chatOpen, setChatOpen] = useState(false);
	const personasById = useMemo(() => {
		const map = new Map<string, PersonaView>();
		for (const p of state.personas) {
			map.set(p.id, p);
		}
		return map;
	}, [state.personas]);

	const assignees = useMemo(() => state.personas.map(p => p.id), [state.personas]);


	const tasks = state.snapshot?.tasks ?? [];
	const visibleTasks = tasks.filter(task => {
		const matchesQuery = [task.instruction, task.id, task.assignee, ...task.scopeFiles].join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
		const matchesFilter = filter === 'all' || (filter === 'active' && ['in-progress', 'review'].includes(task.state)) || (filter === 'attention' && task.state === 'failed') || (filter === 'done' && task.state === 'done');
		return matchesQuery && matchesFilter && (!assignee || task.assignee === assignee);
	});
	const buckets = bucketize(visibleTasks);
	const completed = tasks.filter(task => task.state === 'done').length;
	const active = tasks.filter(task => task.state === 'in-progress' || task.state === 'review').length;
	const failed = tasks.filter(task => task.state === 'failed').length;
	const progress = tasks.length ? Math.round(completed / tasks.length * 100) : 0;
	const isFiltered = !!(query || assignee || filter !== 'all');

	const onRefresh = (): void => postToHost({ type: 'refresh' });

	const hasTasks = !!state.snapshot && state.snapshot.tasks.length > 0;

	return (
		<main className="shell">
			<header className="header">
				<div className="board-heading">
					<span className="eyebrow">Son of Anton / Task Board</span>
					<h1>{state.conversationId ? state.conversationTitle : 'From idea to done.'}</h1>
					<p>Follow the plan. See what needs you. Keep work moving.</p>
				</div>
				<div className="header-actions">
					<button type="button" className="quiet-button" onClick={() => postToHost({ type: 'review-council' })}>Review with Council</button>
					<button type="button" className="quiet-button" onClick={onRefresh}>Refresh</button>
					<button type="button" className="secondary-button" aria-expanded={chatOpen} aria-controls="board-assistant" onClick={() => setChatOpen(!chatOpen)}>{chatOpen ? 'Hide Assistant' : 'Ask Anton'}</button>
				</div>
			</header>
			{hasTasks && <>
				<section className="board-overview" aria-label="Plan progress">
					<div className="progress-summary"><strong>{progress}%</strong><div><span>{completed} of {tasks.length} complete</span><progress value={completed} max={tasks.length} aria-label="Tasks completed" /></div></div>
					<div className="overview-filters" aria-label="Filter tasks">
						{([{ value: 'all', label: 'All Tasks', count: tasks.length }, { value: 'active', label: 'Active', count: active }, { value: 'attention', label: 'Needs Attention', count: failed }, { value: 'done', label: 'Completed', count: completed }] as const).map(item => <button key={item.value} type="button" className={`overview-filter ${item.value}`} aria-pressed={filter === item.value} onClick={() => setFilter(item.value)}><span className="status-dot" />{item.label}<span className="filter-count">{item.count}</span></button>)}
					</div>
				</section>
				<div className="board-toolbar">
					<label className="task-search"><span aria-hidden="true">⌕</span><input type="search" aria-label="Search tasks" placeholder="Search tasks, files, or agents…" value={query} onChange={event => setQuery(event.target.value)} /></label>
					<select aria-label="Filter by agent" value={assignee} onChange={event => setAssignee(event.target.value)}><option value="">All Agents</option>{assignees.map(id => <option key={id} value={id}>@{id}</option>)}</select>
					<span className="results-count" role="status">{visibleTasks.length} {visibleTasks.length === 1 ? 'task' : 'tasks'}</span>
					{isFiltered && <button type="button" className="quiet-button" onClick={() => { setQuery(''); setAssignee(''); setFilter('all'); }}>Clear Filters</button>}
				</div>
			</>}
			<div className={`board-layout${chatOpen ? ' with-assistant' : ''}`}>
				{!hasTasks && (
					<section className="empty">
						<div className="empty-board-mark" aria-hidden="true"><span /><span /><span /></div>
						<span className="eyebrow">A clear path forward</span>
						<h2>Your next project starts here.</h2>
						<p>Describe what you want to build in chat. Anton will break it into tasks you can follow, run, and review here.</p>
						<button type="button" className="primary-button" onClick={() => postToHost({ type: 'open-chat' })}>Open Chat <span aria-hidden="true">↗</span></button>
						<div className="empty-workflow"><span>01 · Plan</span><span>02 · Build</span><span>03 · Review</span></div>
					</section>
				)}
				{hasTasks && (
					<section className="columns" aria-label="Task board" tabIndex={0}>
						{visibleTasks.length === 0 && <div className="column-empty">No tasks match your filters.</div>}
						{COLUMNS.filter(col => !isFiltered || buckets[col.state].length > 0).map(col => (
							<KanbanColumn
								key={col.state}
								title={col.title}
								state={col.state}
								tasks={buckets[col.state]}
								personasById={personasById}
							/>
						))}
					</section>
				)}
				<div id="board-assistant" className="assistant-container" hidden={!chatOpen}><BoardChat key={state.conversationId ?? 'empty'} assignees={assignees} /></div>
			</div>
		</main>
	);
}

function bucketize(tasks: BoardSnapshotView['tasks']): Record<SubtaskState, BoardSnapshotView['tasks'][number][]> {
	const buckets: Record<SubtaskState, BoardSnapshotView['tasks'][number][]> = {
		'backlog': [],
		'ready': [],
		'in-progress': [],
		'review': [],
		'done': [],
		'failed': [],
	};
	for (const task of tasks) {
		const bucket = buckets[task.state] ?? buckets.backlog;
		bucket.push(task);
	}
	return buckets;
}
