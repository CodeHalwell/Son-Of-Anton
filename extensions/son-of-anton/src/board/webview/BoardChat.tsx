/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * @fileoverview "Talk to the board" embedded chat panel.
 *
 * This is a minimal chat UI that uses `requestStream` to round-trip
 * through the host's `LlmClient`. We don't use CopilotKit's `<CopilotChat>`
 * because that component fetches against `runtimeUrl`, which we don't
 * have in a webview context. The action / readable hooks registered
 * higher up in the tree are still in scope — the LLM sees them via the
 * system context the host injects when calling `LlmClient.streamRequest`.
 *
 * Tier 2.5: BoardChat now also forwards the tools array derived from the
 * board action registry (single source of truth in `boardActionDefs.ts`)
 * and dispatches incoming `tool-call` events back through
 * `dispatchBoardAction` — this is the exact path the manual
 * `useCopilotAction` handlers take for postMessage routing into the host.
 */

import { useCallback, useState, useRef, useEffect, useMemo } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { requestStream } from './BoardRuntime';
import { buildBoardActions, buildBoardTools } from './boardActionDefs';
import { dispatchBoardAction } from './useBoardActions';

interface ChatMessage {
	readonly role: 'user' | 'assistant';
	readonly content: string;
	readonly toolCalls?: ReadonlyArray<{ name: string; input: Record<string, unknown> }>;
}

const DEFAULT_MODEL = 'sonnet';

interface BoardChatProps {
	readonly assignees: ReadonlyArray<string>;
}

