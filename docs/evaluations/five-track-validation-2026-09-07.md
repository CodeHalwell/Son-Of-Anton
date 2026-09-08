# Five-track implementation and validation — 7 September 2026

This pass implements the Council-to-fix workflow, ACP diagnostics and lifecycle improvements, retained editing isolation, performance work, and package verification. It preserves the pre-existing project changes and does not commit, publish, or replace globally installed tools.

## 1. Council findings become reviewable fixes

Board tasks run in detached Git worktrees containing the current dirty workspace snapshot. The specialist is asked to verify the finding, fix it, add regression coverage, and run the relevant compiler/tests. Streaming progress is bounded and throttled; failed, cancelled and interrupted runs retain their changes. Review opens a patch before an explicit application action. Successful application marks the card Done, with a recovery checkpoint retained. Confirmed restoration returns the card to Review. Long findings now have compact collapsed titles and expandable evidence.

The desktop test used only the authorized disposable workspace `/tmp/sota-live-ui-1jup5csv/workspace`. Council report `1c17e41e-a47b-4466-a3ee-416ed98b369f` identified inverted clamp bounds. A real Claude ACP run corrected `clamp.ts` and added four regression tests in isolated proposal `f9ba3678-e404-4118-8015-fb51ba7856d9`.

That run reached its execution deadline while waiting on several native permission dialogs. Its files survived. The retained patch was inspected, the compiler and four tests were independently run successfully, and the patch was applied through the native Review Changes dialog. The compiler and four tests then passed in the original disposable workspace. HEAD and the Git index were unchanged, and the proposal recorded an application recovery checkpoint. The Board restored the completed task after reloading the application. The deadline implementation was subsequently corrected to pause execution time during permission waits and verified by a dedicated protocol test.

Artifacts: `/tmp/sota-five-live-typecheck.log`, `/tmp/sota-five-live-regressions.log`, `/tmp/sota-five-applied-typecheck.log`, `/tmp/sota-five-applied-tests.log`. The retained proposal is under the disposable profile's `User/globalStorage/son-of-anton.son-of-anton/isolated-tasks/` directory.

## 2. ACP diagnostics and lifecycle

`sota acp-doctor` and **Anton: Check ACP Connections** distinguish startup, initialization, session readiness and optional live completion. Probes are bounded, deny tool permissions, redact configured environment secrets and stop owned processes. Session readiness is explicitly separate from authenticated model execution.

The process pool continues to serialize each specialist conversation and bound total processes and queue length. Permission waits now have a separate ten-minute limit; cancellation still resolves unanswered permissions. Isolated runs release their actual prefixed specialist conversation. Windows command shims use `cross-spawn`, and owned process trees have bounded `taskkill` cleanup. Text-only subscription transports fail clearly if asked to execute host tools.

The service registry's three external entries now have pinned package launches: Claude ACP 0.75.1, Codex ACP 1.10.0, and Gemini CLI 0.58.0. The original ten local specialist definitions completed protocol session initialization; this is not a claim that all ten executed a model/tool turn. Local specialist servers retain their CLI model/credential configuration and do not recursively route through external ACP.

Real Claude and Codex adapter probes completed streamed model responses using existing authentication. Claude was also exercised with actual edit, write and command permission dialogs in the desktop workflow. Gemini's existing Google OAuth profile timed out before initialization. The same pinned adapter with an empty disposable profile initialized in under a second and explicitly reported missing API-key authentication at session creation. This narrows the outstanding issue to startup with the existing profile; its exact cause and a successful authenticated Gemini turn remain unverified. No global authentication or provider configuration was changed.

Artifacts: `/tmp/sota-five-configured-acp.json`, `/tmp/sota-five-real-claude-result.json`, `/tmp/sota-five-real-external-result.json`, `/tmp/sota-five-gemini-clean-profile.json`.

## 3. Retained isolation and application safety

Application checks the reviewed patch hash, workspace/HEAD identity and affected file preimages. It retains a checkpoint before writing, does not commit or change the staging area, rejects conflicting user edits, and permits unrelated proposals to apply sequentially. Per-proposal operation claims prevent finish/apply races; workspace application claims exclude concurrent writes while ignoring dead owners. Duplicate task preparation reserves its task ID before asynchronous worktree creation, preventing accidental release of another execution's scope lock.

