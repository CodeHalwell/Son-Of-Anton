# Packaging `sota`

This document describes how the `sota` CLI is packaged into a single,
self-contained binary using **esbuild + Node SEA (Single Executable
Applications)**. The pipeline is implemented in three stages:

| Stage | Adds                                                          | Status     |
|-------|---------------------------------------------------------------|------------|
| 1     | esbuild bundle + Node SEA + prompt assets (macOS arm64 only)  | shipped    |
| 2     | Vendored `@anthropic-ai/claude-code` and `@openai/codex` CLIs | shipped    |
| 3     | Linux x64 and Windows x64 cross-builds                        | shipped    |

The shared pipeline lives in `scripts/lib/sea-pipeline.mjs`; one thin
driver per target platform wraps it (`scripts/package-<target>.mjs`).

## TL;DR

```bash
cd son-of-anton-cli
npm install                  # one-time

# Single platform:
npm run package:macos-arm64  # dist-bundle/sota
npm run package:linux-x64    # dist-bundle/sota-linux-x64
npm run package:windows-x64  # dist-bundle/sota-windows-x64.exe

# All three at once:
npm run package:all
```

Outputs land in `dist-bundle/` alongside `THIRD_PARTY_LICENSES.txt`. Set
`SOTA_CLI_PACKAGE_OUTPUT` to keep a target in a different output directory.
The packager stages a complete candidate and runs applicable smoke checks
before replacing the prior output. A failed build preserves the last working
CLI. `package:all` builds every target in isolation and replaces the full
three-platform set only after all targets succeed; a missing binary or license
manifest fails the run. Its temporary `sea-config.json` is removed after blob
generation.

## Pipeline (ten steps)

For each target the pipeline runs:

1.  **Bundle** — `esbuild` walks the import graph from
    `src/seaEntry.ts` and writes a single CommonJS file to
    `dist-bundle/cli.cjs`. Everything (commander, ink, react,
    marked-terminal, the AWS Bedrock SDK, `son-of-anton-core/dist/**`)
    is inlined; no `node_modules` resolution happens at runtime.
2.  **Vendor install** — install the pinned upstream CLIs and their target
    native packages as required dependencies. Use `--os` / `--cpu`, plus
    `--libc glibc` for the Linux release. `--ignore-scripts` prevents
    upstream postinstall from selecting the build host instead of the
    target. The packager places Claude's target executable explicitly and
    checks native headers and CPU architecture for Claude, Codex, its code
    mode host, and ripgrep. Missing downloads or placeholder launchers fail
    packaging before publication. Cross-builds pass `--force` only to work
    around npm 10's host-only required-dependency platform check; the
    packager independently rejects incorrect target executable headers.
3.  **Shim rewrite** — replaces every launcher shim under
    `vendor/node_modules/.bin/` with a small wrapper that re-enters the
    SEA binary via its trampoline mode (`sota --sota-run-node …`).
    Native launchers execute directly; script paths come from each package's
    own manifest, including on cross-builds. Posix targets get an `sh` wrapper; Windows gets a `.cmd` wrapper and
    a posix wrapper (for MSYS / git-bash). The actual SEA-binary path
    is templated as `__SOTA_BIN__` and resolved at first-run extraction
    time (we don't know the user's install path at build time).
4.  **Archive** — tar+gzip the vendor tree into
    `dist-bundle/vendor.tgz` so the SEA only carries one asset blob
    instead of thousands of individual files. macOS AppleDouble metadata is
    excluded so it does not leak into Linux or Windows installations.
5.  **Licenses** — walk every package under
    `vendor/node_modules/`, concatenate each LICENSE file into
    `dist-bundle/THIRD_PARTY_LICENSES.txt` with name/version/license
    metadata.
6.  **`sea-config.json`** — emit a fresh config listing every
    `son-of-anton-core/dist/agents/prompts/*.prompt.md` and the
    `vendor.tgz` as SEA assets. `useCodeCache` is on for host builds
    (faster cold start) and off for cross-builds (the V8 code cache is
    keyed to the producing platform; embedding a host-built cache
    would crash a cross-target SEA at startup).
