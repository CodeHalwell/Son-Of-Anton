# Production fixes integrated with current main — 15 September 2026

This integration starts at `9f2e87a9d8cf777a1117211ec386650de596f1b9` and selectively incorporates the useful changes from closed PR #264 (`0565c2c3f4652107991d98fc23f4458f929b1ea4`). The merge resolves conflicts in favor of current behavior and adapts the selected fixes. September 14 reports remain historical evidence for their original candidate; they do not certify this merged candidate.

## Changes

- Native graph operations run in a bounded child worker, with responsive status, controlled shutdown, provider deadlines and concurrency limits, response-size limits, and model-cache isolation. Current unsaved-editor overlays and bounded detailed dependency-impact paths are preserved and adapted to async engine calls. Literal symbol queries escape SQL wildcard characters.
- Hybrid ranking now unwraps the aliased `entry` column returned by the actual FalkorDB decoder. Its regression test demonstrates structural degree changing the final ordering.
- Legacy optional-service checkpoints without a workspace identity validate all paths and hashes before binding to the canonical configured workspace. Invalid snapshots do not migrate or write files; later cross-workspace restores remain rejected. The editor’s newer durable checkpoint journal, recovery pinning and conversation rewind implementation are preserved.
- Optional services fail closed without configured authentication, use private generated credentials, share checked Cypher serialization, and retain PostgreSQL data with a separate restricted reader. Visual baseline writes and service/MCP registration are corrected. Newer ACP and provider routing are preserved. HTTP fixtures now authenticate explicitly, and the endpoint ranking test uses a controlled clock.
- IDE and CLI packaging stage complete candidates before replacing prior outputs. CLI vendor selection verifies target executables and Node archives. Current stable-channel signing, final-DMG notarization and release publication gates are preserved. Installed runtime diagnostics verify the worker asset.
- The direct Codex text runner uses exec JSONL events, reports incomplete/failed output, and handles cancellation without a successful completion. Current discovered-model catalog behavior and ACP host-tool routing remain in place.
- CI includes these regressions and native package checks. Model downloads and the longer graph soak remain opt-in.

## Validation of this candidate

All changed TypeScript packages compile, the extension build passes, the native graph runtime builds, shared vendored modules match their canonical sources, workflow/Compose YAML parses, and `git diff --check` passes. Builds used Node 22 and the installed macOS Command Line Tools (`DEVELOPER_DIR=/Library/Developer/CommandLineTools`); the full Xcode installation has an unaccepted license and was not modified.

| Suite | Result |
| --- | --- |
| Core, including Codex runner and durable checkpoint tests | 409 passed |
| Extension, including all durable conversation rewind tests | 685 passed |
| CLI | 32 passed |
| Native Rust graph | 40 passed, 2 ignored |
| Installed graph, including capacity, overlays, worker lifecycle and provider recovery | 27 passed, 2 opt-in tests skipped |
| Gateway, including aliased structural ranking | 45 passed |
| Legacy checkpoint service | 10 passed |
| Model router | 209 passed |
| Background tasks / indexer / LSIF | 13 / 16 / 8 passed |
| Visual regression / walkthrough / HTTP sanitizer | 16 / 15 / 1 passed |
| Canonical shared auth and workspace boundaries | 9 passed |
| Database MCP discovery, schema validation and authentication | 1 passed |
| Packaging, release policy, staging, service configuration and Cypher | 57 passed, 1 Docker test skipped in the combined run |
| Disposable PostgreSQL authentication and restricted-reader enforcement | Passed |

Early runs exposed stale compiled Codex tests, missing fixture credentials, async overlay fixture assumptions, staged signing-path assertions and a timer-sensitive endpoint test. Those issues were corrected; the full affected suites above were rerun successfully. The extension’s early timeout failures did not reproduce after rebuilding and rerunning with the working toolchain.

## Remaining release evidence

The disposable FalkorDB outage test was attempted twice but Docker did not start its container within the 15-second fixture deadline (exit 143). It therefore did not reach its outage assertions on this candidate; the local gateway and native provider-recovery suites passed. CI must supply the missing Docker outage/full-stack evidence. The PostgreSQL container test did complete successfully.

This task did not rebuild and exercise final signed installers on Windows and Linux, repeat the full desktop user walkthrough, download a real embedding model, or run the five-minute graph soak. Those release gates remain outstanding. This document is an integration report, not a production-release approval.

## PR #265 review follow-up

The first CI run passed the core/harness, typecheck, Rust, Linux/macOS IDE and all three CLI package jobs. Windows graph checks failed on test path assumptions: synchronous and asynchronous Windows realpath can use different short/long names, and native paths can have a UNC prefix. The fixtures now compare the same canonical representation as the overlay and use `path.isAbsolute` for search hits.

All three inline review findings are addressed: the shared Cypher package explicitly declares CommonJS and its four generated artifacts are regenerated; Codex cancellation, consumer closure and deadline expiry escalate SIGTERM to SIGKILL after one second and reap the process; graph startup failure disposes and clears its engine while retaining failure diagnostics. Tests exercise CommonJS parsing without Node’s ESM auto-detection, an actual failed worker process, and child processes that ignore SIGTERM.

The Docker integration job stopped at an unhealthy deployment service, but its log collection omitted the `services` profile and captured no service output. Log collection and the stack fixture now select that profile explicitly. The unchanged deployment image was built locally, started with a fixture token, and passed repeated container health checks without GitHub requests. Its CI-only startup failure was not reproduced; the next CI run remains authoritative.

Follow-up local validation: core/graph TypeScript builds, native runtime bundle, shared-artifact consistency, 29 installed graph tests (two opt-in skips), 45 gateway tests, and the targeted Cypher/overlay/lifecycle tests pass. Windows native rerun and full Docker CI results are pending at the time of this update.
