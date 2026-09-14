# Council and ACP registry implementation validation

Implemented the Council and bounded adapter-registry concepts identified in the [Codypendent reuse assessment](codypendent-reuse-2026-09-07.md), using Son of Anton's existing TypeScript core, ACP runtime, model client, trust gate, conversation store, and task board. No Codypendent source was copied verbatim. Its incomplete desktop plugin renderer and separate Rust daemon were not ported.

## Delivered behavior

- Independent first-round code/test/security participants, explicit quorum, bounded parallelism and rounds, a distinct chair, and optional final reviewer.
- Responsibility prompts, balanced synthesis context, structured findings, visible uncertainty/dissent, and no invented zero usage or billing.
- Atomic saved reports, partial response checkpoints, cancellation/deadlines, separate failure outcomes, exited-owner recovery, and errors retained for late observers after a persistence failure.
- Council UI in the chat header, sidebar History, task board, and Command Palette; evidence navigation, Markdown export, separate finding boards, restored board state, responsive layouts, saved setup drafts, and webview restoration.
- One Council event source with authoritative reconnect state and stale-sequence rejection. Only selected report details are sent with History snapshots.
- Native review requests with no tools, explicit ACP read-only mode negotiation, mode-change cancellation, and a dedicated `sota acp --read-only` server that never constructs the mutable agent/MCP/memory stack.
- Official ACP registry browsing and explicit configuration in the IDE and CLI. Exact package versions; checksum-required binary downloads; bounded HTTPS, TAR, and ZIP handling; no execution during discovery.

## Automated validation

Compilation passed before tests: core, CLI, ACP service, extension TypeScript, `gulp compile-extensions`, and the packaged extension/board bundle.

| Suite | Passing tests |
| --- | ---: |
| Core, including Council engine, ACP negotiation, read-only mode departure, and registry/archive fixtures | 116 |
| CLI, including the dedicated read-only ACP server | 18 |
| Extension regressions | 383 |
| ACP HTTP service and registry facade | 11 |
| Shipped webview browser interactions | 27 |
| **Total distinct tests in these suites** | **555** |

The three Council browser tests were also rerun after final UI changes. They exercise submit/cancel, streamed partial text, evidence/export/promotion messages, focus retention, narrow panes, error recovery, setup draft state, lazy report-detail loading, and stale events under the shipped content-security policy. The full suite also covers the existing chat tabs, integration controls, board, dashboard, trace, impact, and setup surfaces. These browser tests use offline host fixtures; native validation below covers real model traffic.

ACP generated-runtime synchronization and `git diff --check` passed. Binary archive tests use disposable inert fixtures, including valid TAR/ZIP, traversal, links, checksum mismatch, and missing checksum cases. No registry adapter was executed by those tests.

## Native app verification

Used only the previously authorized disposable workspace `/tmp/sota-live-ui-1jup5csv/workspace` and its isolated IDE profile. Created a Git baseline in that disposable folder, then intentionally inverted the clamp bounds in `clamp.ts`. The real project index, refs, and stash were not changed.

A live review ran three members, chair, and final reviewer through separate ACP sessions using the local Son of Anton read-only adapter and an already configured Claude subscription route. All five stages completed in approximately 147 seconds and retained unavailable usage honestly. The independent members identified the deliberately introduced clamp regression.

The native panel rendered streamed and structured responses, file references, questions, and stage status. Export opened the Markdown report. Evidence navigation selected line 2. The chair's finding was promoted into its own one-card board without executing that card. After reload, sidebar Council History restored all five stage results and the task board restored the promoted card. A subsequent reload automatically restored the Council panel, an unfinished objective draft, and the final-review checkbox. The live review report is `1c17e41e-a47b-4466-a3ee-416ed98b369f` in the disposable profile's `council-reports` directory.

The live exercise exposed two UI issues that were fixed: internal agent instructions obscured board finding titles, and canonical `/private/tmp` evidence paths could open a duplicate editor for an existing `/tmp` workspace file. Findings now lead with their title; evidence retains the workspace's display path while enforcing canonical containment.

The official registry metadata parsed 39 adapters. Concrete pinned package plans were verified for `claude-acp` (`@agentclientprotocol/claude-agent-acp@0.75.1`) and `codex-acp` (`@agentclientprotocol/codex-acp@1.10.0`). Native discovery displayed those adapters and the Claude configuration dialog displayed the exact pinned command; configuration was cancelled without installing or launching it. This validated discovery and planning, not every adapter's authentication or runtime compatibility. The owned test app was closed after verification.

## Practical limits

This is a bounded review of tracked changes, not an exhaustive repository analysis or test execution. The live final reviewer overstated how many participants were independent and inferred a coverage concern from the absence of test changes. Prompts were tightened to distinguish first-round independence from synthesis and to put unverified coverage concerns in unanswered questions. Model findings still need human or specialist verification; structured validation checks scope and shape, not mathematical truth.

External ACP read-only modes depend on adapter behavior and are not an OS sandbox. Registry package pins do not lock transitive dependencies; SHA-256 verification applies to binary archives. Third-party plugin hooks/UIs and source-app-owned authentication are not automatically transferred. Windows adapter launching was not exercised on this macOS host. Live finding execution was not exercised in this pass; promotion/restoration and the existing specialist dispatch path were checked separately.

See [Council configuration and limits](../council.md) and [system integration behavior](../system-integrations.md).
