/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { useEffect, useMemo, useState } from 'react';
import type { BoardTaskView } from './protocol';
import { dependencyRevision, dependencySchedule } from './dependencyGraph';
import { postToHost } from './vscode';

/** Editable prerequisite links and a deterministic preview of parallel scheduling waves. */
export function DependencyEditor({ tasks }: { tasks: readonly BoardTaskView[] }): JSX.Element {
	const [selected, setSelected] = useState(tasks[0]?.id ?? '');
	const [dependencies, setDependencies] = useState<readonly string[]>([]);
	const revision = dependencyRevision(tasks);
	useEffect(() => { if (!tasks.some(task => task.id === selected)) { setSelected(tasks[0]?.id ?? ''); } setDependencies(tasks.find(task => task.id === selected)?.dependencies ?? []); }, [revision, selected]);
	const task = tasks.find(task => task.id === selected);
	const preview = useMemo(() => {
		try { return { schedule: dependencySchedule(tasks.map(item => item.id === selected ? { ...item, dependencies } : item)), error: '' }; }
		catch (error) { return { schedule: undefined, error: error instanceof Error ? error.message : String(error) }; }
	}, [revision, selected, dependencies]);
	const changed = JSON.stringify([...(task?.dependencies ?? [])].sort()) !== JSON.stringify([...dependencies].sort());
	const running = tasks.some(item => ['in-progress', 'review'].includes(item.state));
	return <section className="dependency-editor" aria-label="Dependency planner">
		<div className="dependency-controls">
			<h2>Dependency Planner</h2><p>Choose prerequisites and preview what can run together. Apply updates the pending execution plan after confirmation.</p>
			<label>Task<select aria-label="Task to edit dependencies" value={selected} onChange={event => setSelected(event.target.value)}>{tasks.map(item => <option key={item.id} value={item.id}>{item.instruction.slice(0, 80)}</option>)}</select></label>
			<fieldset disabled={running || !task || !['backlog', 'ready'].includes(task.state)}><legend>Prerequisites</legend><div className="dependency-options">{tasks.filter(item => item.id !== selected).map(item => <label key={item.id}><input type="checkbox" checked={dependencies.includes(item.id)} onChange={event => setDependencies(event.target.checked ? [...dependencies, item.id] : dependencies.filter(id => id !== item.id))} /><span>{item.instruction}<small>{item.id} · {item.state}</small></span></label>)}</div></fieldset>
			{preview.error && <p role="alert" className="dependency-error">{preview.error}</p>}
			{running && <p role="status">Dependencies can be edited when the plan is idle.</p>}
			<button type="button" className="primary-button" disabled={!changed || !!preview.error || running} onClick={() => postToHost({ type: 'set-dependencies', taskId: selected, dependencies: [...dependencies], expectedRevision: revision })}>Apply Dependencies</button>
		</div>
		<div className="dependency-preview" aria-label="Scheduling preview"><h3>Scheduling Preview</h3><p>Tasks in a wave have no prerequisite links to one another. Agent availability and file scope may limit concurrency.</p>
			{preview.schedule?.waves.map((wave, index) => <section key={index} className="dependency-wave"><h4>Wave {index + 1}</h4><ul>{wave.map(id => <li key={id}><button type="button" onClick={() => setSelected(id)} aria-pressed={selected === id}>{tasks.find(item => item.id === id)?.instruction}<small>{preview.schedule!.blocking[id].length ? `Blocked by ${preview.schedule!.blocking[id].join(', ')}` : 'No unfinished prerequisites'}</small></button></li>)}</ul></section>)}
		</div>
	</section>;
}
