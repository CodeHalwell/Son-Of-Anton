# Son of Anton — project improvement review

Reviewed on 6 September 2026 at commit `1dc6348acb53d23a012e93d503f39b1e0c47e3c7`.

The biggest opportunity is to make the central development workflow dependable: open a project, obtain accurate context, let an agent make a useful change, inspect the result, and undo it reliably. The project already contains much of the machinery. Several boundaries between those components still break that workflow, and fixing them would improve the product more substantially than isolated feature additions.

This review covers the Son of Anton extension, shared agent runtime, CLI, Rust code graph, backend services, model routing, persistence, build/release workflows, documentation, and selected sessions/workbench integration. The repository contains 10,720 tracked files; this is a broad review with deeper investigation of important paths, not a line-by-line audit of every inherited VS Code file. UX observations come from implementation review; I did not launch the desktop UI or measure its rendering performance. No application source was changed during the review.

There is useful progress to preserve: the shared core separates host integrations from agent logic; concurrency limits, cancellation, spend guards, MCP trust checks, service authentication, and Rust parsing/storage tests exist. The current commit's [Build workflow passed all eight jobs](https://github.com/CodeHalwell/Son-Of-Anton/actions/runs/32513175205), and [CodeQL passed](https://github.com/CodeHalwell/Son-Of-Anton/actions/runs/33357627062). Earlier reviews describing universally failing CI or absent authentication are no longer an accurate baseline.

**Priority order**

“First” means foundational product correctness or a demonstrated security boundary failure. Effort is relative: S is a bounded change, M spans a component and its integration tests, and L crosses multiple components. These are planning estimates, not delivery commitments.

| Order | Improvement | Priority | Effort | Expected benefit |
|---|---|---|---|---|
| 1 | Make checkpoints restore an actual workspace snapshot | First | M | Users can recover confidently from agent edits |
| 2 | Complete embedded semantic-search initialization | First | M | The central code-intelligence feature works after startup |
| 3 | Remove obsolete graph data when code changes | First | M | Agents stop receiving deleted or renamed symbols |
| 4 | Isolate graph/checkpoint data by workspace and enforce filesystem boundaries | First | M | Prevent project mixing and writes outside the intended workspace |
| 5 | Complete provider tool-call support and unify routing contracts | Next | L | Model selection produces predictable agent behavior |
| 6 | Keep IDE-to-CLI credential sharing in protected storage | Next | M | Preserve the protection users expect from SecretStorage |
| 7 | Test complete user journeys in CI | Next; alongside 1–6 | M | Catch integration failures despite passing unit tests |
| 8 | Make installation, packaging, and first-run setup turnkey | Next | M–L | A new user reaches a useful first result consistently |
| 9 | Measure retrieval and agent task quality | Next | M initially | Prioritize improvements using actual task outcomes |
| 10 | Split large UI/runtime modules behind typed boundaries | Then | L, incremental | Reduce regression risk and speed up development |
| 11 | Improve long-running chat interaction and rendering | Then | M | Keep the interface readable and responsive during work |
| 12 | Account for streaming usage and expose meaningful health | Next | M | Make cost, failures, and latency observable |
| 13 | Reduce operational footprint and ongoing fork maintenance | Then | M | Lower setup cost and make upstream upgrades sustainable |

**1. Make “restore checkpoint” a real undo operation.**

Confirmed by an executable reproduction using the actual compiled `CheckpointManager` in a disposable Git repository. Capture on a clean tree stores `HEAD`; after modifying a tracked file, restore fails with `fatal: '<sha>' is not a stash-like commit`. The changed file remains changed.

