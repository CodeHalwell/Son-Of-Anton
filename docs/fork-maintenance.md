# Fork patch ownership

New Son of Anton behavior belongs in the extension, shared core, CLI, graph engine and services. The [existing fork audit](fork-compliance-audit.md) records inherited branding and service changes. This inventory groups the patches that require attention on an upstream update; it does not assert that every historical source edit has been audited against a current upstream ref.

| Owned area | Reason to retain | Verification | Upstream disposition |
|---|---|---|---|
| `product.json`, product identity/resources | Son of Anton branding, update and extension-gallery policy | Product packaging, endpoint and license review | Fork-specific |
| Telemetry configuration and Microsoft service integrations listed in the audit | Local privacy and product policy | Configuration tests and endpoint audit | Retain policy in product configuration where possible |
| Built-in extension selection / allowlist | Distribute the supported first-party feature set | Compile extensions; inspect shipped manifests/assets | Fork-specific configuration |
| `build/gulpfile.vscode.ts` product naming | Platform distribution name | Package and smoke-test extracted output | Fork-specific |
| Root package scripts / Son of Anton CI jobs | Build shared core before hosts, package native graph, exercise product contracts | Core/CLI/extension suites, board types, native and browser fixtures | Keep isolated from inherited editor tasks |
| Other inherited editor fixes and optimizations | Preserve only demonstrated behavior improvements | Relevant upstream unit suites and review of the merge diff | Propose generic fixes upstream; drop duplicates after adoption |

This change adds no editor source patch. Bootstrap and packaging integration are Tier 3 because they affect inherited build configuration; they are necessary to place the native first-party runtime in a runnable distribution. The board/chat changes and shared runtime modules stay in owned packages.

## Update rehearsal

1. Fetch the desired upstream ref separately and record its exact commit. Review the ref before using it; the helper never chooses or fetches an upstream automatically.
2. Run `node scripts/check-case-collisions.mjs` to reject file and directory collisions on case-insensitive filesystems.
3. Run `node scripts/rehearse-upstream.mjs <reviewed-ref>`. It prints the merge base, divergence and `git merge-tree` result. This writes synthetic Git objects but leaves HEAD, index, workspace files and stashes alone. Exit 1 signals merge conflicts.
4. Perform the actual update on an isolated branch/worktree, review conflicts against the inventory, and run editor compile/layer checks plus the Son of Anton offline suites.
5. Package the platform application and run the installed runtime test using `SOTA_RUNTIME_SOURCE`; verify startup with a fresh profile and provider credentials only when live testing is explicitly intended.

No `upstream` remote-tracking ref is available in the current checkout. The helper can be smoke-tested against HEAD, but that does not measure current upstream divergence or prove a future merge clean.
