/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
interface DependencyTask { readonly id: string; readonly dependencies: readonly string[]; readonly state: string; readonly assignee: string; readonly instruction?: string; readonly scopeFiles?: readonly string[] }
export interface DependencySchedule { waves: string[][]; blocking: Record<string, string[]> }
/** Stable guard shared by the editor preview and host commit. */
export function dependencyRevision(tasks: readonly DependencyTask[]): string {
	return JSON.stringify(tasks.map(task => [task.id, [...task.dependencies].sort(), task.state, task.assignee, task.instruction ?? '', [...(task.scopeFiles ?? [])].sort()]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}
/** Includes execution identity so a replacement plan cannot inherit an older confirmation. */
export function boardEditRevision(snapshot: { readonly executionPlanId?: string; readonly tasks: readonly DependencyTask[] }): string {
	return JSON.stringify([snapshot.executionPlanId ?? null, dependencyRevision(snapshot.tasks)]);
}
/** Validate the complete graph and expose parallel waves without predicting execution durations. */
export function dependencySchedule(tasks: readonly DependencyTask[]): DependencySchedule {
	const byId = new Map(tasks.map(task => [task.id, task]));
	if (byId.size !== tasks.length) { throw new Error('Task IDs must be unique.'); }
	for (const task of tasks) {
		if (new Set(task.dependencies).size !== task.dependencies.length || task.dependencies.some(id => id === task.id || !byId.has(id))) { throw new Error(`Invalid or missing dependency on ${task.id}.`); }
	}
	// Completed tasks satisfy their dependants immediately, but their saved
	// links must still participate in validation of the complete graph.
	const visiting = new Set<string>(); const visited = new Set<string>();
	const visit = (id: string): void => {
		if (visiting.has(id)) { throw new Error(`Dependency cycle: ${[...visiting, id].join(' → ')}`); }
		if (visited.has(id)) { return; }
		visiting.add(id); for (const dependency of byId.get(id)!.dependencies) { visit(dependency); }
		visiting.delete(id); visited.add(id);
	};
	for (const id of byId.keys()) { visit(id); }
	const pending = new Set(tasks.filter(task => task.state !== 'done').map(task => task.id));
	const complete = new Set(tasks.filter(task => task.state === 'done').map(task => task.id));
	const waves: string[][] = [];
	const blocking: Record<string, string[]> = Object.fromEntries(tasks.map(task => [task.id, task.state === 'done' ? [] : task.dependencies.filter(dependency => !complete.has(dependency))]));
	while (pending.size) {
		const wave = [...pending].filter(id => byId.get(id)!.dependencies.every(dependency => complete.has(dependency)));
		if (!wave.length) { throw new Error(`Dependency cycle: ${[...pending].join(' → ')}`); }
		for (const id of wave) { pending.delete(id); complete.add(id); }
		waves.push(wave);
	}
	return { waves, blocking };
}
