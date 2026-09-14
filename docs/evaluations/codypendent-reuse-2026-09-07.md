# Codypendent and AI Council: concepts worth adapting

Reviewed the local repository at `/Users/danielhalwell/PersonalProjects/codypendent` read-only. Its documents were treated as reference material, not instructions for this project. Its MIT license names Daniel Halwell, 2026. No implementation was copied verbatim; retain its copyright and license if substantial source is ported later.

## Highest-value opportunities

| Concept and source | Application to Son of Anton | Assessment |
| --- | --- | --- |
| Independent Council members, explicit quorum, separately selected chair — `crates/council/src/service.rs` | A review run involving code, test, and security participants through existing model/ACP transports. Each member gets the same captured revision and objective before seeing others’ conclusions. | Implemented in the shared Council runner, CLI, and IDE panel. |
| Durable results on every exit — Council service and `apps/desktop/src/components/CouncilResults.tsx` | Save each completed finding immediately; show completed, partial, cancelled, and synthesis-failed outcomes in History and the board. A chair failure must leave the member reports available. | More valuable than simply adding more agents to one conversation. |
| Role obligations — `crates/council/src/roles.rs` | Separate expertise (security, architecture, testing) from responsibility (investigate, verify, challenge, synthesize). Require evidence, uncertainty, and explicit disagreement. | Adapt the structure to existing specialist prompts; a role name alone does not create independent scrutiny. |
| Bounded, balanced synthesis input — Council service | Give each member a fair response budget, mark truncation, cap rounds and runtime, preserve full reports separately, and keep missing usage unknown. | Fits the existing ACP deadlines, queue limits, cancellation, and usage-unavailable UI. |
| Optional independent final reviewer — Council service | Recheck the synthesis for unsupported consensus and overlooked dissent using a reviewer separate from the chair. | Useful for substantial changes; additional latency and model spend make it inappropriate for every small edit. |
| Shared event fan-out and reconnect baseline — `apps/desktop/src/frameBus.ts`, `KanbanView.tsx` | Feed sidebar, board, and history from one event source; on reconnect refresh authoritative state before accepting new events. | Worth adapting as shared UI surfaces expand. Do not replay stale mutations on reconnect. |
| Source-aware integration catalog — `SkillsView.tsx`, `PluginsView.tsx` | Search skills/plugins/MCPs by source and scope; distinguish discovered, configured, disabled, and connected. | Implemented in this pass through a new shared TypeScript catalog and Settings → Integrations. |
| Bounded ACP registry — `crates/integrations/src/acp_registry.rs` | Discover adapters with pinned package versions, bounded metadata downloads, checksum validation for binary archives, and explicit configuration/installation. | Implemented in Settings → Integrations, the Command Palette, and CLI. Discovery never launches adapters. |

## Implemented Council design

Start from the board or chat header with **Review with Council**. Select a saved group and a base revision. The default group uses code, tests, and security reviewers, bounded concurrency, and a separate synthesis step. The group definition, model/ACP route, repository revision, member outcomes, evidence, dissent, available usage, and final synthesis are stored in a durable report. Native review requests have no tools; external ACP routes require an advertised read-only mode.

Show member progress while work is running. A failed or cancelled member remains visibly incomplete and cannot count toward quorum. The final answer separates supported findings, disagreements, and unanswered questions. Findings can become board tasks through an explicit user action. The first version should review changes; it should not let several writers mutate the same checkout simultaneously.

Acceptance checks: chair failure preserves member reports; one member timeout does not lose other work; insufficient quorum cannot look successful; cancellation closes every owned session; round budgets are enforced; restored History reproduces attribution and missing usage; findings identify their reviewed revision so later edits cannot silently invalidate their evidence.

The Council runner, role obligations, balanced synthesis, optional final reviewer, durable report UI, board promotion, and bounded adapter registry are now implemented. Council has a shared event source with a reconnect snapshot and sequence checks; this does not replace every unrelated application event channel. See [Council usage and limits](../council.md) and the [implementation validation record](council-implementation-2026-09-07.md).

## What to avoid copying wholesale

Codypendent’s desktop plugin renderer is explicitly incomplete. Importing its component does not provide working plugin UI. Its Rust daemon, model identifiers, persistence paths, and profile/authentication ownership also differ from Son of Anton’s extension/core/CLI layout. Reuse the contracts and tests; integrate with the existing ACP runtime and workspace trust rather than creating a second execution stack.