The cause is in [captureGit](../son-of-anton-core/src/checkpoint/CheckpointManager.ts#L318), which substitutes a normal HEAD commit when `git stash create` returns nothing, while [restoreGit](../son-of-anton-core/src/checkpoint/CheckpointManager.ts#L393) always runs `git stash apply`. Applying a stash also does not recreate a snapshot over arbitrary subsequent edits. Untracked files are not included in `stash create`, and the persisted record has no repository identity. Stash objects are not retained by a dedicated Git reference, so recording their SHA in application state alone does not protect them from Git garbage collection.

Introduce explicit snapshot types and repository/worktree identity, retain snapshot objects under owned refs, and define the treatment of tracked, staged, untracked, and subsequently created files. Restore should preview the affected paths, preserve a recovery snapshot of the current state, and restore only the intended workspace state. Keep the user's confirmation step.

Acceptance: clean and dirty captures both restore; staged state and untracked-file policy are tested; restoring in a different repository is rejected before mutation; retained checkpoints survive Git GC; a failed restore leaves a usable recovery path.

**2. Finish the embedded graph's initialization and readiness contract.**

Confirmed through a real stdio MCP exchange against the freshly built Rust N-API library and current MCP server. A one-file project indexed successfully, `symbol_lookup` found its function, and the server announced `engine=loaded`. However, `semantic_search` returned `vector index not built; call build_vector_index()` even with a provider embedder configured. The fixture used a dummy loopback endpoint; no model request was made.

[loadEngine](../services/code-graph/mcp-server/src/engine.ts#L103) initializes storage, configures an embedder, and indexes files, but never calls `embedAll` or `buildVectorIndex`. [The native search method requires both an embedder and a vector index](../crates/sota-codegraph-napi/src/lib.rs#L197). The Rust watcher exists, but the N-API/MCP initialization path does not start it.

Build an explicit initialization sequence: load storage, reconcile files, generate missing embeddings, construct/load the vector index, then advertise semantic-search readiness. Expose structural and semantic capabilities separately. A missing native module currently produces placeholder responses, and [the extension recognizes the generic “mcp server ready” log](../extensions/son-of-anton/src/codeGraph/CodeGraphBackend.ts#L402); that should not imply functioning semantic search.

Acceptance: a fresh install with a deterministic embedding fixture returns the expected symbol through MCP; missing credentials/native binaries/embeddings produce distinct actionable states; readiness and restart handling follow the actual serving child rather than an independent probe process.

**3. Make graph updates replace obsolete facts.**

Confirmed against the freshly built Rust CLI. I indexed `old_symbol`, renamed it to `new_symbol`, and reindexed: `old_symbol` was still returned. After deleting the file and reindexing again, `new_symbol` was still returned too.

[bulk_index](../crates/sota-codegraph-core/src/index.rs#L32) and [persist_parsed_file](../crates/sota-codegraph-core/src/index.rs#L135) upsert new facts without reconciling removed symbols and edges. The [symbol identity includes the start byte](../crates/sota-codegraph-core/src/index.rs#L315), so moving a definition can create another row. A full scan also needs to reconcile files that have disappeared.

Treat each changed file as a transaction that replaces its owned symbols/edges, invalidates affected embeddings, and preserves stable identities where appropriate. Reconcile deletions and renames, and ensure search sees a consistent index generation. Preserve the existing parallel parsing and batched writes.

Acceptance: rename, delete, move, edit a docstring/body, remove an import, and switch branches; each subsequent query returns only current facts. Test both startup scans and incremental changes.

**4. Establish workspace isolation and enforce real filesystem boundaries.**

Two distinct issues need attention.

The extension passes [globalStorageUri](../extensions/son-of-anton/src/extension.ts#L1521) into the backend, which always opens [`codegraph.db`](../extensions/son-of-anton/src/codeGraph/CodeGraphBackend.ts#L244). Different projects therefore target the same database within an extension profile. In a disposable reproduction, indexing project B into the same database left project A's symbols queryable. Global checkpoint records likewise need an explicit repository identity before restore.

Separately, the checkpoint service uses [lexical path containment](../services/checkpoints/src/checkpointManager.ts#L39). With a symlink inside a disposable workspace pointing to a sibling fixture directory, the real service class both read and restored a file outside its workspace. This is a demonstrated boundary failure; it does not establish unauthenticated remote exploitation. The indexer's [`/reindex/:path` handler](../services/indexer/src/server.ts#L123) also accepts absolute paths and decoded traversal segments without a project containment check before `indexFile` reads them.

Use a canonical workspace/worktree identifier for graph storage, checkpoint records, caches, and execution context. Enforce containment at the filesystem operation boundary, resolving symlinks and handling nonexistent destinations and symlink races explicitly. A raw `startsWith` check on a normalized string is insufficient. Apply the same reviewed helper/policy across services rather than maintaining different approximations.

Acceptance: two open repositories never share retrieved symbols; changing workspaces cannot redirect a checkpoint restore; absolute, encoded traversal, sibling-prefix, symlink, and nonexistent-parent cases are tested against disposable directories.

**5. Make provider support match the product's agent capabilities.**

The core deliberately enables its agentic tool loop only for Anthropic and Bedrock in [supportsAgenticToolLoop](../son-of-anton-core/src/llm/LlmClient.ts#L365). Other providers fall back to single-shot behavior. That is safer than entering an unsupported loop, but it means many available models cannot perform the same editing workflow. The model metadata describes model capabilities separately from what this runtime can actually execute.

There is also an architectural split: the model-router service has provider adapters and a uniform event contract, but [its live request handler performs direct fetches and forwards raw streaming chunks](../services/model-router/src/server.ts#L208). Incoming tool definitions are not included in the translator call. The service's adapter/event implementation is therefore not the contract governing this path. The core's provider implementation is another separate path.

Choose a shared, host-independent request/event contract and implement provider adapters against it. Complete tool-call/tool-result round trips, cancellation, usage reporting, and consistent error handling. Surface “chat only” versus “can edit with tools” in the picker until each adapter meets that contract. Avoid silently changing the kind of task the user requested.

Acceptance: a deterministic two-step tool interaction passes through each supported provider adapter and both CLI/IDE hosts; cancellation, malformed tool arguments, unavailable credentials, and usage events have common contract tests. Failure after visible output must terminate or explicitly restart an attempt, rather than concatenate a fallback provider's new response into the old stream.

**6. Preserve credential protection when connecting the IDE and CLI.**

[Extension activation](../extensions/son-of-anton/src/extension.ts#L106) automatically mirrors configured provider secrets from VS Code SecretStorage into `~/.son-of-anton/data/secrets.json`. The [mirror writes plaintext JSON](../extensions/son-of-anton/src/auth/cliSecretsMirror.ts#L65), requesting mode `0600`. File permissions help against other users, but the resulting copy no longer has SecretStorage's protection. This finding comes from source inspection; no real credential file was opened during the review.

Prefer a shared OS-protected credential store or an authenticated local broker. Make any plaintext compatibility export an explicit choice with a clear destination and revocation behavior. If a file fallback remains, serialize concurrent changes and write atomically, enforce permissions on existing files, and handle symlink destinations deliberately.

Acceptance: configuring a provider does not silently export its secret to plaintext; CLI access and revocation work; tests use synthetic secrets and cover existing files and concurrent saves.

**7. Extend CI from component checks to product guarantees.**

Current CI is green and includes compilation, hygiene, extension tests, Rust tests, CLI smoke, Docker builds, and a Compose integration job. Preserve that work. The [Compose job](../.github/workflows/build.yml#L310) checks service health/connectivity, but does not index a fixture and retrieve its code. The build workflow does not invoke the core and CLI unit suites, despite those packages now containing 44 and 10 tests respectively. The board has a separate TypeScript configuration excluded from the extension check; I found no invocation of that board check in the workflows.

The extension test suite also depends on the host environment: 350 tests passed and one failed when Codex was on PATH; all 351 passed with an isolated PATH. [The credential-detection test](../extensions/son-of-anton/test/credentialDetection.test.ts#L78) assumes no CLI provider exists without injecting or isolating CLI discovery.

Add a bounded offline product suite: fresh profile → fixture workspace → graph search → tool edit → approval → diff → checkpoint restore → restart → verify persistence. Run it against both embedded and Docker backends where applicable. Inject CLI/process discovery in unit tests. Add the existing core/CLI suites and board type-check to CI.

The gateway's own TypeScript 5.9.3 check exhausted about 4 GB of heap locally, while the root TypeScript 6 preview checked that project successfully. Its [esbuild script](../services/mcp-gateway/build.mjs#L1) already documents the declaration-instantiation problem. Establish a supported, bounded type-check route in CI; successful transpilation should not be treated as equivalent to type safety.

Acceptance: the reproductions in items 1–4 fail CI before their fixes and pass afterward; suites behave identically with and without developer CLIs installed; installed artifacts receive a smoke test outside the source checkout.

**8. Make a fresh installation reach a working first task.**

The [README](../README.md) still instructs users to run Yarn, describes components as separate repositories, and centers the initial setup on a large Compose stack. The current [CLAUDE.md](../CLAUDE.md) describes npm and the consolidated monorepo. The bundled graph's [README](../services/code-graph/README.md) still describes all tools as stubs, while current code has a real native engine. These are materially different onboarding stories.

The embedded backend resolves its server using a source-tree-relative [`services/code-graph/mcp-server/dist/index.js` path](../extensions/son-of-anton/src/codeGraph/CodeGraphBackend.ts#L281). Native loader/binary files are generated and ignored. The root npm bootstrap lists core and CLI but does not establish the graph's complete build/package sequence. The job called [Build Electron Binary](../.github/workflows/build.yml#L358) runs compilation and uploads `out/`; that job alone does not demonstrate a runnable packaged desktop application. The release workflow packages the CLI separately.

Define one supported developer bootstrap and one installed-product startup path. Package the graph server/native assets for each supported platform and test the extracted application away from the repository. Add a diagnostic command that reports toolchain, provider capabilities, graph state, and the next repair action without printing secrets. Include graph setup in the existing onboarding flow, with a clear explanation of local computation versus provider requests.

Acceptance: documented commands work in a clean checkout; an installed app can index and query without a development checkout or manual nested builds; documentation is checked against the supported commands. Use the same declared Node/toolchain policy across development and releases.

**9. Evaluate whether the agents actually solve tasks better.**

Retrieval weights are currently tested using mocked scores, and [semanticSearch](../services/mcp-gateway/src/tools/semanticSearch.ts#L39) acknowledges that graph weighting can only reorder a semantic candidate pool. The embedded implementation also has a different search contract. These details mean additional tuning can look correct in unit tests without improving the code supplied to an agent.

Create a versioned set of representative repository tasks with expected symbols/files, executable acceptance checks, and reviewed reference outcomes. Start with a small useful set covering bug fixes, cross-file changes, test writing, dependency analysis, and negative cases where the correct answer is “not present.” Compare lexical search, vector search, and combined retrieval on the same cases before adding more ranking complexity.

Track retrieval recall/precision at K, stale-result rate, supported-language coverage, completed tasks, unrelated edits, regressions, human interventions, time to first useful action, and cost/tokens per accepted change. Log the selected files and reasons in an inspectable context view. Use opt-in or local evaluation data consistent with the project's privacy policy.

Acceptance: each retrieval or orchestration change includes results on the same evaluation set; larger changes must improve a stated outcome without unacceptable regressions in cost, latency, or edit quality. No performance or quality improvement percentage is claimed by this review; that baseline still needs measurement.

**10. Make the core workflows easier to change safely.**

The largest custom modules currently include `chat-webview.js` (8,742 lines), `ChatPanel.ts` (5,272), `LlmClient.ts` (3,970), `extension.ts` (2,128), `BaseAgent.ts` (1,543), and `OrchestratorAgent.ts` (1,198). Size alone is not a bug, but these files own several independent concerns and are central to many feature changes.

Extract along responsibilities: a typed host/webview message schema; conversation/run state; stream rendering; tool approval and result presentation; provider adapters; and workspace persistence. Keep the shared core independent of VS Code and use thin host adapters. Share service event/auth/metrics contracts through a deliberate package/build arrangement instead of manually synchronized types and vendored generated modules.

Do this incrementally while fixing the corresponding behavior, using boundary tests to hold the public contract steady. Avoid a broad rewrite that postpones the correctness work.

Acceptance: a provider can be added without modifying chat rendering; a transcript component can change without editing provider code; event schemas validate incoming messages; the main task lifecycle is testable without a live IDE or LLM.

**11. Improve the experience of following a long agent task.**

[appendStreamingText](../extensions/son-of-anton/media/chat-webview.js#L4116) appends by replacing the growing text content and forces the transcript to the bottom on every token chunk. It does not check whether the user has scrolled upward. Markdown is rendered only when the stream finishes. These are direct implementation observations; I did not run a frame-time benchmark.

Batch token updates per animation frame, follow the bottom only while the user remains near it, and offer a “jump to latest” control. Introduce safe incremental Markdown rendering and bounded transcript rendering once measured traces justify it. Test keyboard and screen-reader behavior on the actual custom chat, approval, and diff surfaces.

Make each task's state legible in one place: what it is doing, which files it is changing, whether it needs a decision, whether cancellation has completed, and whether the last checkpoint can restore. Show the effective provider/tool capabilities and distinguish disabled, indexing, degraded, and ready graph states.

Acceptance: reading earlier messages during streaming preserves scroll position; keyboard focus survives updates; a long response with tool cards remains responsive under a recorded performance trace; cancellation and reconnect do not leave a task visually stuck as running.

**12. Make streamed work visible in accounting and health.**

The model-router's [streaming branch](../services/model-router/src/server.ts#L234) forwards bytes and returns before the successful request's [usage/cost metrics recording](../services/model-router/src/server.ts#L294). Consequently, successful streamed requests on this service path do not receive the same accounting as non-streamed requests. This does not mean the core's separate spend guard is absent; that guard is wired and has passing tests.

Normalize stream events so usage, cache use, time to first token, completion, cancellation, and errors can be recorded once per attempt and once per task. Track provider switches explicitly. Respect writable-stream backpressure rather than ignoring `res.write`'s return value, and define a recovery policy for failures after output is visible. Add deadlines to outbound requests alongside cancellation.

Health should distinguish a listening socket, a working dependency, a usable graph, and fresh data. Several Compose checks currently establish only that a TCP port is open. Extend the existing metrics/tracing work with task/run identifiers and useful diagnostic views.

Acceptance: streamed and non-streamed fixture requests both produce correct usage records; partial failure and cancellation do not double-count or disappear; slow consumers do not cause unbounded buffering; degraded dependencies are visible without reading container logs.

**13. Reduce operating cost and protect the fork's long-term maintainability.**

There are currently multiple graph lifecycle concepts: the older Docker controller, the embedded backend, separate status surfaces, and legacy Docker detection using ports 7090–7092 that do not match the current Compose configuration. The default embedded embedder is `none`; the Compose embedding default is `mock`. Neither default provides meaningful semantic retrieval. Both need an honest capability state and a guided path to working search.

Make the embedded backend the well-tested baseline when it is ready, and keep optional capabilities in explicit Compose profiles. Consolidate graph lifecycle ownership and use a capability/version handshake to identify backends. Provide a resource estimate and a clear data-retention policy for each optional service. Normal shutdown instructions should preserve data; destructive reset should be a separately documented operation.

For the VS Code fork, maintain an inventory of owned upstream patches with their rationale, tests, and expected upstream disposition. Add a case-collision check to prevent a repeat of the `.Jules`/`.jules` checkout issue. Use a repeatable upstream-update rehearsal and direct performance work toward measured end-to-end bottlenecks. This review did not fetch a current upstream reference or calculate current upstream divergence.

Acceptance: one supported graph lifecycle is visible to the user; default capabilities are accurately reported; optional services are opt-in; a clean checkout succeeds on case-insensitive filesystems; each core patch has a documented reason to remain in the fork.

**Suggested implementation sequence**

Start with checkpoint correctness, graph initialization/freshness, workspace isolation, and filesystem containment. Add their executable reproductions to CI as the fixes land. These establish the reliable edit/review/undo workflow.

Next, complete provider tool-call contracts, protected credential sharing, and the fresh-install/package smoke path. Add streaming accounting and meaningful readiness at the same boundaries so the resulting behavior can be diagnosed.

Then use an evaluation baseline to guide retrieval quality, task orchestration, and latency improvements. Refactor the large modules incrementally as those changes expose clear boundaries. Prioritize the long-task UI issues using measured traces and accessibility checks.

**Validation performed and limits**

| Check | Result |
|---|---|
| Main VS Code `npm run compile-check-ts-native` | Passed |
| Core and CLI builds using their package scripts | Passed |
| Extension TypeScript and separate board TypeScript checks | Passed |
| Core unit tests | 44 passed |
| CLI unit tests | 10 passed |
| Extension unit tests | 351 passed with isolated PATH; normal PATH exposed one environment-dependent credential-discovery test |
| Rust workspace `cargo check/build --locked --workspace --all-features` | Passed |
| Rust workspace `cargo test --locked --workspace --all-features` | 35 passed, 2 explicitly ignored |
| Available service package type-checks | ACP, background tasks, build DAG, checkpoints, context sanitiser, indexer, LSIF, model-router, and penetration-tester passed; gateway's local TypeScript 5.9.3 check exhausted its heap |
| Gateway checked with root TypeScript 6 preview; graph MCP TypeScript | Passed |
| Clean-checkpoint restore reproduction | Confirmed failure with the actual core class in a disposable Git repository |
| Symlink containment reproduction | Confirmed checkpoint service read and restore outside a disposable workspace |
| Rust graph rename/delete/project-switch fixture | Confirmed obsolete and previous-project symbols remain queryable |
| Current MCP server + freshly built N-API smoke | Structural lookup succeeded; semantic search failed because its vector index was not initialized |
| Current commit's GitHub Build and CodeQL | Passed; remote results inspected, not inferred from workflow YAML |

The shell initially used Node 26.8.1. Core/CLI/extension test results above were subsequently verified with the available Node 22.23.2 and an isolated PATH; the repository requests Node 22.22.0. Missing extension development dependencies were restored with `npm ci --ignore-scripts` without changing its lockfile. Rust used the repository's pinned 1.94.1 toolchain. Generated build outputs and dependencies are ignored; the only added tracked-source artifact is this report. The pre-existing untracked `REVIEW_SCRATCHPAD.md` was preserved.

No live LLM requests, production mutations, deployment, or local full Compose run were performed. The packaged desktop application, platform-specific release behavior, external provider compatibility, dependency advisories, and measured UI/agent performance still need their dedicated checks. Findings above distinguish executed reproductions from source-based recommendations rather than treating those unrun checks as successful.