Six real-Git fixtures cover dirty index/HEAD/untracked preservation, checkpoint restore, conflicts, non-overlapping proposals, cancelled-work recovery, tampered patches and active/dead operation claims. Worktrees and snapshot refs are retained deliberately. This is checkout isolation, not an operating-system sandbox for arbitrary external agents. Reported tests are not automatically certified by the host, and concurrent human edits during the final filesystem write remain outside Git's transaction model.

## 4. Performance and UI

- The Board bundle fell from 1,594,397 bytes to approximately 176 KB by removing unused CopilotKit runtime/context code. The existing host-backed Board assistant remains functional.
- Board columns initially render 50 cards each, with incremental reveal and search across the full task set.
- Chat initially renders the newest 200 history messages, reveals 100 earlier messages at a time, and batches DOM/header updates. Turn indices and checkpoint controls survive paging. Full conversation data still exists in memory; this is bounded rendering rather than complete storage virtualization.
- Council history reads small, validated summary sidecars, loads full details only when selected, and rebuilds stale/missing/corrupt sidecars. Sidecars retain the identity of the exact saved report to avoid attaching an old summary to a replacement file.
- Code-graph watchers coalesce up to 256 changed paths and use per-file indexing for ordinary edits. Deletions, directories, overflow and unsupported paths trigger a full scan. Structural queries remain available during refresh. Aggregate counts are omitted after per-file updates because the native API does not return refreshed totals.

Thirty browser tests exercise the shipped webviews under their content security policy: Chat, Tasks, History, Settings, Roster, Board, Council, provider setup, integrations and auxiliary surfaces. Scale fixtures include 2,000 messages and 2,000 tasks. Native offline graph tests cover querying, edit/rename/delete updates, restart, missing native assets, embedding behavior and workspace isolation. The desktop fixture correctly reports semantic search disabled rather than implying it is configured.

## 5. Packaging and upgrades

SEA packaging now verifies a clean installation, paths with spaces, CJS/ESM argument forwarding, real bundled Claude/Codex launchers, ACP initialization/session creation and executable relocation. Runtime extraction stages on the destination filesystem and patches launchers before publishing the cache. The cache identity changes with executable location/size/mtime. The bundle resolver now selects module entrypoints, fixing a packaged `jsonc-parser` dynamic-require failure.

The bundled Codex pin was raised from 0.130.0 to 0.153.4. The older macOS executable stalled at the dynamic-loader entrypoint even when launched directly; the new pin passed actual launcher and relocation checks. Claude remains pinned at 2.1.138. The resulting macOS arm64 CLI package passed all smoke checks and is approximately 278 MiB.

The Linux x64 package was built and exercised in a clean Node 22 Debian container under x64 emulation. Protocol/isolation fixtures and update rollback tests passed there. The final build uses the same updated vendor pins as macOS, passed every package smoke check, and is approximately 315 MiB.

Updates enforce HTTPS, bounded downloads, checksum verification, same-volume staging, unique retained backups and rollback if replacement fails. Tests cover valid installation, checksum rejection, failed replacement and a locked target. Compatible CLI dependency updates removed the three reported advisories; the final CLI audit reported zero vulnerabilities.

`.github/workflows/verify-sota-packages.yml` adds macOS arm64, Linux x64 and Windows x64 PR/manual package gates. Release CI also runs compiled protocol/isolation and update fixtures before packaging. No workflow was dispatched or release published. Windows native execution and replacement behavior remain pending a Windows runner. The macOS test package has an ad-hoc signature; Developer ID signing and notarization were not performed. These CLI package checks do not constitute installation testing of the complete IDE distribution on all three operating systems.

Artifacts: `/tmp/sota-five-package.log`, `/tmp/sota-five-linux-package.log`, `/tmp/sota-five-linux-package-final.log`, `/tmp/sota-five-cli-dependency-update.log`.

## Validation totals

Compilation passed for core, CLI, extension TypeScript, the required `gulp compile-extensions` task, ACP service and code-graph server/runtime. The relevant suites passed **576 tests**: core 127, extension 383, CLI 22, ACP service 11, browser UI 30, native graph 3. Additional isolated-workspace and long-card checks re-ran affected cases without adding to that unique total. The four live clamp regression tests passed both before and after applying the fix. `git diff --check` passed.

The repository contains extensive earlier changes. These results cover the listed paths and workflows, not an exhaustive verification of every upstream VS Code feature, every provider account or every discovered MCP server.
