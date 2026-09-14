# Production readiness verification — 14 September 2026

Status: work in progress. This document records verified behavior and remaining release work; it is not a production approval. The workspace contains substantial existing uncommitted development, so earlier CI results and older installers do not certify its current contents.

Latest successful native candidate: [provider recovery and sustained-run verification](2026-09-14-provider-recovery-verification.json). Earlier sections below retain their original candidate measurements as history.

## Verified desktop behavior

The [real-user acceptance report](2026-09-14-real-user-acceptance.md) records the macOS walkthrough and subsequent retest. Live Claude/Codex requests, code editing and independent test execution, task execution/retry, Council review/export, cancellation/recovery, checkpoint comparison/restore, and persistence were exercised. That iteration passed 653 automated tests across core, extension, UI, CLI, and embedded graph packages.

## Service fixes and evidence

- HTTP authentication fails closed when its configured token is missing. A real loopback HTTP server rejects both absent and attacker-supplied tokens; health checks remain available. Canonical auth/workspace tests: 9 passing.
- New service configuration uses six independently generated secrets, private file permissions, and exclusive creation. It refuses to replace an existing file or symlink. Compose rejects blank credentials; configuration tests cover authentication, loopback bindings, persistent database storage, and service network connectivity.
- Fresh PostgreSQL installations create a separate administrator and restricted reader. A disposable PostgreSQL 16 container verifies reader authentication and access to future tables, rejects writes and server-file reads, and rejects incorrect TCP passwords. Explicit SCRAM initialization prevents PostgreSQL's local host trust default. Existing volumes require deliberate migration; changing environment variables does not rotate database roles.
- Gateway and database MCP registration uses the SDK's current schema API. Gateway TypeScript checking now completes without suppression of excessive type-instantiation errors. Its release/container build checks types. An actual MCP client discovers all 17 tools and invalid arguments never reach the database.
- Database and visual-regression containers now use lockfiles and checked builds. Gateway, database, and visual-regression images built successfully locally. The full optional-service stack built successfully and all 19 containers reached healthy status. Live authenticated HTTP and MCP checks pass against the isolated JavaScript fixture.
- Visual regression testing now preserves a good baseline when an upload is invalid, allows approval after image dimensions change, rejects colliding/unsafe names and symlink destinations, bounds image/request size, and reports missing/different-size comparisons without claiming success. Tests exercise actual PNG files and an authenticated HTTP server, including recovery after malformed requests.
- Background tasks and the MCP gateway now share a Docker network. CI generates private credentials and includes the PostgreSQL role test and additional image builds.

- Live indexing initially skipped JavaScript/TSX because Compose overrode the working defaults. Corrected configuration now loads those grammars. A further live failure revealed invalid JSON map syntax in Cypher parameters; a shared checked serializer now supports nested map/list data, rejects invalid parameter identifiers, and preserves string escaping. The gateway retrieves `cartTotal` with its correct source location from the actual indexed `cart.js`. Typed response decoding now preserves columns, numeric/boolean values, lists, and maps; live memory record/query checks verify an array-valued topic survives the round trip.
- Regression infrastructure now authenticates HTTP fixtures, cleans stale sanitizer test output, and runs the walkthrough tests that its previous path missed. Model-router: 209 passing; walkthrough: 15 passing; canonical sanitizer: 26 passing. The HTTP service's separate vendored sanitizer smoke test passes.
- The durable service-stack test verifies all 19 containers, protected HTTP endpoints, an injection fixture, gateway and database MCP tool discovery/execution, a database file-access denial, and background-task network connectivity. CI uses a small JavaScript fixture to make this repeatable.

## Remaining acceptance gates

1. Extend optional-service checks beyond the passing fixtures to sustained load, larger retrieval corpora, and the remaining adapters. Gateway cold start, graph restart, silent-connection timeouts and recovery now pass; these do not establish recovery for every service.
2. Finish coverage of remaining external service adapters and failure/recovery cases. Gateway and background-task commands now include their previously omitted TypeScript tests; gateway 44 and background tasks 13 pass.
3. Complete distribution signing/notarization. The fresh September 14 macOS arm64 DMG now passes clean installation, bundled activation, and native graph checks. Only a local development signing identity was found; the resulting candidate is ad-hoc signed. Repository signing-secret configuration could not be inspected because GitHub returned 403 for secret-name listing.
4. Run the current source through Windows/Linux native installation jobs and the upstream compatibility lane. Remote CI successes on other commits are not evidence for this dirty workspace.
5. Verify release staging, signature/checksum/update/recovery behavior with the exact candidate artifacts. Publishing is a separate action.
6. Broaden the passing real local-model retrieval fixture to representative repositories and configured external embedding providers/integrations. The six-query fixture establishes a baseline, not general retrieval quality.
7. Complete long-duration and concurrency checks, resource-limit behavior, and remaining safety-path review. Unit tests alone are insufficient evidence for these gates.

