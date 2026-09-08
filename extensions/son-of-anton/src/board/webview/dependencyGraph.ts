/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
interface DependencyTask { readonly id: string; readonly dependencies: readonly string[]; readonly state: string; readonly assignee: string }
export interface DependencySchedule { waves: string[][]; blocking: Record<string, string[]> }
/** Stable guard shared by the editor preview and host commit. */
export function dependencyRevision(tasks: readonly DependencyTask[]): string {
	return JSON.stringify(tasks.map(task => [task.id, [...task.dependencies].sort(), task.state, task.assignee]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}
/** Validate the complete graph and expose parallel waves without predicting execution durations. */
export function dependencySchedule(tasks: readonly DependencyTask[]): DependencySchedule {
	const byId = new Map(tasks.map(task => [task.id, task]));
	if (byId.size !== tasks.length) { throw new Error('Task IDs must be unique.'); }
	for (const task of tasks) {
		if (new Set(task.dependencies).size !== task.dependencies.length || task.dependencies.some(id => id === task.id || !byId.has(id))) { throw new Error(`Invalid or missing dependency on ${task.id}.`); }
	}
	const pending = new Set(tasks.map(task => task.id)); const complete = new Set<string>(); const waves: string[][] = []; const blocking: Record<string, string[]> = {};
	while (pending.size) {
		const wave = [...pending].filter(id => byId.get(id)!.dependencies.every(dependency => complete.has(dependency)));
		if (!wave.length) { throw new Error(`Dependency cycle: ${[...pending].join(' → ')}`); }
		for (const id of wave) { pending.delete(id); complete.add(id); blocking[id] = byId.get(id)!.dependencies.filter(dependency => byId.get(dependency)!.state !== 'done'); }
		const unfinished = wave.filter(id => byId.get(id)!.state !== 'done'); if (unfinished.length) { waves.push(unfinished); }
	}
	return { waves, blocking };
}
