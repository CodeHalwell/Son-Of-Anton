import type { ContextSource, SanitisationResult, McpToolReview } from './types';
/**
 * Context sanitiser for prompt injection defence.
 *
 * Scans content for known injection patterns, applies trust-level-based
 * sanitisation rules, and provides warnings for suspicious content.
 *
 * Design principles:
 * - Never silently strip content; always generate visible warnings
 * - Trust level determines which patterns trigger
 * - System prompts and user messages bypass sanitisation
 * - Suspicious content is excluded but can be overridden by the developer
 */
export declare class ContextSanitiser {
    /**
     * Sanitise content from a given source.
     *
     * @param input - The raw content to sanitise
     * @param source - Metadata about where the content came from
     * @returns Sanitisation result with cleaned content and warnings
     */
    sanitise(input: string, source: ContextSource): SanitisationResult;
    /**
     * Review MCP tool descriptions for suspicious content.
     *
     * When a new MCP server is connected, its tool descriptions should
     * be reviewed before they are included in the agent's context.
     */
    reviewMcpTools(serverName: string, tools: Array<{
        name: string;
        description: string;
    }>): McpToolReview;
    /**
     * Generate the security instruction to include in the orchestrator's
     * system prompt (instruction 06).
     */
    static getSecurityPromptAddition(): string;
}