## Reproduction evidence

Local logs use `/tmp/sota-production-*.log`. They are working evidence, not a durable release record. The isolated Compose project is named `sota-production-qa`, uses ephemeral localhost ports and a disposable fixture, and was torn down successfully after testing, including its disposable volumes and generated service images. It does not replace the user's normal service configuration.

## Latest service regression totals

| Package | Passing tests |
|---|---:|
| model-router | 209 |
| checkpoints | 8 |
| acp-client | 11 |
| build-dag | 6 |
| context-sanitiser | 1 |
| walkthrough | 15 |
| background-tasks | 13 |
| spec-pipeline | 22 |
| lsif | 8 |
| indexer | 16 |
| penetration-tester | 30 |
| mcp-gateway | 44 |
| visual-regression | 16 |

These counts exclude the separate canonical auth (9), canonical sanitizer (26), service configuration (3), Cypher encoding/decoding (3), live PostgreSQL role (1), and live 19-container stack (1) checks. All passed. Existing TypeScript tests omitted by other legacy package commands remain part of the coverage audit; these counts do not imply exhaustive coverage.

## Fresh macOS candidate

The September 14 optimized macOS arm64 build passed core, CLI, graph, extension, root-source, and build-tool TypeScript checks. Release-staging tests passed (6), as did the selected native safety/update tests (48). The DMG was mounted read-only and installed into a clean temporary directory. The verifier loaded the packaged extension, registered its five required commands, and ran the bundled native graph. Activation took 323 ms in that fixture. Temporary installation state was removed.

Artifacts: `.build/ide-release/darwin-arm64/manifest.json`, `installation-report.json`, and `son-of-anton-1.112.0-darwin-arm64.{dmg,zip}`. The manifest records sizes and SHA-256 hashes. This is a locally tested candidate from an uncommitted workspace, not a signed public release.

A subsequent packaged UI walkthrough verified live Codex CLI execution (`PACKAGED_OK`) and caught cross-conversation usage leakage in the legacy counters. Completion messages now use the same per-turn deltas as persisted metrics; new-chat resets the visible token/cost labels. The extension suite now passes 438 tests and the webview suite 43. The final service regression total is 397 after restoring omitted gateway and background-task tests. The subsequent native rebuild and clean DMG installation passed after this correction (384 ms activation in that fixture).


## JavaScript debugger packaging correction