7.  **SEA blob** — `node --experimental-sea-config sea-config.json`
    produces the blob with the pinned official Node 22.23.2 release
    (cached per target under `~/.cache/sota-sea/`). Archives are checked
    against committed SHA-256 values before extraction, including on cache
    reuse. The producer and target use that same release; the Node running
    the packager is never substituted for the pinned producer.
8.  **Copy & inject** — copy the target's official Node binary to
    `dist-bundle/<binary>`, then `npx postject` injects the blob into
    the `NODE_SEA` segment. On Mach-O we pass `--macho-segment-name
    NODE_SEA`; on ELF/PE we don't.
9.  **Re-sign** — on macOS, `codesign --remove-signature` strips the
    original signature; `codesign --sign -` applies an ad-hoc
    signature so the OS will execute the modified binary. After the
    ad-hoc step, an optional production-signing pass runs if the
    relevant `SOTA_MACOS_*` env vars are present (Developer ID re-sign
    + notarisation; see [Signing](#signing) below). On Windows,
    signing is likewise gated on `SOTA_WINDOWS_*` env vars and runs
    from the same hook. Skipped wholesale on Linux.
10. **Smoke** — copy into a clean temporary installation with spaces in its path and a separate cache. Verify version/help, CJS/ESM trampoline arguments, actual bundled Claude/Codex `--version` launches, ACP initialization/session creation, and relocation to a different executable path. Only runs when the build host matches the target. The ACP test deadline is 20 seconds by default; explicit `packageSmoke` callers may supply `handshakeTimeoutMs` for emulated environments and must report that difference. This does not change application timeouts. Pull-request CI builds and checks macOS arm64, Linux x64 and Windows x64 without publishing a release.

## What is bundled

- Everything under `son-of-anton-cli/src/**`.
- The full compiled tree of `son-of-anton-core/dist/**`, including the
  agent role descriptions (`agents/prompts/*.prompt.md`) — shipped as
  SEA assets, read via a `fs.readFileSync` shim in `src/seaEntry.ts`.
- All third-party deps from `package.json` (commander, ink, react,
  cli-highlight, marked / marked-terminal, ink-spinner, the AWS
  Bedrock SDK pair).
- **Stage 2 additions**: the upstream `@anthropic-ai/claude-code` and
  `@openai/codex` CLIs with their **target-platform** optional-dep
  binaries, as a `vendor.tgz` SEA asset. Extracted at first run into
  `~/.sota/cache/<sota-version>-<executable-identity>/`; subsequent runs reuse the extracted
  tree.

## Vendor extraction at runtime

The cache identity includes the executable's path, size and modification time, so moving or replacing a binary does not reuse launchers pointing at an old installation. `SOTA_CACHE_DIR` can select a different absolute cache root. On first invocation, the SEA entrypoint:

1.  Looks for `<cache-root>/<version>-<identity>/.extracted`; if present,
    short-circuits.
2.  Otherwise extracts the `vendor.tgz` asset via the system `tar`
    binary (available on macOS, Linux, and Windows 10+) into a sibling
    temporary directory on the destination filesystem.
3.  Rewrites the `__SOTA_BIN__` placeholder in every shim under
    `vendor/node_modules/.bin/` with `process.execPath` (the absolute
    path of the running SEA binary), with platform-appropriate escaping. Publishes the fully patched tree and sentinel by atomic rename only after extraction succeeds; concurrent invocations cannot see a half-written cache.
4.  Prepends `<cache>/node_modules/.bin/` to `process.env.PATH`. The
    existing `isClaudeCodeAvailable` / `isCodexAvailable` probes (in
    `son-of-anton-core/src/llm/{claudeCodeRunner,codexRunner}.ts`) walk
    `PATH` so this is sufficient to make them discover the vendored
    copies — no runner-side changes needed.

The cache directory layout:

```
~/.sota/cache/0.1.0-<identity>/
├── .extracted                                # sentinel ISO timestamp
└── node_modules/
    ├── .bin/
    │   ├── claude          # sh wrapper -> SEA trampoline
    │   ├── claude.cmd      # Windows wrapper (only on Windows builds)
    │   ├── codex           # sh wrapper -> SEA trampoline
    │   └── codex.cmd       # Windows wrapper (only on Windows builds)
    ├── @anthropic-ai/
    │   └── claude-code/
    └── @openai/
        └── codex/
```

The `<sota-version>` segment means an upgrade extracts into a fresh
directory; the previous version's cache lingers until manually
cleaned. (`rm -rf ~/.sota/cache/` is always safe.)

## Node runtime: SEA-as-trampoline (strategy A')

The task spec asked us to pick one of three strategies for letting
the vendored launcher shims find a Node interpreter:

  - **A**: patch the shim's shebang to `process.execPath` of the SEA
    binary.
  - **B**: shell wrapper that does `exec "$SOTA_NODE" /path/to.js "$@"`.
  - **C**: bundle a separate `node` runtime in vendor/.

**Strategy A turned out to be impossible.** Per the Node SEA docs,
when a SEA binary is invoked, the embedded blob always runs as the
main module — there's no fuse / flag to fall through to a CLI-supplied
script path. So pointing a shebang at the SEA binary just re-runs
`sota` itself, with the JS path appended to `process.argv` but never
loaded.

**We landed on a hybrid of B and A** (call it **A'**): the shim is a
shell wrapper that re-enters the SEA binary with a special
`--sota-run-node <script>` argv that `seaEntry.ts` handles before the
CLI dispatch (`runScriptInTrampoline`). The trampoline synthesises the
correct `require` context for the script and runs it as if `sota`
were a generic Node interpreter — but only for the JS files we
vendor.

The trampoline tries synchronous `require()` first (best stack
traces). On `ERR_REQUIRE_ASYNC_MODULE` / `ERR_REQUIRE_ESM` (the
upstream `@openai/codex` shim is ESM with top-level `await`) it falls
back to dynamic `import()` via a file URL.

**Surprise**: `@anthropic-ai/claude-code@2.1.138` ships its bin
target as a *native* Mach-O / ELF / PE binary at `bin/claude.exe`
(despite the `.exe` suffix), not as a JS launcher. The shim-rewriter
sniffs each bin target's magic bytes and emits a different wrapper
for native binaries (a plain `exec "$DIR/.../claude.exe" "$@"`) so
we bypass the trampoline entirely for them.

Platform-specific quirks:

| Platform     | Shim format                          | JS launcher                                                     | Native binary                                       |
|--------------|--------------------------------------|-----------------------------------------------------------------|-----------------------------------------------------|
| macOS arm64  | `#!/bin/sh` POSIX wrapper            | `exec "/abs/sota" --sota-run-node "$DIR/cli.js" "$@"`           | `exec "$DIR/.../claude.exe" "$@"`                   |
| Linux x64    | `#!/bin/sh` POSIX wrapper            | Same as macOS                                                   | Same as macOS                                       |
| Windows x64  | `.cmd` + extension-less posix wrap   | `.cmd`: `"%SOTA_BIN%" --sota-run-node "%~dp0\cli.js" %*`        | `.cmd`: `"%~dp0\claude.exe" %*`                     |

The advantage of A' over C: we don't double the binary size by
bundling a second Node interpreter, and we keep the upgrade story
simple — only the SEA binary needs replacing.

## What is NOT bundled

- **The IDE** — this binary is the CLI only. The VS Code fork still
  ships through the regular `gulp vscode-darwin-arm64-min` pipeline.
- **A separate `node` interpreter** — see the strategy discussion
  above; the SEA binary's trampoline mode acts as the interpreter for
  vendored JS.

## Cross-platform status

| Platform        | Stage | Status         | Codesign at build time                   |
|-----------------|-------|----------------|------------------------------------------|
| macOS arm64     | 1+2   | shipped        | ad-hoc + optional Developer ID/notary    |
| Linux x64       | 3     | shipped        | n/a                                      |
| Windows x64     | 3     | shipped        | optional Authenticode via `signtool`     |
| macOS x64       | 3+    | not yet built  | —                                        |
| Linux arm64     | 3+    | not yet built  | —                                        |

The cache-dir convention (`~/.sota/cache/...`) is identical on macOS,
Linux, and Windows. On Windows that resolves to
`C:\Users\<user>\.sota\cache\` — less XDG-compliant than
`%LOCALAPPDATA%` but consistent across the three targets.

## Approximate binary sizes

Historical measurements with `claude-code@2.1.138` + `codex@0.130.0`, Node 22.20.0
(these are not measurements of the current pins):

| Binary                                 | vendor.tgz  | Final binary |
|----------------------------------------|-------------|--------------|
| `sota` (darwin-arm64, Mach-O)          | 135 MiB     | 247 MiB      |
| `sota-linux-x64` (ELF)                 |  83 MiB     | 206 MiB      |
| `sota-windows-x64.exe` (PE)            | 151 MiB     | 238 MiB      |

The `vendor.tgz` size varies per target because the platform-specific
optional-dep binaries differ (e.g. claude-code's native binary for
darwin-arm64 vs win32-x64). After first-run extraction the user sees
an additional `~/.sota/cache/<version>/` tree roughly 3× the archive
size (uncompressed).

## Signing

Production signing is bolted onto the packaging pipeline as an optional
ninth-step extension (`signBinary` in `scripts/lib/sea-pipeline.mjs`). It
is **entirely env-var driven** — with no env vars set the local dev flow
is unchanged (ad-hoc Mach-O signature, unsigned ELF, unsigned PE). The
release GitHub Actions workflow (`.github/workflows/release-sota.yml`)
sets the env vars from repository secrets on a per-runner basis. Tagged releases require signing; manual runs can disable `require_signing` for a development artifact. Set `SOTA_REQUIRE_SIGNING=true` to enforce the same gate locally.

### macOS — Developer ID + notarisation

| Env var                            | Meaning                                                                                |
|------------------------------------|----------------------------------------------------------------------------------------|
| `SOTA_MACOS_SIGNING_IDENTITY`      | Common name of the Developer ID Application identity in the login keychain.            |
| `SOTA_MACOS_SIGNING_KEYCHAIN`     | Optional keychain containing the identity; CI imports its P12 into a temporary keychain. |
| `SOTA_MACOS_NOTARY_KEY_ID`         | App Store Connect API key ID (10-char alphanumeric).                                   |
| `SOTA_MACOS_NOTARY_KEY_ISSUER`     | Issuer UUID for the API key.                                                           |
| `SOTA_MACOS_NOTARY_KEY_PATH`       | Path to the `AuthKey_<id>.p8` file on disk.                                            |

Behaviour:

- Developer ID signing enables the hardened runtime with only the JIT entitlement needed by Node. The signature is verified before notarization.
- Notarization requires all three notary settings and a signing identity. Partial configuration fails before signing. The packager submits a temporary ZIP, waits up to 30 minutes, requires an accepted result, and verifies the executable's notarized code requirement.
- Raw command-line executables cannot carry a stapled ticket. Gatekeeper retrieves their ticket online on first use. See [Apple's notarization workflow explanation](https://developer.apple.com/videos/play/wwdc2019/703/). The temporary ZIP is removed on success or failure.
- CI imports `MACOS_SIGNING_CERT_P12` using `MACOS_SIGNING_CERT_PASSWORD`, uses `MACOS_SIGNING_IDENTITY`, and decodes the `MACOS_NOTARY_KEY_BASE64` key with its `MACOS_NOTARY_KEY_ID` and `MACOS_NOTARY_KEY_ISSUER`. The import action deletes its temporary keychain after the job; decoded key files are explicitly cleaned up.

### Windows — Authenticode

| Env var                                       | Meaning                                                                |
|-----------------------------------------------|------------------------------------------------------------------------|
| `SOTA_WINDOWS_SIGNING_CERT`                   | Path to a `.pfx` (PKCS#12) certificate file.                           |
| `SOTA_WINDOWS_SIGNING_PASSWORD`               | Password for the `.pfx`. Use this OR…                                  |
| `SOTA_WINDOWS_SIGNING_CERT_PASSWORD_FILE`     | Path to a file whose contents are the password.      |
| `SOTA_WINDOWS_SIGNTOOL` | Optional explicit path to `signtool.exe`. |

Behaviour:

- Configured signing uses an RFC3161 timestamp and SHA-256 file digest, then verifies the Authenticode signature.
- The tool is resolved from the explicit path, PATH, or the installed Windows SDK. Missing credentials, unavailable tools and failed verification stop the build when signing is configured or required.
- A password file avoids an environment variable, but `signtool` still receives the password as a process argument. Signing failures do not include arguments in diagnostics.

### Direct invocation from the release workflow

`signMacOs(binaryPath)` and `signWindows(binaryPath)` are exported from
`scripts/lib/sea-pipeline.mjs` so the release workflow (or a separate
post-build signing job) can call them on an already-built binary,
independent of the rest of the packaging pipeline. The pipeline's own
step 9 calls `signBinary({ target, binaryPath })` which dispatches to
the right helper based on `target.exeFormat`.

### Local testing without real certs

Run `node --test scripts/lib/signing.test.mjs` from the CLI directory. The tests exercise required/partial credentials, accepted/rejected notarization, cleanup, missing Windows tools and signature-verification failures using command fixtures. These tests do not establish that a release is signed. Actual signing and clean-machine Gatekeeper/Authenticode verification still require the production certificates and native runners.

## Self-update

`sota update` operates in one of two modes depending on how the binary was
installed:

| Mode  | Detected via                      | Source of truth      | Behaviour                                                                                          |
|-------|-----------------------------------|----------------------|----------------------------------------------------------------------------------------------------|
| npm   | `require('node:sea').isSea()` → false | npmjs.org registry  | Print the recommended `npm i -g son-of-anton-cli@latest` command — do not touch any files.        |
| SEA   | `require('node:sea').isSea()` → true  | GitHub Releases API | Fetch the latest `sota-v*` release, download the matching artefact, verify SHA256, swap in place. |

The SEA flow:

1. Maps `process.platform` + `process.arch` to one of the three release
   artefact names produced by the release workflow (`sota-macos-arm64`,
   `sota-linux-x64`, `sota-windows-x64.exe`).
2. Paginates `GET /repos/<owner>/<repo>/releases` and picks the highest stable CLI version, ignoring IDE, draft and prerelease entries. An incomplete or failed catalog check does not claim a latest version.
3. Downloads `SHA256SUMS.txt` from the release and reads the expected
   digest for the artefact. **A release without `SHA256SUMS.txt` is
   refused.**
4. Streams the artefact to a temp file while computing SHA256, then
   compares against the expected digest.
5. Copies the download to an exclusive staging file beside the installed executable, verifies its checksum again and sets its executable mode before replacement. Renames the old binary to a unique `.old` backup, then renames the staged file into place. A failed second rename rolls back the first. Staging on the destination volume avoids cross-device rename failures. Backups remain available until the user removes them.

   The OS keeps the still-running process pointed at the now-renamed
   `.old` file via its open file descriptor, so the current invocation
   completes normally. The user re-runs `sota` to pick up the new binary.

### Windows quirk

On Windows, file handles to running executables prevent some rename
operations. The current implementation lets the OS surface the error
("Access is denied" or `EBUSY`) when it can't perform the swap; the
installed binary is preserved. Close running processes and use an external installer if the operating system prevents self-replacement. The update tests cover locked targets and failed swaps; they do not claim Windows allows replacing every running executable.

### Dry-run

`sota update --dry-run` prints the planned actions (release tag, asset
name, target path, swap commands) without touching any files. Useful for
verifying the URL plumbing in a sandboxed environment, or as a CI gate
against a release that hasn't been promoted yet.

### Cache

`sota update` and the background `maybeNagAboutUpdate` helper share a
cache file at `~/.son-of-anton/data/update-check.json` so the registry
isn't hit on every invocation. Standalone builds check GitHub releases, and cache entries distinguish standalone from npm installations. The cache TTL is 24 hours.

## Known limitations

- **First-run startup**: extracting `vendor.tgz` adds a one-time
  ~1–3 s delay on first invocation per `sota` version. Subsequent
  invocations skip extraction via the `.extracted` sentinel.
- **Trampoline limitations**: the `--sota-run-node` re-entry only
  loads the script as a CommonJS module via `Module.createRequire`.
  It will not work for ESM scripts that need top-level `await`
  outside of `import()` — but the vendored launcher shims are both
  CJS today, so this is not a current problem.
- **No `--inspect`**: the SEA flow disables the Node inspector by
  default (see `useCodeCache: true` on host builds). For debugging,
  run `node dist/cli.js` instead.
- **Producer and target must match the pinned release**: the build pins
  `NODE_VERSION = v22.23.2` in `scripts/lib/sea-pipeline.mjs` and archive
  checksums in `scripts/lib/node-archive.mjs`. Update both together; a major
  version migration also requires updating the esbuild target and rerunning
  all native smoke tests. This pin includes the [July 2026 security release](https://nodejs.org/en/blog/release/v22.23.2).
- **Signing is opt-in** — production Authenticode signing on Windows
  and Developer ID + notarisation on macOS are bolted onto the
  pipeline via env vars (see [Signing](#signing)). Local builds with
  no env vars set produce an ad-hoc-signed Mach-O on macOS and
  unsigned ELF/PE on Linux/Windows.

## Troubleshooting

| Symptom                                                    | Fix                                                                                                                                       |
|------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------|
| `Could not find the sentinel NODE_SEA_FUSE_...`            | Check that the packager is using its pinned official Node archive; the producer and target are validated before injection. |
| `Node archive SHA-256 does not match its pinned release` | Do not bypass verification. Check the Node version and committed archive hashes against the official release's SHASUMS256.txt. |
| `code signature in ... not valid for use`                  | The re-sign step was skipped — re-run `npm run package:macos-arm64`.                                                                      |
| `Failed to load agent prompt for "..."`                    | A new prompt file was added to `son-of-anton-core/src/agents/prompts/` without rebuilding core. Run `npm --prefix ../son-of-anton-core run build` first. |
| Bundle size jumps by >20 MiB                               | Check what new transitive dep got pulled in — `npx esbuild --analyze src/seaEntry.ts > /tmp/analyze.txt` shows the per-import cost.       |
| `sota: failed to extract vendor.tgz`                       | The system `tar` is missing (very old Windows host, or stripped container). Install `tar` or roll back to a build without Stage 2.       |
| Vendored `claude` exits with `MODULE_NOT_FOUND`            | The cache may be from a previous SEA install whose binary path no longer exists. `rm -rf ~/.sota/cache/<version>/` and re-run.            |
| `npm install` step fails with `Unsupported platform` for an optional dep | The dep author didn't publish a binary for the target. Pin to an older version of that dep, or document the gap.                          |

## License manifest

The packager emits `dist-bundle/THIRD_PARTY_LICENSES.txt` covering
every package found under `vendor/node_modules/`. Ship it alongside
the binary. Re-run the packager after bumping `CLAUDE_CODE_VERSION` /
`CODEX_VERSION` in `scripts/lib/sea-pipeline.mjs` to refresh the
manifest.

`npm run package:all` produces per-target license files
(`THIRD_PARTY_LICENSES-{darwin-arm64,linux-x64,windows-x64}.txt`)
alongside the per-target binaries because the vendored native bins
differ by platform.
