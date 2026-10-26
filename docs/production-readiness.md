# Shared runtime release readiness

Status: release candidate under validation, not a published or signed production release. Evidence below is observed locally on Linux x64 on 2026-10-26. Cross-platform installers require their own successful native CI runs.

## Verified implementation

- Primary Anton chat, VS Code participants and inline assistance use the shared daemon by default on Unix. Native mode is an explicit compatibility choice, frozen until reload.
- Session switching/disconnect does not cancel durable work. Acceptance, cancellation, replay, sequence gaps, request deadlines, history failures and draft ownership have regression coverage.
- Repository task cards, graph reads/builds and knowledge browsing use authenticated daemon services. Knowledge scopes derive from owned sessions; foreign and missing sessions have indistinguishable refusals.
- Linux sandbox detection checks whether confinement actually works. Tests cover namespace-disabled hosts without allowing an unrestricted fallback.
- Legacy local conversations remain visible and cannot be silently overwritten by shared-session snapshots.
- SDK and runtime build inputs have vendored archives, integrity checks, MIT notices and source provenance. Runtime extraction and artifact replacement are staged atomically.

## Observed evidence

| Boundary | Result |
| --- | --- |
| Rust workspace, all features | 4,055 passed; 9 ignored; no failures |
| Strict Rust workspace Clippy | Passed with warnings denied |
| Generated protocol/SDK | Deterministic generation checked; 492 tests passed |
| Existing Codypendent editor client | 307 tests passed; typecheck passed |
| Desktop frontend | 242 tests passed; TypeScript and Vite build passed |
| Desktop Rust transport | 57 tests passed |
| Complete Tauri app | Release executable and Debian package built with embedded frontend |
| Actual desktop window | Both release executable and freshly extracted Debian package passed SDK-issued run display, disconnect, daemon completion, replay and shared curated memory checks |
| Anton primary extension | 693 unit tests and 82 browser tests passed |
| Built-in extension compilation | Passed |
| Complete Linux IDE distribution | Built successfully |
| Linux IDE installers | Debian package and tarball created; fresh extracted Debian package activated both extensions and queried the bundled graph |
| Shared companion extension | 14 tests passed, including actual daemon/TUI handoff, graph query, knowledge, card supersession and secret-filter refusal |
| Packaged compatibility graph | 28 copied-runtime structural, freshness, overlay, responsiveness and recovery checks passed |
| Installer/release scripts | 35 regressions passed, including package permissions and native ELF selection |

Native GUI checks use a disposable loopback model, a temporary data directory and WebKitGTK WebDriver. The container supplies local development libraries and disables only the fixture renderer sandbox; daemon execution policy remains unchanged. No live-provider correctness, signing or marketplace publication is implied by these tests.

The companion tests exercised the exact release-profile CLI and confined UI-worker launcher shipped in the IDE package. The final board and memory-outcome checks passed against the vendored SDK. Local Linux packages were built on Debian 13; their dependency floors are specific to that host and do not establish compatibility with older distributions.

## Review and remaining release gates

- Run and retain the review branches' native CI evidence for both repositories.
- Obtain native macOS installer, notarization and update/reinstall evidence before advertising a stable macOS release. Windows currently uses native compatibility mode; shared Unix sockets are not advertised there.
- Retain CI evidence and review build/provenance changes before merging or publishing a stable release.

### Modification-tier justification

This change contains Tier 1 additions, Tier 2 integration hooks and Tier 3 changes to existing extension UI and build/installer scripts. The existing chat and inline surfaces need an adapter to use one daemon-owned session instead of starting competing runtimes. The existing assembly hooks must include the companion extension, verified SDK and native runtime in ordinary installers. Package permission normalization ensures installers built under a private umask remain readable and executable by their users; ELF selection avoids shipping incompatible optional native modules. Keeping these changes in the existing assembly path makes installer verification exercise the same product users receive. Senior engineer review is required before merge under the repository's modification-tier policy.

## Known limits

The shared graph is structural and evidence-qualified; it is not a claim of complete semantic impact or automatic test selection. Optional local embedding models have not been downloaded or evaluated in this session. Unknown usage remains unknown. A completed run or a manually moved board card does not establish validation success.

Some legacy local SQLite adapters remain in Codypendent for learning mutations and document/projection paths. Large knowledge queries still need store-level pagination profiling. The editor displays a bounded retained timeline while the daemon keeps the durable history. These boundaries and rollback behaviour are detailed in [shared-runtime.md](shared-runtime.md).
