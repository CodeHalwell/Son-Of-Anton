# IDE distribution and proposal validation

This continues the five-track evaluation with complete desktop installers, host-run proposal validation, native file review and a larger workflow exercise. The original working tree and index were preserved; the release snapshot is on `codex/ide-distribution` in an isolated worktree.

## Distribution

The GitHub Actions workflow builds the complete IDE on native macOS arm64, macOS x64, Linux x64 and Windows x64 runners. It packages DMG/ZIP, DEB/TAR and per-user setup/ZIP downloads, respectively. The bundled Son of Anton extension includes prompts, chat/board assets and the native graph runtime.

Installation checks verify asset hashes, source identity, architecture, a fresh profile, bundled extension activation and an actual graph query through packaged Electron. Linux additionally installs and reinstalls the DEB using apt, validates desktop integration and removes it. Windows exercises silent per-user installation, reinstallation and uninstall. Credential-free fixtures use in-memory secret storage and leave workspace trust disabled.

Release staging requires all eight expected installers, matching source commits and versions, passing reports for the correct platform, and matching hashes and sizes. Six tests cover valid staging, stale output, mixed commits, failed/wrong-platform reports, missing assets and modified bytes. GitHub attaches build provenance and creates a draft prerelease. Existing downloads/tags are not overwritten. Production signing is optional and can be required by workflow input; no production signing credentials were supplied in this evaluation. IDE updates are manual installer updates, not an automatic update service.

The first real CI run exposed Windows ACP stdio/exit ordering, an Intel macOS ONNX binary support regression and a Linux glibc incompatibility. ACP initialization now retains the underlying process error when a Windows command shim closes its stream first. FastEmbed is pinned to 5.3.1 / ORT rc.10, whose binary set includes all four targets. The pinned runtime builds and passes native indexing tests locally.

## Proposals and host validation

Proposal review opens native side-by-side diffs, supports file selection, retains applied-file state and restores the most recent application without replacing unrelated edits. The retained patch and regenerated snapshot must both match the proposal digest.

Approved npm commands execute in a detached candidate workspace built from the current dirty workspace and selected proposal files. Evidence records the exact baseline, candidate, selection, commands, exit codes, durations and bounded logs. Package/lockfile changes invalidate approved commands. Source changes made by validation mark evidence stale. Applying with validation evidence requires a passing, matching, current result. Timeout, cancellation and interrupted ownership are represented explicitly. Unvalidated application remains a separate explicit user action.

The 1,002-source-file fixture covers independent multi-file proposals, competing changes, cancelled work surviving restart, host build/test execution and restoration preserving unrelated user edits. Its optional real Claude ACP turn completed in 45.69 seconds, emitted 42 text chunks, requested two permissions, changed only `test/live-clamp.test.js`, and passed independent host validation. Controller peak RSS was 63,258,624 bytes; this excludes agent and IDE processes.

## Local validation

- Core TypeScript, extension TypeScript, the required extension gulp compilation, main workbench TypeScript and native graph compilation passed.
- All 134 core tests and 384 extension tests passed.
- All 31 browser webview tests passed, covering sidebar Chat/Tasks/History/Settings/Roster, Board, Council, setup, integrations and proposal review.
- Six release-integrity tests and three native graph lifecycle/retrieval tests passed.
- The complete Mac IDE was built, packaged as a DMG, installed in a fresh temporary directory and activated successfully. The installed native graph answered the fixture symbol query. Test applications and debugger processes are cleaned up after inspection.

The first-launch review found and corrected a conflicting personality-frequency setting and a misleading graph startup spinner in Restricted Mode. Graph activation now waits for workspace trust and explains that state. The empty secondary sidebar is hidden by the workbench default on new profiles.

Provider credentials are not bundled or exercised by offline installation tests. Gemini's Google sign-in remains a manual prerequisite for the live-provider test; the diagnostic explains how to complete it without placing authorization codes into an ACP conversation. This evaluation does not claim exhaustive testing of every upstream VS Code feature, installed third-party MCP server or provider account.

Native release run results and download links are recorded after the Actions build completes.
