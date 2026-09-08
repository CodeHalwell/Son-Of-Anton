/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * @fileoverview Single tile (card) on the kanban board. Ports the existing
 * vanilla-JS `renderTile` function from TaskBoardPanel.ts to React JSX.
 * Drag/drop uses the native HTML5 API — no react-dnd dependency.
 */

import { useCallback } from 'react';
import type { DragEvent } from 'react';
import { postToHost } from './vscode';
import type { BoardTaskView, PersonaView } from './protocol';

interface KanbanCardProps {
	readonly task: BoardTaskView;
	readonly persona: PersonaView | undefined;
}

const FALLBACK_PERSONA: PersonaView = {
	id: 'unknown',
	monogram: '?',
	accent: 'var(--vscode-descriptionForeground)',
	tagline: '',
};

export function KanbanCard({ task, persona }: KanbanCardProps): JSX.Element {
	const p = persona ?? FALLBACK_PERSONA;
	const idShort = task.id.split('-').slice(-2).join('-');

	const onDragStart = useCallback((ev: DragEvent<HTMLDivElement>): void => {
		ev.currentTarget.classList.add('dragging');
		if (ev.dataTransfer) {
			ev.dataTransfer.effectAllowed = 'move';
			ev.dataTransfer.setData('text/plain', JSON.stringify({
				taskId: task.id,
				fromState: task.state,
				assignee: task.assignee,
			}));
		}
	}, [task.id, task.state, task.assignee]);

	const onDragEnd = useCallback((ev: DragEvent<HTMLDivElement>): void => {
		ev.currentTarget.classList.remove('dragging');
	}, []);

	const onClick = useCallback((): void => {
		postToHost({ type: 'reveal', taskId: task.id });
	}, [task.id]);

	const visibleScope = task.scopeFiles.slice(0, 3);
	const hiddenScopeCount = Math.max(0, task.scopeFiles.length - visibleScope.length);
	const title = task.instruction.split('\n').find(line => line.trim()) ?? task.instruction;

	return (
		<div
			className="tile"
			draggable={['ready', 'done', 'failed'].includes(task.state)}
			onDragStart={onDragStart}
			onDragEnd={onDragEnd}
			data-task-id={task.id}
			data-state={task.state}
			data-assignee={task.assignee}
			aria-label={task.instruction}
		>
			<div className="tile-row">
				<span className="tile-id">{idShort}</span>
				<span className={`tile-status-pill ${task.state}`}>{task.state === 'in-progress' ? 'Running' : task.state === 'review' ? 'In Review' : task.state === 'failed' ? 'Needs Attention' : task.state}</span>
			</div>
			<details className="task-details"><summary className="tile-instruction"><span>{title}</span></summary><div className="task-detail-body">
				<p className="task-full-instruction">{task.instruction}</p>
				{task.summary ? <p>{task.summary}</p> : <p>No execution summary yet.</p>}
				{task.scopeFiles.length > 0 && <ul aria-label="Files in scope">{task.scopeFiles.map(file => <li key={file}><code>{file}</code></li>)}</ul>}
				{task.dependencies.length > 0 && <p>Depends on {task.dependencies.join(', ')}</p>}
				{task.tokenUsage && <p>{task.tokenUsage.input.toLocaleString()} input · {task.tokenUsage.output.toLocaleString()} output tokens</p>}
			</div></details>
			<div className="tile-assignee">
				<span className="avatar" style={{ color: p.accent }} aria-hidden="true">{p.monogram}</span>
				<span className="tile-name">@{task.assignee}</span>
			</div>
			{task.scopeFiles.length > 0 && (
				<div className="chips">
					{visibleScope.map(file => (
						<span key={file} className="chip" title={file}>{file.split(/[\\/]/).pop()}</span>
					))}
					{hiddenScopeCount > 0 && (
						<span className="chip">+{hiddenScopeCount} more</span>
					)}
				</div>
			)}
			{task.dependencies.length > 0 && (
				<div className="chips">
					<span className="chip dep">
						{task.dependencies.length} {task.dependencies.length === 1 ? 'dependency' : 'dependencies'}
					</span>
				</div>
			)}
			{task.state === 'failed' && task.summary && <div className="tile-summary">{task.summary}</div>}
			<div className="tile-actions">
				{task.proposalId && <button type="button" className="card-action" onClick={() => postToHost({ type: 'review-proposal', taskId: task.id })}>Review Changes</button>}
				{task.state === 'in-progress' && task.id.startsWith('council:') && <button type="button" className="card-action" onClick={() => postToHost({ type: 'cancel-task', taskId: task.id })}>Cancel Task</button>}
				<button type="button" className="quiet-button" onClick={onClick} aria-label={`View task ${idShort} in chat`}>View in Chat <span aria-hidden="true">↗</span></button>
				{task.state === 'ready' && <button type="button" className="card-action" onClick={() => postToHost({ type: 'dispatch', taskId: task.id })}>Run Task</button>}
				{(task.state === 'failed' || task.state === 'done') && <button type="button" className="card-action" onClick={() => postToHost({ type: 'rerun', taskId: task.id })}>{task.state === 'failed' ? 'Retry' : 'Run Again'}</button>}
			</div>
		</div>
	);
}
