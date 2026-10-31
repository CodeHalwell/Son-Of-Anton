/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface GraphSelection { path?: string; name?: string; nodeId?: string }
export interface GraphViewPosition { scrollY: number; focus?: string }
interface GraphVisit { selection: GraphSelection; position: GraphViewPosition }

/** Keep a bounded trail of successful queries, including the position to restore on Back. */
export class GraphHistory {
	private readonly visits: GraphVisit[];
	constructor(selection: GraphSelection, private readonly limit = 20) {
		if (!Number.isSafeInteger(limit) || limit < 1) { throw new Error('Invalid graph history limit.'); }
		this.visits = [{ selection: { ...selection }, position: { scrollY: 0 } }];
	}
	get current(): GraphVisit { return this.copy(this.visits[this.visits.length - 1]); }
	get previous(): GraphVisit | undefined { return this.visits.length > 1 ? this.copy(this.visits[this.visits.length - 2]) : undefined; }
	visit(selection: GraphSelection, returnPosition: GraphViewPosition, position: GraphViewPosition): void {
		const current = this.visits[this.visits.length - 1];
		current.position = { ...returnPosition };
		if (current.selection.path === selection.path && current.selection.name === selection.name && current.selection.nodeId === selection.nodeId) { current.position = { ...position }; return; }
		this.visits.push({ selection: { ...selection }, position: { ...position } });
		if (this.visits.length > this.limit) { this.visits.shift(); }
	}
	back(): void { if (this.visits.length > 1) { this.visits.pop(); } }
	private copy(visit: GraphVisit): GraphVisit { return { selection: { ...visit.selection }, position: { ...visit.position } }; }
}
