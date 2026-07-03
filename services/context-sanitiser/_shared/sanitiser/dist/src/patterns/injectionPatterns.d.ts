import type { DetectionPattern } from '../types';
/**
 * Known prompt injection patterns.
 *
 * These patterns detect common prompt injection techniques used to
 * hijack LLM behaviour via file contents, MCP tool descriptions,
 * error messages, and other context sources.
 *
 * Patterns are ordered roughly by severity. Each pattern specifies
 * the minimum trust level at which it triggers — trusted content
 * bypasses all patterns, untrusted content triggers all of them.
 */
export declare const INJECTION_PATTERNS: DetectionPattern[];
