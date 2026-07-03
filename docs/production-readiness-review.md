<!--
	Copyright (c) Microsoft Corporation. All rights reserved.
	Licensed under the MIT License. See License.txt in the project root for license information.
-->

# Son of Anton — Production-Readiness Review

**Date:** 2026-07-01
**Scope:** Full-repository review for daily-driver adoption — agent runtime, IDE extension, backend services, MCP layer, CLI, VS Code fork integration, build/CI, and cross-cutting security/config.
**Method:** Eight parallel deep-review passes over the source, corroborated by direct builds, unit tests, type-checks, and the live GitHub Actions history.

---

## Bottom line

Son of Anton is an **ambitious, genuinely differentiated architecture with a disciplined fork and a well-engineered core runtime** — but it is **not production-ready and not yet safe to daily-drive on any code you did not write yourself.** The blockers are not cosmetic: multiple independent **remote-/local-code-execution paths**, a **complete absence of authentication** across the backend and MCP layers, several **advertised safety controls that are dead code**, and a **CI pipeline that is 100% red**, so none of this is currently caught.

The right framing: this is a strong **late-alpha**. The bones are good. What is missing is the entire "make the dangerous parts actually safe, and prove it in CI" layer — which for an agentic IDE *is* the product.

| Verdict | State |
|---|---|
| Use as daily driver on **trusted code you author**, trusted network, today | ⚠️ Possible but risky (secrets at rest, no CI safety net) |
| Use on **untrusted / cloned repositories** | ❌ Do **not** — opening a repo can execute its code |
| Use on **shared / public networks** | ❌ Do **not** — services bind `0.0.0.0` with no auth |
| Ship to **other users** | ❌ No installable, signed, updatable build exists |

---

## What's genuinely good

This review is critical by mandate, so state the strengths plainly — they are real and worth protecting:

- **The fork is disciplined.** The `vs/sessions` "Agentic Window" is a real top-level layer whose "workbench never imports sessions" rule is **machine-enforced** by ESLint, not just documented. Branding is complete and consistent, telemetry is **genuinely off by default** (`enableTelemetry:false`, no instrumentation key, no update URL), the extension gallery is correctly repointed to **Open VSX** (ToS-compliant), and both first-party extensions are **actually bundled** into product builds. The three Tier-3 core patches spot-checked (a11y keydown, Set perf, XSS escaping) are correct and behaviour-preserving.
- **The core runtime is well-architected.** The orchestrator's concurrent, dependency-aware fan-out has proper settled-fencing, circuit breakers, and timeout races; the retry helper honours `Retry-After` and abort signals; the OAuth broker does PKCE + state + a 0600 same-user socket.
- **The primary chat webview is done right** — nonce-based CSP with no `unsafe-inline`, every inbound `postMessage` shape-validated, privileged work routed to the host, cancellation threaded end-to-end.
- **`background-tasks` is a security model for the whole fleet** — refuses to start without an auth token, constant-time bearer check, image allowlist, workspace-root containment, intentionally unpublished port.
- **No secrets are leaked** in the repo or git history (every hit is a placeholder or test fixture), FalkorDB access uses parameterised Cypher (no injection), and the **Rust code-graph engine is solid** (`cargo check` clean, 35 tests pass).

---

## Component scorecard

| Component | Build/Test (verified) | Security | Production-ready? |
|---|---|---|---|
| VS Code fork integration | `src/` type-checks clean | Strong | ✅ Yes — the healthiest area |
| Rust code-graph engine (`crates/`) | `cargo check` clean, 35 tests pass | Good | ✅ Close |
| `son-of-anton-core` (runtime) | Builds; **1** test file | Mixed (secret mirroring, missing rails) | ⚠️ Strong beta |
| IDE extension | Bundles; **40 tests can't run** | Mixed (1 XSS, dead sandbox) | ⚠️ No |
| `son-of-anton-cli` | Builds; **0 tests** | Weak (trust bypass, no approvals) | ❌ No |
| Backend services | **5 of ~13 fail** build/test | **Very weak** (no auth anywhere) | ❌ No |
| MCP layer | — | **Very weak** (RCE, no auth) | ❌ No |
| Build / CI / release | **CI 100% red** | No SAST | ❌ No |

---

## Cross-cutting themes (the real story)

Individual findings are in the appendix. The pattern across them matters more than any single bug.

### 1. Authentication is absent almost everywhere
`docker-compose` publishes **every** service port on `0.0.0.0` (all interfaces). **12 of 13 HTTP services have no authentication** (only `background-tasks` does). FalkorDB and Qdrant run with **no password / no API key**. Every MCP server exposes an unauthenticated SSE endpoint. The consequence: any other local process (a malicious `npm`/`pip` transitive dependency during dev), any host on the same LAN, or **even a web page you merely visit** (via DNS-rebinding to `127.0.0.1`) can drive the whole stack — read your code graph, spend your LLM budget through the model-router's open proxy, or run `FLUSHALL` against your graph DB. On public Wi-Fi this is remote data destruction.