The fresh packaged application showed “All debug extensions are disabled” when running a JavaScript file: `product.json` had removed every downloaded built-in extension. The candidate now bundles the MIT-licensed JavaScript debugger 1.112.0 and its companion 1.1.3, matching the [upstream VS Code 1.112.0 product manifest](https://github.com/microsoft/vscode/blob/1.112.0/product.json). Downloads use the existing official GitHub release path and pinned SHA-256 verification; the debugger release digest also matches the official GitHub asset digest. Licenses and third-party notices remain in each extension. The install verifier now checks both packages, pinned versions, entry points and notices, then activates the JavaScript debugger and verifies its Node adapter contribution. The rebuilt DMG passed clean-install verification (469 ms for the combined activation/graph fixture). In the packaged application, F5 launched Node.js, paused in `cartTotal` on line 2, exposed both empty and populated item arrays, evaluated the populated total as 44, stepped to return value 44, and continued to normal termination. A second run verified explicit Stop. The temporary fixture uses the macOS `/tmp` symlink, so the debugger correctly warned about canonical source paths; the breakpoint still fired. A live Codex turn returned `DEBUGGER_BUILD_OK`, its 16,247-token usage cleared to zero on New Chat, and Council initialized with saved review history.


## Gateway datastore recovery correction

A real FalkorDB stop exposed an uncaught socket exception that could terminate the gateway. The client now handles connection errors, rejects requests while disconnected instead of retaining them in an offline queue, bounds pending commands, and reconnects with backoff. Gateway HTTP startup runs independently of the database connection, so a cold start with unavailable datastores returns authenticated-path denials and HTTP 503 degraded health promptly.

Server-side Cypher timeouts do not cover a silent network connection. Graph requests now have transport deadlines and discard pending work before reconnecting; writes are never automatically replayed and a timed-out operation's completion is explicitly unknown. Qdrant requests now use a two-second client timeout instead of the SDK's five-minute default. A real paused graph container and a silent HTTP vector server verify bounded failures. The graph test then resumes the same datastore and verifies 50 concurrent parameterized queries return their corresponding values.

The opt-in Docker graph outage/recovery test passes in 6.5 seconds and cleans its own container. Gateway tests now pass 44 checks, including cold start and silent vector responses. The latest package-by-package service total is 399; unchanged service suites retain their earlier passing evidence. CI now runs the graph outage test after compiling the gateway. Workflow YAML parsing and targeted whitespace checks pass. Logs: `/tmp/sota-production-gateway-recovery-{before,after,build,suite}.log`. The initial pre-fix test recorded `uncaughtException: Socket closed unexpectedly`.


## Release artifact replacement and update discovery

IDE packaging now builds in a fresh sibling staging directory and replaces the previous release only after every installer and checksum is complete. This prevents the Windows `7z a` operation from retaining removed files from an older ZIP, and keeps a failed build from mixing partial artifacts with the last successful manifest. Replacement failures roll back; if rollback also fails, the old release is retained at an explicit recovery path. Four filesystem tests cover clean replacement, failed generation, failed replacement, and failed rollback; the six existing release-staging checks also pass.

The actual macOS ZIP/DMG was repackaged with the staging workflow and again passed clean installation, debugger activation and the native graph query. The combined fixture completed in 565 ms. No staging directory remained after success. This rebuild replaces the prior installation report, so the report and manifest describe the newly packaged bytes.

Standalone CLI update discovery now paginates past IDE-only release pages and selects the highest stable semantic version. Network failures or an incomplete bounded catalog do not report an older candidate as latest. Standalone startup now checks GitHub Releases rather than npm, and update-cache entries distinguish installation modes. All 26 CLI tests pass after compilation; four new tests cover pagination/version selection, later-page failure, bounded catalog exhaustion and a standalone startup with an npm cache. The CLI packaging file-operation suite also passes.

Native installer PR coverage now includes the packaging helper, tests, source, runtime and resource paths that previously missed the path filter. CLI release jobs validate that the release tag matches the embedded package version, set the release target commit explicitly, and install the Linux native dependencies needed by root `npm ci`. Both release workflows parse as valid YAML. These local checks do not claim a remote signed release or certify Windows/Linux installation.

The release audit also found that CLI signing assumed a pre-imported macOS identity and attempted to staple a raw executable. Both paths are corrected below. Actual Developer ID/notarization and Windows signing credentials remain unavailable locally.


## CLI signing workflow correction

macOS CLI signing now validates complete configuration before operating, signs with hardened runtime and the Node JIT entitlement, verifies the signature, requires an accepted notarization result, and checks the notarized code requirement. It no longer calls `stapler` on a raw executable; this format is unsupported by the installed `stapler` tool and [Apple's documented workflow](https://developer.apple.com/videos/play/wwdc2019/703/). Temporary archives are removed on both success and failure. A copied CLI executable was locally ad-hoc signed with hardened runtime and the new entitlement; strict signature verification and `--version` succeeded. This is runtime compatibility evidence, not Developer ID or Gatekeeper distribution approval.

The release workflow now imports the P12 certificate into a temporary keychain with the commit-pinned import action (v7.0.0), removes decoded credential files, and requires production signing for tag-triggered releases. Manual dry runs retain the explicit option to produce unsigned development artifacts. Windows signing resolves an explicit signing-tool path, PATH, or the installed SDK and fails if configured signing cannot run; a produced Authenticode signature must verify. Signing diagnostics omit command arguments.

Nine signing tests cover incomplete/required configuration, accepted/rejected notarization, command failure, cleanup, missing Windows tools and failed signature verification. All pass, alongside three CLI packaging file-operation tests, 26 compiled CLI tests and ten release-staging/replacement tests. YAML and targeted whitespace checks pass. Actual production certificate import, notarization service acceptance and Windows signed installation remain required external validation. The native IDE application is open on the preserved disposable test workspace.

## Real local-model retrieval and responsive startup

A cold native probe measured 4,288 ms of synchronous model initialization with zero 100 ms timer callbacks. Local model construction now runs on a blocking worker, and the MCP session awaits completion while continuing to serve status and structural queries. The model cache is stored beside the graph database, with cache writes excluded from source watching. Settings now describe the measured download size (about 130 MB), structural-only mode, and actual backend selection behavior.

The opt-in installed-runtime test uses the actual BGE-small-en-v1.5 model and eight small source files. All six paraphrased queries rank the expected function first. The development runtime measured 5.21 s cold readiness, 0.50 s cached readiness with an unreachable model host, 9–23 ms individual search latency, and 398 ms for 32 concurrent searches with correct results. Status calls remained below 732 ms during initialization; structural lookup was exercised while semantic indexing was still building. Rename/body edits removed the old symbol and returned the updated source; restart reused all eight unchanged file records. The fixture and its downloaded model are removed after each run.

The native runtime builder now stages the complete output and replaces it only after successful construction. This also avoids overwriting a mapped Mach-O inode: an initial direct probe was terminated by macOS with “Code Signature Invalid,” whereas a fresh copy loaded successfully. Direct loading of the newly staged runtime succeeds.

Validation: graph TypeScript, release Rust/native compilation, and extension compilation pass; three graph lifecycle tests, three offline installed-runtime tests, and the real-model test pass. A failed local model download preserves structural tools and hides semantic search until available. The Rust core suite passes 38 tests with two explicit opt-in tests skipped in the default run; the separate release-mode 10,000-file SQLite insert benchmark also passes its 500 ms bound. The external FalkorDB Rust test remains skipped in this round. The native distribution workflow exposes an optional real-model test input and runs the same fixture against packaged runtimes. Evidence: `/tmp/sota-production-real-local-{tests,concurrency}.log`, `/tmp/sota-production-real-local-retrieval.json`, `/tmp/sota-production-local-{init-tests,rust-tests}.log`. The combined initial log retains a failed overly strict directory-event assertion; the corrected regression allows initial macOS root-event coalescing and verifies that subsequent model-cache writes do not trigger reindexing.

The optimized macOS arm64 application was rebuilt and packaged. The fresh DMG install again passes bundled extension activation, JavaScript debugger activation and native graph checks. The packaged real-model rerun passes all six relevance queries, 32 concurrent queries, edit invalidation and cached offline restart (5.63 s cold readiness, 0.50 s cached readiness, 15–19 ms individual queries, 682 ms for the concurrent batch). Instrumented status requests during model loading stayed below 8 ms; the initial native startup request took 820 ms. The preceding run, concurrent with desktop cold launch and the offline test file, observed a 4.59 s status response and failed the unchanged 1 s bound. That outlier is retained as an unresolved startup performance observation, not erased by the successful rerun. Durable measurements and exact installer checksums are in `2026-09-14-local-model-retrieval.json`.

Through native Settings, the disposable desktop test profile was switched from `none` to `local`. The status bar showed semantic search building while the UI stayed interactive, then ready with two source files and one symbol. The corrected model-size and mode descriptions were visible. The application remains open on the disposable project. Latest installer logs: `/tmp/sota-production-local-desktop-{build,package,install}.log`; packaged retrieval logs: `/tmp/sota-production-packaged-local-{tests,diagnostic}.log`.

## Native graph worker isolation and literal lookup

The startup outlier was followed by a deterministic reproduction: slow native loading plus synchronous vector construction stalled an MCP status request for 3,604 ms. Native calls now run in a dedicated child process reached through bounded IPC, leaving MCP status and lifecycle handling on the server process. Worker failure rejects pending calls, removes unavailable capabilities, and retains status; shutdown stops the worker and escalates only if it does not exit. The queue rejects excess work after 256 pending native requests. A thread-based prototype could not promptly stop a stalled native download (4,002 ms until transport escalation); the final process implementation closes that real stalled download in 11 ms. The compiled ESM development path also loads its worker and performs literal symbol lookup successfully.

The 2,002-symbol fixture found a separate lookup bug: SQL LIKE interpreted underscores as wildcards, so `compute1_` also matched `compute18...`. Lookup now escapes SQL wildcard characters while preserving literal substring matching and exact-name priority. Seven Rust search regressions pass, including underscores, percent signs and backslashes. The larger fixture then passes ten file replacements with no stale names. It uses generated 384-dimensional vectors to test capacity rather than claim semantic quality.

The combined native-process test run passes all 13 graph tests: three watcher tests, four offline lifecycle cases, the real local-model relevance fixture, the 2,002-symbol capacity fixture, and four worker responsiveness/failure/queue/shutdown cases. Under this concurrent run, the large index becomes ready in 9.36 s, 100 concurrent searches finish in 226 ms, and status responses stay below 62 ms. Real local-model status responses remain below 32 ms and all six paraphrased queries retain rank one. The final disconnect handling also passes all eight offline/worker lifecycle tests. CLI doctor detects a missing declared worker asset, and the clean-install verifier now requires `engine-worker.cjs`. Distribution CI runs the worker and capacity tests against packaged runtimes.

Logs: `/tmp/sota-production-worker-{before,process-tests,final-lifecycle,esm-smoke,doctor-tests}.log`, `/tmp/sota-production-symbol-literal-tests.log`. These results address the previously recorded blocking class; broad long-duration and cross-platform release validation remain open.

The final optimized macOS arm64 worker candidate passes fresh DMG installation, bundled extension/debugger activation, and all 13 packaged graph checks while the desktop launches concurrently. The large fixture reaches readiness in 12.53 s with status responses under 20 ms; 100 concurrent searches take 222 ms. Real local-model cold readiness is 10.66 s under this concurrent workload, cached readiness is 0.95 s, and all six relevance queries pass; status responses stay below 29 ms and 32 concurrent searches finish in 379 ms. A stalled real model download closes in 20 ms. Exact candidate checksums and measurements are recorded in `2026-09-14-native-worker-verification.json`.

The desktop was launched with the preserved local-search test profile. Its current backend log reports semantic readiness with two unchanged files and one symbol. Native visual confirmation remains pending because computer control reported that the Mac was locked and requires the user to unlock it manually. No unlock bypass was attempted. Latest evidence: `/tmp/sota-production-worker-desktop-{build,package,install}.log`, `/tmp/sota-production-worker-packaged-tests.log`, and `/tmp/sota-packaged-user-profile-20260914/logs/20260914T151421/window1/exthost/output_logging_20260914T151424/4-Son of Anton Code Graph.log`.

## CLI packaging recovery and cross-platform vendor correction

The CLI packager now stages a complete candidate before replacing existing output, throws through cleanup on failures instead of terminating inside the pipeline, and verifies official Node 22.23.2 archives against committed SHA-256 pins. Cached archives are verified and re-extracted before use. The producer and target use the same pinned Node release. `package:all` now stages all three platform outputs together and rejects missing binaries or license manifests; any failed target preserves the previous complete release set.

A real Linux container run caught a missing bundled Claude native binary: npm's cross-platform install did not select glibc, and upstream postinstall selected the build host. Target native packages are now required dependencies, Linux explicitly selects glibc, host postinstall is disabled, and the packager places Claude's selected executable itself. Executable headers and CPU architecture are checked for Claude, Codex, its code mode host, and ripgrep. The Windows cross-build also exposed a shim fallback that could launch Claude when Codex was requested. Every shim now uses its own package manifest; smoke tests verify the intended CLI's identity, not just a version-shaped string. AppleDouble archive metadata is excluded.

Core and CLI compilation pass. Twenty-one packaging regressions and four shared staged-directory regressions pass, covering checksums, wrong-platform/placeholder rejection, target setup, launcher separation, single-target and all-target failure preservation, signing failures and file replacement. Workflow YAML parsing and targeted whitespace checks pass. The fresh macOS CLI passes clean installation, help, both actual bundled agent launchers, CJS/ESM argument handling, ACP session creation, and relocation with a fresh cache. Its actual runtime is Node 22.23.2 on darwin/arm64. The Windows cross-build and archive checks pass, including both PE x64 native executables and distinct command shims; Windows execution and production signing remain unverified locally.

Linux testing retained two environment failures: fully emulated Debian exceeded the unchanged 120-second cold extraction deadline, and a native arm64 helper image initially lacked the x64 dynamic loader. An isolated image combining official native tools with official x64 runtime libraries now starts the actual Linux x64 CLI and reports Node 22.23.2; the complete smoke result is recorded in `2026-09-14-cli-release-verification.json`. QEMU results do not replace native Linux x64 CI.

The desktop's pending visual check is now complete. Native UI showed semantic readiness; code graph Restart returned to ready; integrated-terminal project tests passed 2/2; and the saved Council review retained all four completed stages. Updated native evidence is in `2026-09-14-native-worker-verification.json` and `2026-09-14-real-user-acceptance.md`. The app remains open on the preserved fixture.

Both pull-request package verification and the release workflow now run the packaging/rollback regressions and require the runner OS/CPU to match the target, so a misconfigured native job cannot quietly skip its smoke test as a cross-build. The Linux emulation run passed cold installation, help, actual Claude/Codex launches and CJS/ESM arguments before reaching the default 20-second ACP test deadline. The final emulation run uses an explicit 120-second ACP test deadline and a temporary executable memory filesystem; native defaults and application timeouts are unchanged. These environment adjustments are recorded separately from production performance claims.

The final Linux x64 emulated package smoke passes completely: clean install, version/help, intended bundled Claude and Codex launchers, CJS/ESM argument preservation, ACP initialize/session creation, relocation and fresh vendor cache. All test containers used `--rm` and network isolation; host credentials were not mounted. Exact binary hashes, runtime versions, environment caveats, and test logs are in `2026-09-14-cli-release-verification.json`. The fresh macOS and Linux functional passes do not close native Windows/Linux release validation, signing/notarization, or the broader production acceptance gates above.

## External embedding limits, recovery and sustained native run

The previous native provider runtime failed four new installed tests: declared oversized bodies waited for the transport deadline, chunked oversized bodies were accepted, redirects were followed, and 24 simultaneous searches issued 24 provider requests. Provider HTTP calls now share eight request slots and a 30-second deadline that includes queue waiting. Reads enforce a vector-shape-derived limit (32 bytes per requested component plus 16 KiB metadata, capped at 64 MiB), including chunked bodies. Redirects are rejected. Error messages omit provider URLs and response bodies. A separate transport-error test verifies that query-string secrets are omitted even when they differ from the configured API key.

All five installed provider cases now pass. Oversized/redirected responses preserve structural tools and remove semantic capability; credential failure after an edit reports degraded state, retains updated symbol lookup, and recovers semantic search after the provider is restored and another edit occurs. The 24-search batch peaks at eight HTTP requests. A Rust test confirms that a request waiting for a slot expires within the same deadline. The full Rust core suite passes 40 tests, with two existing opt-in tests ignored.

The five-minute native run copied 50 real application source files into a disposable installation (52 initial files including the two fixture files, 186 symbols). It completed 179 edit cycles and 3,580 concurrent-search calls without stale symbols. Sampled status calls stayed below 32 ms. Native-worker RSS after warmup was 53.8 MiB, peaked at 54.1 MiB, and ended at 50.6 MiB. Generated vectors isolate lifecycle and memory behavior from retrieval relevance. The fixture cleaned its own clients, HTTP server, workspace and database. Runtime entry, worker and native addon SHA-256 hashes match the freshly packaged application byte for byte.

The optimized macOS application was rebuilt, packaged and installed from its fresh DMG. Extension/debugger activation and the native graph check pass. All 18 packaged graph tests pass, including the five provider cases, real BGE-small relevance, 2,002-symbol capacity, offline behavior, watcher behavior and worker failure/queue/shutdown checks. All six real-model relevance queries still rank the expected function first; 100 concurrent capacity searches take 498 ms, and sampled status latency remains below 83 ms. The desktop is open on the preserved project, with semantic search ready, its completed Council review intact, and 2/2 project tests passing in the integrated terminal.

The distribution workflow runs provider recovery checks and exposes an optional five-minute source-corpus run. Exact installer/runtime hashes, measurements, limitations and logs are in `2026-09-14-provider-recovery-verification.json`. These results advance the external-provider and resource-recovery gates, but do not establish live commercial-provider compatibility, day-long stability, native Windows/Linux installation, or production signing.
