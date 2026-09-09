/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
interface EditableTask {
	readonly id: string;
	readonly instruction: string;
	readonly assignee: string;
	readonly scopeFiles: readonly string[];
	readonly dependencies: readonly string[];
}

/** Captures the complete editable plan; unrelated reads never refresh a caller's revision. */
export function planEditRevision(planId: string, tasks: readonly EditableTask[]): string {
	return JSON.stringify([planId, tasks.map(task => [task.id, task.instruction, task.assignee, [...task.scopeFiles].sort(), [...task.dependencies].sort()]).sort((left, right) => String(left[0]).localeCompare(String(right[0])))]);
}
