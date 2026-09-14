# Claude ACP specialist recovery — 2026-09-08

The installed IDE at commit `f364ce23e908a0f28ac8b0787ea4d93fcb0d52ed` failed an approved explanation task because the Claude Code text transport received host tools. The original plan also lost the active-editor snapshot before specialist dispatch.

## Live validation

- Installed the registry's pinned `@agentclientprotocol/claude-agent-acp@0.75.1` package and launched it with Node 22. Existing Claude authentication worked without changing credentials.
- A bounded ACP probe read only the disposable workspace's `README.md`, emitted a real Read File tool update, returned “Conversation rendering check”, and ended with `end_turn`.
- With the user's approval, configured the installed IDE's nine external specialists. The code specialist showed **Managed by ACP** in the sidebar.
- A separate conversation in the previously approved disposable workspace asked Anton Code to read only `README.md`. It returned **The first heading is # Conversation rendering check.** The turn completed and the composer returned to Send. No file edits or shell commands were requested.
- The embedded code graph reported healthy and indexed the two TypeScript fixture files.
- The installed build left the completed tool card labelled Running. This patch normalizes the bridge's `done` status to the webview's `ok` presentation. A browser regression asserts the completed label, icon, and data state. Partial ACP metadata updates also preserve the last status and output.

## Delivery boundary

The installed configuration repairs external tool routing for the current build. Automatic model-based routing, the Claude ACP setup command, editor/provider propagation through approval and review, and the tool-card rendering correction require an updated IDE build. Old plans cannot recover an editor snapshot that was never captured; start a fresh plan with an explicit file path when using the older build.

The patch retains explicit custom adapter routes, pinned direct-API models, forced single-shot planning, workspace trust, and tool approvals. External ACP token usage remains labelled unavailable instead of being treated as zero-cost usage.