export function BoardChat({ assignees }: BoardChatProps): JSX.Element {
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [draft, setDraft] = useState('');
	const [pending, setPending] = useState(false);
	const streamingTextRef = useRef('');
	const cancelRef = useRef<{ cancel: () => void } | null>(null);
	const frameRef = useRef<number | null>(null);
	const logRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const followRef = useRef(true);
	const [following, setFollowing] = useState(true);
	const [status, setStatus] = useState('');
	const flushText = useCallback((): void => {
		if (frameRef.current !== null) { cancelAnimationFrame(frameRef.current); frameRef.current = null; }
		const content = streamingTextRef.current;
		setMessages(prev => prev.map((message, index) => index === prev.length - 1 ? { ...message, content } : message));
	}, []);

	useEffect(() => {
		if (followRef.current && logRef.current) { logRef.current.scrollTop = logRef.current.scrollHeight; }
	}, [messages]);

	// Re-derive the tools list whenever assignees change so the
	// `setCardAssignee` enum stays in sync with the active personas.
	const tools = useMemo(() => buildBoardTools(buildBoardActions(assignees)), [assignees]);

	useEffect(() => {
		return () => {
			cancelRef.current?.cancel();
			if (frameRef.current !== null) { cancelAnimationFrame(frameRef.current); }
		};
	}, []);

	const submit = useCallback((): void => {
		const trimmed = draft.trim();
		if (!trimmed || pending) {
			return;
		}
		const userMessage: ChatMessage = { role: 'user', content: trimmed };
		const next = [...messages, userMessage];
		setMessages(next);
		setDraft('');
		setPending(true);
		setStatus('Anton is working…');
		followRef.current = true;
		setFollowing(true);
		streamingTextRef.current = '';
		// Push a placeholder assistant bubble we'll mutate as tokens stream in.
		setMessages(prev => [...prev, { role: 'assistant', content: '' }]);

		const handle = requestStream(
			DEFAULT_MODEL,
			next.map(m => ({ role: m.role, content: m.content })),
			{
				onToken: (token) => {
					streamingTextRef.current += token;
					if (frameRef.current === null) { frameRef.current = requestAnimationFrame(flushText); }
				},
				onToolCall: (call) => {
					// Route through the same dispatcher the manual
					// `useCopilotAction` handlers use, so the host's
					// TaskBoardModel update path stays canonical regardless
					// of whether the user dragged a card or the LLM emitted
					// a tool-call.
					dispatchBoardAction(call.name, call.input);
					// Surface the call inside the assistant bubble so the
					// user sees what the model just did even when the
					// natural-language response is empty.
					setMessages(prev => {
						const out = prev.slice();
						const last = out[out.length - 1];
						const toolCalls = [...(last.toolCalls ?? []), { name: call.name, input: call.input }];
						out[out.length - 1] = { ...last, toolCalls };
						return out;
					});
				},
				onComplete: (fullText) => {
					flushText();
					setMessages(prev => {
						const out = prev.slice();
						const last = out[out.length - 1];
						out[out.length - 1] = { ...last, content: fullText || streamingTextRef.current };
						return out;
					});
					setPending(false);
					setStatus('Response complete');
					cancelRef.current = null;
				},
				onError: (error) => {
					flushText();
					setMessages(prev => {
						const out = prev.slice();
						out[out.length - 1] = { ...out[out.length - 1], content: [streamingTextRef.current, 'Request failed: ' + error].filter(Boolean).join('\n\n') };
						return out;
					});
					setPending(false);
					setStatus('Request failed');
					cancelRef.current = null;
				},
			},
			tools,
		);
		cancelRef.current = handle;
	}, [draft, messages, pending, tools, flushText]);

	const stop = (): void => {
		cancelRef.current?.cancel();
		cancelRef.current = null;
		flushText();
		setPending(false);
		setStatus('Generation stopped');
		inputRef.current?.focus();
	};

	const onSubmit = useCallback((ev: FormEvent<HTMLFormElement>): void => {
		ev.preventDefault();
		submit();
	}, [submit]);

	const onKeyDown = useCallback((ev: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (ev.key === 'Enter' && !ev.shiftKey && !ev.nativeEvent.isComposing) {
			ev.preventDefault();
			submit();
		}
	}, [submit]);

	return (
		<aside className="chat-pane" aria-label="Board assistant">
			<div className="chat-header"><span className="avatar" aria-hidden="true">A</span><div><strong>Board Assistant</strong><small>Plan, organise, and unblock</small></div></div>
			<div className="chat-log" ref={logRef} role="region" aria-label="Board conversation" tabIndex={0} onScroll={() => {
				const log = logRef.current;
				if (log) { followRef.current = log.scrollHeight - log.clientHeight - log.scrollTop < 48; setFollowing(followRef.current); }
			}}>
				{messages.length === 0 && (
					<div className="chat-empty">
						<h3>A little help moving forward.</h3><p>Ask about progress, find blockers, or organise the work ahead.</p>
						<div className="chat-suggestions">{['Summarise the plan’s progress', 'Which tasks need my attention?', 'What can we work on next?'].map(prompt => <button key={prompt} type="button" onClick={() => { setDraft(prompt); inputRef.current?.focus(); }}>{prompt} <span aria-hidden="true">↗</span></button>)}</div>
					</div>
				)}
				{messages.map((m, i) => (
					<div key={i} className={`chat-bubble chat-${m.role}`}>
						<span className="chat-role">{m.role === 'user' ? 'You' : 'Anton'}</span>
						{m.content || (m.role === 'assistant' && pending ? '…' : '')}
						{m.toolCalls && m.toolCalls.length > 0 && (
							<ul className="chat-tool-calls">
								{m.toolCalls.map((c, j) => (
									<li key={j} className="chat-tool-call">
										<code>{c.name}</code>
										<span className="chat-tool-call-args">{summarizeToolInput(c.input)}</span>
									</li>
								))}
							</ul>
						)}
					</div>
				))}
			</div>
			{!following && <button type="button" className="chat-jump" onClick={() => { followRef.current = true; setFollowing(true); if (logRef.current) { logRef.current.scrollTop = logRef.current.scrollHeight; } }}>↓ Latest Response</button>}
			<div className="chat-status" role="status" aria-live="polite">{status}</div>
			<form className="chat-input" onSubmit={onSubmit}>
				<textarea
					ref={inputRef}
					aria-label="Message the board assistant"
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={onKeyDown}
					placeholder="Ask the board…"
					rows={2}
				/>
				<div className="chat-input-footer"><span>Enter to send · Shift+Enter for a new line</span>
					{pending ? <button key="stop" type="button" className="secondary-button" onClick={event => { event.preventDefault(); stop(); }}>Stop</button> : <button key="send" type="submit" className="primary-button" disabled={!draft.trim()}>Send ↑</button>}
				</div>
			</form>
		</aside>
	);
}

function summarizeToolInput(input: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const [k, v] of Object.entries(input)) {
		const value = typeof v === 'string' ? v : JSON.stringify(v);
		parts.push(`${k}=${value.length > 30 ? value.slice(0, 27) + '…' : value}`);
	}
	return parts.join(' ');
}