### 2. Opening an untrusted repository can execute its code
There are **four independent paths** to code execution from a cloned repo:
- The **CLI hardcodes `workspace.isTrusted = true`** and auto-runs `.son-of-anton/hooks.json` scripts at session-start and before every prompt — so `cd`-ing into a repo and running `sota chat` executes that repo's code with no prompt.
- The extension **spawns MCP servers from workspace-merged config** (`sota.mcp.servers`, which a repo's `.vscode/settings.json` can set) with the full host environment.
- `acp-client` **spawns commands from a workspace file** (`.son-of-anton/agents/acp-agents.json`).
- The `playwright` MCP server exposes **`run_playwright_code`**, which runs attacker-supplied JavaScript through `new Function()` in the Node host — a full RCE primitive.

### 3. Several advertised safety controls are theater
The features that would make an agentic IDE trustworthy are documented but **not wired**:
- The **Docker "sandbox"** is instantiated at activation but `setDockerApi()` is never called — agent commands run on the **host**, not in a container. No isolation, no capability dropping, no seccomp, no resource limits.
- The **context-sanitiser** (which docs say "strips secrets and sensitive data from LLM context") has **zero callers** on the model path, and its detection logic **fails open** (an off-by-one trust check) for exactly the medium-trust sources — docs, MCP tool descriptions — it was written to guard.
- The **extension allowlist** the docs cite is dead code; the one that loads only warns, never blocks.
- The **MCP trust list** (`supply-chain.json`) is dead code — `validateMcpConnection()` has no callers.
- The core runtime's advertised **"5 concurrent requests / 30 req-min / spend kill-switch"** rails **do not exist in core** (spend cap lives only in the extension; the orchestrator fan-out is uncapped).
- The **"no agent code merged without review agent passing"** gate is a soft, post-hoc LLM pass, not a hard pre-write gate, and inline edits bypass it entirely.

### 4. CI is 100% red — nothing above is caught
The single CI pipeline has been fully failing since 2026-06-24 (latest run: 4 jobs failed, 6 skipped because they depend on the failed gates). The Son-of-Anton jobs die at `npm ci` (missing `libkrb5-dev` for the `kerberos` native module); the base compile gate dies on pre-existing build-script TypeScript errors; the Rust job dies on `clippy -D warnings`. Because every gate fails before its dependents run, **the confirmed-broken components (extension tests, several services) are never even exercised — broken code merges silently.** The extension's 40 test files can't run at all (the `test` script points at a nonexistent file and no test framework is installed); most services have zero tests.

### 5. The flagship capability is partly unwired
- **No CLI command reaches the agent tool loop.** `sota run` streams prose but never edits a file — the wired tool-execution context is unreachable dead code.
- **Semantic search returns mock results** — the indexer defaults to a `Math.sin(hash)` placeholder embedding.
- **`lsif` installs none of its indexers** — every run is a silent no-op.
- The OpenAI reasoning/GPT-5 model IDs are **broken** on the direct path (wrong token parameter → HTTP 400).

### 6. Secrets are downgraded to plaintext at rest
In **three** places (core, extension, CLI), provider API keys — and AWS secret-access-keys — are mirrored out of `SecretStorage`/keychain into **plaintext** on disk or into `settings.json` (which Settings Sync then uploads to the cloud). This directly violates the project's own "no storing secrets" rule and is redundant (the resolver already reads SecretStorage first).

---

## Path to daily-driver — phased

### Phase 0 — Interim posture (today)
Until Phase 1 lands: use it **only** on repositories you authored, on a **trusted network**, and assume the backend ports are open. Do not open cloned/untrusted repos. Treat `~/.son-of-anton/data/secrets.json` and `settings.json` as sensitive.

### Phase 1 — Stop the bleeding (security criticals) — *~1–2 weeks*
1. **Lock down the network surface.** Bind every service and FalkorDB/Qdrant to `127.0.0.1`; add mandatory bearer-token (or unix-socket) middleware to `services/_shared` and apply it everywhere (copy the `background-tasks` pattern); set FalkorDB `requirepass` and a Qdrant API key.
2. **Close the untrusted-repo RCE paths.** Restore real workspace-trust in the CLI; gate hook execution, MCP-server spawning, and acp spawning behind trust + explicit user confirmation; delete `run_playwright_code`.
3. **Harden `checkpoints`.** Sanitise `sessionId` (reject `/` and `..`, resolve-and-contain), apply the create-side containment check to restore, require auth, take a pre-restore backup.
4. **Fix the reachable XSS** in `ImpactAnalysisPanel`/`FleetDashboardPanel` (apply the existing nonce-CSP pattern; escape/rehydrate via `textContent`).

### Phase 2 — Make it real (green CI + wire the dead controls) — *~2–4 weeks*
5. **Get CI green and gate merges.** Fix the four structural failures (kerberos `libkrb5-dev`, build-script TS errors, Rust clippy + toolchain pin, indexer peer-deps), then require checks via branch protection. Add CodeQL.
6. **Fix and actually run the test suites** — the extension's 40 files (add a real runner + framework), core, and a per-service matrix. Fix the 5 failing/broken service builds.
7. **Wire or delete the safety controls.** Wire `context-sanitiser` onto the model path and fix its off-by-one (or delete it); resolve the sandbox (wire real Docker isolation or delete the machinery and document host-allowlist reality); enforce or delete the extension allowlist and MCP trust list.
8. **Fix the two broken core Docker builds** (`model-router`, `mcp-gateway` never copy the `tracing` dist) and the missing-`curl` healthchecks that keep `walkthrough` from ever starting.
9. **Stop mirroring secrets to plaintext.**

### Phase 3 — Make it whole (deliver the flagship) — *~3–6 weeks*
10. **Wire the CLI tool loop** to a command with real approvals (interactive confirm for `requiresApproval`; explicit `--yes` for headless). Implement the core rails (concurrency semaphore, per-agent rate limit, spend kill-switch).
11. **Fix the OpenAI reasoning body** (`max_completion_tokens`) and unify with the Foundry path.
12. **Replace the mock embeddings** with a real provider so semantic search is semantic; install the LSIF indexers or gate the service off.
13. **Per-call token accounting** so cost/spend numbers are trustworthy.

### Phase 4 — Ship it (packaging + maintainability) — *ongoing*
14. **Add a real IDE packaging + release pipeline** — signed/notarised `.deb`/`.dmg`/`.exe` via the upstream gulp tasks; decide on an update strategy (self-hosted update server or documented manual updates); fix the placeholder `son-of-anton/son-of-anton` URLs in `product.json`.
15. **Establish an upstream merge lane** — add a `microsoft/vscode` remote and rebase onto a tagged release so drift is reconciled with git, not hand-applied snapshots. Upstream the a11y/perf micro-patches to shrink the Tier-3 footprint.
16. **Localize** the extension (currently 100% hardcoded English) and complete `.env.example`, `SECURITY.md`, and repo hygiene (the `.Jules`/`.jules` case-collision, committed cruft).

---

## Opportunities to take it to the next level

Beyond fixing what's broken, the highest-leverage bets — the ones that turn this from "another VS Code + AI fork" into something differentiated:

1. **Make "safe autonomy" the product.** The market is crowded with AI editors; almost none are trustworthy on untrusted code. If Son of Anton makes the trust boundary *real* — every tool result wrapped and treated as untrusted before it re-enters the model, every destructive tool gated, a genuine container sandbox, a working context-sanitiser — that becomes the moat, not the graph or the agents.
2. **Lean into the code-graph advantage.** The FalkorDB/Qdrant + Tree-sitter + LSIF stack is a real differentiator *once the embeddings are real and the indexer is reliable*. Graph-routed context ("include only the callers/callees that matter") is the token-efficiency story that justifies the whole architecture — but it's currently mock-vs-mock.
3. **Invest in the Agentic Window (`vs/sessions`).** It's a genuine, well-layered UX surface that no upstream-tracking fork has. A first-class multi-agent session view — live plan/subtask streaming, spend meter, checkpoint timeline — is a feature competitors can't easily copy from an extension.
4. **Turn the spend/rate governance into a headline feature.** Developers are nervous about agent cost. A real, core-level kill-switch + live per-session budget + per-model cost meter (all currently partial or wrong) is both a safety control and a marketing point.
5. **Make CI the quality bar it's pretending to be.** Green, required CI with the review-agent gate + CodeQL + per-service tests would let the project move fast without the current "broken code merges silently" risk — and is the precondition for ever accepting outside contributions.

---

## Appendix — where the detail lives

Full per-area findings (severity-ranked, with `file:line` evidence and failure scenarios) were produced for each of the eight areas: **agent runtime core, IDE extension, backend services, MCP layer, CLI, fork integration, build/CI, and cross-cutting security**. The highest-severity items by area:

- **MCP:** `run_playwright_code` `new Function` RCE; no-auth SSE on all servers; workspace-config process spawning; dead trust list; verbatim tool-results → prompt-injection channel.
- **Services:** FalkorDB/Qdrant on `0.0.0.0` no-auth; `checkpoints` unauth rollback + `rm -rf` path traversal; `model-router` open LLM proxy; `context-sanitiser` off-by-one fail-open; two core Docker builds broken.
- **CLI:** hardcoded `isTrusted:true` + auto-run hooks (repo-open RCE); agent tool loop never wired; no approval gates; broken SEA self-update.
- **Core:** OpenAI reasoning models send wrong token param (HTTP 400); API/AWS keys mirrored to plaintext settings; missing concurrency/rate/spend rails; O(n²) token accounting.
- **Extension:** reachable `ImpactAnalysisPanel` XSS; Docker sandbox is dead code; 40-test suite can't execute; secrets mirrored to plaintext disk; 100% unlocalized.
- **Build/CI:** the only pipeline is 100% red; SoA packages absent from the install manifest; no installable-IDE build; no SAST.
- **Fork (healthiest):** experimental `build/vite` harness hardcodes Microsoft endpoints; allowlist unenforced; snapshot fork with no upstream git lineage.
- **Security:** secret sweep clean and telemetry genuinely off, but context-sanitiser/allowlist/review-gate are documented-but-unwired; `SECURITY.md` still Microsoft boilerplate; several stale doc paths.
