/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Optional core-side client for the `context-sanitiser` service (CLAUDE.md /
 * `services/context-sanitiser`, port 3302), which strips secrets and
 * prompt-injection markers from content before it re-enters an LLM prompt.
 *
 * Core only defines the *interface*; the host owns the transport (the HTTP call
 * to the configured endpoint) so this package stays free of any endpoint
 * config or `fetch` wiring. When no sanitiser is injected the runtime is a pure
 * no-op — existing behaviour is unchanged — so this is entirely opt-in.
 */

/** One unit of content to scrub before it re-enters an LLM prompt. */
export interface SanitiseRequest {
	/** The raw content to scrub. */
	readonly content: string;
	/**
	 * Whether the content came from a trusted source (the user's own
	 * workspace) or an untrusted one (an external MCP server). Sanitisers
	 * typically scrub untrusted content more aggressively — e.g. neutralising
	 * embedded prompt-injection directives — while still redacting secrets
	 * from trusted content.
	 */
	readonly trusted: boolean;
	/** Optional provenance label for audit/logging (e.g. the originating tool name). */
	readonly source?: string;
}

/**
 * Minimal contract a host can implement against the sanitiser endpoint and
 * inject into the agent stack. Implementations MUST be resilient: on any
 * failure they should return the original content rather than throw, so a
 * sanitiser outage can never break a chat turn.
 */
export interface IContextSanitiser {
	/** Scrub `request.content`, returning the cleaned text. */
	sanitise(request: SanitiseRequest): Promise<string>;
}

/**
 * Whether a tool's output should be treated as untrusted when it re-enters the
 * LLM context. MCP tools are namespaced `mcp__<server>__<tool>` (see
 * `McpToolBridge`) and come from external servers we don't control, so their
 * results are untrusted; first-party built-in tools (`read_file`,
 * `run_command`, `todo_*`, …) operate on the user's own workspace and are
 * trusted. Exported as pure logic so the classification can be unit-tested
 * without driving a full tool loop.
 */
export function isUntrustedToolSource(toolName: string): boolean {
	return toolName.startsWith('mcp__');
}
