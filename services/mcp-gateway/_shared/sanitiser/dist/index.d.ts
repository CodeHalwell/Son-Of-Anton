/**
 * Shared prompt-injection sanitiser core.
 *
 * Canonical home of the sanitisation engine used by:
 *  - `services/context-sanitiser` — the HTTP service + background workspace scanner
 *  - `services/mcp-gateway` — inline sanitisation of model-bound tool results (F-4)
 *
 * Consuming services vendor the compiled `dist/` (same pattern as
 * `services/_shared/auth`); this package has no runtime dependencies.
 */
export { ContextSanitiser } from './src/sanitiser';
export { INJECTION_PATTERNS } from './src/patterns/injectionPatterns';
export { resolveTrustLevel, meetsTrustLevel, appliesAtTrustLevel } from './src/trust/trustResolver';
export type { ContextSource, ContextSourceType, TrustLevel, SanitisationResult, Warning, McpToolReview, McpToolReviewEntry, WorkspaceScanResult, WorkspaceFinding, DetectionPattern, } from './src/types';
