# IDE distribution, integrations and graph capabilities

The command palette exposes **Check for IDE Updates**, **Choose an Earlier IDE Installer**, **Manage Integration Profiles**, **Integration Sources and Conflicts**, and **Service Diagnostics**. These commands use the same workspace trust and MCP approval gates as chat.

## Updates and extension installation

Set `sota.updates.channel` to `stable` or `preview`. Preview includes published stable releases. `sota.updates.checkOnStartup` is opt-in and only checks for releases; downloading and opening an installer are separate user actions. Downloads are streamed into the extension's private storage, bounded to the published byte count, verified with SHA-256, and discarded on a mismatch or cancellation. When GitHub supplies an asset digest, it must agree with the build manifest. No update silently replaces the running app. The earlier-installer command selects releases published before the current build date and uses the same verification path; user data stays in its existing location.

Production stable releases require Developer ID signing **and notarization** for both macOS architectures and Authenticode signing for Windows. The existing signing secrets must be configured before a stable native build can succeed. Linux packages retain checksum verification and GitHub build-provenance attestations. Workflow dispatch defaults to preview. Releases remain drafts until a maintainer publishes them; the update checker never offers drafts. Legacy releases without the manifest needed for verified updates require a manual download.

The built-in Extensions view now searches and installs from [Eclipse Open VSX's official VS Code adapter](https://github.com/eclipse-openvsx/openvsx/wiki/Using-Open-VSX-in-VS-Code). Standard editor installation, compatibility and extension-update controls remain in use. Extensions restricted to Microsoft's distribution or unavailable in Open VSX are not made compatible by changing the gallery. Install a compatible publisher-provided VSIX when appropriate. The update metadata uses [GitHub's documented release and asset API](https://docs.github.com/en/rest/releases/releases).

## Project integration profiles

Profiles are stored in host workspace state, keyed by project root. They do not write launch commands or credentials into the repository. A new profile snapshots current agent model/ACP routes, discovered enabled skills and plugins, and explicitly connected MCP IDs. Users can activate a profile, change its selected capabilities, recapture current configured routes, or return to global configuration. Existing global integration selections work until a profile is explicitly activated.

Selecting a plugin enables its supported skill resources. MCP servers require their own selection and the existing trust gate. A profile cannot re-enable a source-disabled skill, plugin, or MCP server. Launch credentials remain in the original source configuration. The catalog refreshes periodically; changes in source credentials trigger reconciliation without exposing the credentials in the report. The origins report lists duplicate names separately with source, scope, path and version, plus observed additions, removals and configuration changes.

## Diagnostics

Service Diagnostics combines observed graph status, MCP connection state, background-task HTTP health and existing health-monitor samples. Missing or stale observations are unknown. ACP handshake validation is an explicit action because it launches configured adapters. Actions open the relevant configuration, logs, graph reindex/restart or MCP reconnection. Retrying connections also recovers previously closed connections with unchanged configuration; healthy connections are preserved.

## Unsaved graph context and impact evidence

`sota.codeGraph.editorOverlay` enables in-memory dirty-document snapshots for the bundled embedded graph. The host sends snapshots only to an already-connected stdio server matching the embedded command; HTTP graph servers never receive them. Document versions and snapshot revisions reject stale updates. Save, close, disable and workspace changes remove buffers from the overlay. Buffers are bounded to 256 KiB each, 32 supported code documents and 2 MiB total, and are never written into SQLite or sent to an embedding endpoint.

Language-server outlines replace saved outlines and symbol hits for dirty files. Search suppresses stale saved snippets from overlaid files and returns local text matches with `source: unsaved-editor`, document version and `retrieval: local-text-match`. These scores are text-match scores, not vector similarity. Files without a symbol provider can still contribute text matches. Persisted file-dependency queries remain explicitly identified as saved graph evidence.

Impact analysis first requests the editor's [documented call hierarchy commands](https://github.com/microsoft/vscode-docs/blob/main/api/references/commands.md). Results carry real incoming caller names, source lines and intermediate call paths, with three-hop, 80-node and time limits. Test-file callers are grouped by filename after a real provider call edge has been found; this is dependency evidence, not measured coverage. Unsupported languages fall back to actual native file-dependency paths and make that limitation visible. Source navigation resolves known result paths and opens the caller's source line where available.
