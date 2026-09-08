# System integrations

Settings → Integrations discovers skills, plugins, and MCP server configurations from Claude, Codex, Cursor, and shared `.agents` folders. Search and type filters narrow the catalog; Show Source reveals the originating file or directory. Discovery is read-only. It does not install packages or start discovered servers.

## Supported discovery

- User and current-workspace skill directories under `.agents`, `.claude`, `.codex`, and `.cursor`, including nested skills and symlink deduplication.
- Claude global/project MCP configuration, workspace `.mcp.json`, and the macOS Claude Desktop configuration.
- Cursor user/workspace `mcp.json` with JSON comments and trailing commas.
- Codex `config.toml` under `CODEX_HOME` or `~/.codex`, plus current-workspace configuration.
- Registered Claude plugins, Codex/Cursor plugin caches, and local plugin directories. Plugin skill and MCP components are read; source-application hooks, app tools, and plugin UI are not ported.

The parser supports the documented [Claude plugin](https://code.claude.com/docs/en/plugins-reference), [Claude MCP](https://code.claude.com/docs/en/mcp), [Cursor MCP](https://prod.cursor.com/help/customization/mcp), and [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference) formats. Catalog data is limited to known directories and 2,000 entries, configurations to 4 MiB, and individual skills/resources to 256 KiB. Discovery caches for 30 seconds; Refresh rereads the sources. Invalid files produce visible warnings.

Cached does not mean enabled. Claude plugin enablement includes workspace overrides; Codex plugin availability uses its enabled configuration; Cursor cached plugins remain marked unavailable when activation cannot be established. The catalog selects one latest cached version per Codex/Cursor package; this is not proof of the version running in the source app. The original app remains authoritative for plugin activation and authentication.

## Skills and MCP tools

Native agent tool registries include `list_skills` and `read_skill`. Agents search metadata first and load only relevant instructions and bundled resources. Skill resources must remain inside the canonical installed skill directory. Disabled skills cannot be read through this tool. External ACP agents retain their own capability and tool configuration; discovery does not inject tools into arbitrary third-party processes.

The Claude subscription model transport disables inherited MCP servers and slash commands, and enables customization-safe mode. Son of Anton supplies its own system prompt and exposes discovered resources on demand. This prevents the user's entire source-app catalog from being loaded again into each model request while retaining subscription authentication. See the [Claude CLI reference](https://code.claude.com/docs/en/cli-usage).

Connect selects an MCP descriptor by stable ID. Source environment values and HTTP headers remain host-side; they are not copied into the webview or model catalog. The existing MCP trust gate binds approval to the launch command or remote endpoint, transport, and headers. The UI reports actual ready/error/closed state separately from a saved selection. Disconnect removes the selection.

The shared MCP client supports stdio, Streamable HTTP, and legacy SSE through the official SDK transport. HTTP initialization completes before tool discovery. Schema preservation, tool calls, cancellation, and an authenticated local HTTP session are covered by tests. OAuth sessions owned by another application are not silently reused; a remote server may need its own supported authentication configuration. Third-party endpoints were not all contacted during this review.

## CLI

```sh
sota integrations list
sota integrations list --output json
sota integrations connect <mcp-id>
sota integrations disconnect <mcp-id>
```

The list contains metadata only. Connect configures subsequent CLI sessions; those sessions still require workspace trust. IDE selections live in IDE user settings, while CLI selections live in the CLI configuration. They use the same catalog and stable IDs but do not overwrite each other’s preferences.

`sota mcp doctor` now performs MCP initialization and tool enumeration for configured HTTP servers rather than reporting HTTP reachability as a successful MCP connection.

## ACP adapter registry

**Browse ACP Adapters** in Settings → Integrations or **Anton: Browse ACP Adapters** in the Command Palette reads the [official ACP registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json). Browsing only fetches metadata. Selecting an adapter presents the concrete package or binary plan before configuration; discovery does not start it.

```sh
sota acp-registry list --refresh
sota acp-registry plan claude-acp
sota acp-registry configure claude-acp
sota acp-registry configure <binary-adapter-id> --install
```

Package launches use exact release versions through `npx` or `uvx`. Their runner downloads and executes the pinned package on first use; this does not lock all transitive package dependencies. Binary installs require a registry-provided SHA-256, verify before extraction, reject links/traversal/special files, and install into an isolated cache. Missing checksums make binary installation unavailable. TAR and ZIP extraction are bounded by entry count, expanded size, and time. Metadata is capped at 4 MiB/1,000 entries and cached for 24 hours; archives are capped at 128 MiB, 10,000 entries, and 256 MiB of declared expanded file data. Downloads require HTTPS with bounded redirects and a one-minute timeout.

Configuration saves an ACP launch definition; choose it separately for an agent route or [Council group](council.md). Adapter installation does not transfer source-app authentication, trust, or read-only capability. IDE definitions are saved in IDE user settings and CLI definitions in CLI configuration. During local validation the official metadata parsed 39 adapters, including exact package plans for Claude and Codex; none were installed or started by that discovery check.

## Local verification

The project-root scan found 995 catalog entries, including 399 available skills, 89 plugins, and 34 usable MCP descriptors. The disposable native workspace found 994 because it lacks the project-local launch skill. Three existing skill files have invalid YAML metadata and are reported as warnings. A discovered skill and bundled-resource lookup were verified without executing their instructions. These counts describe configuration discovery, not 34 authenticated connections.
