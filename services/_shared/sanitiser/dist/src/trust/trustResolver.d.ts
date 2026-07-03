import type { ContextSource, TrustLevel } from '../types';
/**
 * Resolves the trust level for a given context source.
 *
 * Trust levels determine how aggressively content is sanitised:
 * - trusted: no sanitisation (system prompts, CLAUDE.md)
 * - high: light sanitisation (project source code)
 * - medium: full sanitisation (docs, MCP, extension context)
 * - low: heavy sanitisation (dependencies)
 * - untrusted: full sanitisation + always warn (external content)
 */
export declare function resolveTrustLevel(source: ContextSource): TrustLevel;
/** Check if a trust level meets the minimum required level. */
export declare function meetsTrustLevel(level: TrustLevel, minimum: TrustLevel): boolean;
/**
 * Check whether a detection pattern applies to content at the given trust level.
 *
 * A pattern's `minTrustLevel` is the *most-trusted* level at which it still
 * fires: it triggers for content at that trust level or lower (less trusted).
 * Less-trusted content is therefore scanned by more patterns, while fully
 * trusted content is handled separately and bypasses all patterns. For example
 * a `medium` pattern fires for `medium`, `low`, and `untrusted` content, but not
 * for `high` source code.
 */
export declare function appliesAtTrustLevel(contentTrust: TrustLevel, patternMinTrust: TrustLevel): boolean;
