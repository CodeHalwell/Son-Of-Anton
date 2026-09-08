/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { postToHost } from './vscode';
import type { SubtaskState } from './protocol';
/** Dispatch a tool result through the same host validation as direct board controls. */
export function dispatchBoardAction(actionName: string, args: Record<string, unknown>, conversationId?: string | null): void {
	const cardId = typeof args.cardId === 'string' ? args.cardId : undefined;
	const toColumn = typeof args.toColumn === 'string' ? (args.toColumn as SubtaskState) : undefined;
	const assignee = typeof args.assignee === 'string' ? args.assignee : undefined;
	const priority = typeof args.priority === 'string' ? (args.priority as 'low' | 'medium' | 'high') : undefined;
	const instruction = typeof args.instruction === 'string' ? args.instruction : undefined;
	switch (actionName) {
		case 'moveCard':
		case 'setCardStatus':
			if (cardId && toColumn) {
				postToHost({ type: 'board-action', conversationId, action: actionName, cardId, toColumn });
			}
			return;
		case 'addCard':
			if (instruction) {
				postToHost({ type: 'board-action', conversationId, action: 'addCard', instruction, assignee });
			}
			return;
		case 'setCardAssignee':
			if (cardId && assignee) {
				postToHost({ type: 'board-action', conversationId, action: 'setCardAssignee', cardId, assignee });
			}
			return;
		case 'setCardPriority':
			if (cardId && priority) {
				postToHost({ type: 'board-action', conversationId, action: 'setCardPriority', cardId, priority });
			}
			return;
	}
}
