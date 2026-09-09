# Provider discovery and ACP execution review — 2026-09-08

The Finder inventories installed coding software and configured providers, refreshes account catalogs, and registers exact advertised model IDs as executable routes. Catalog access, local software presence, sign-in-file presence, and inference verification are separate facts. It never copies another application's secrets or automatically enables tools, MCP servers, plugins, adapters, or workspace trust.

## Software coverage

Claude Code, Codex, Gemini CLI, Cursor, Visual Studio Code, OpenCode, Aider, Goose, Continue, Cline, Roo Code, GitHub Copilot, Windsurf, Antigravity, Zed, Ollama, LM Studio, and Kimi Code. Detection uses executable presence on PATH, known macOS application paths, known extension installation directories, and documented configuration paths. It does not launch the discovered programs. Desktop application enumeration outside macOS is limited to PATH/extension/config detection.

Only documented model fields are extracted from bounded JSONC, YAML, and TOML configuration files. Authentication payloads are never loaded; only file presence is recorded. Unsupported or malformed configuration still appears as configuration found. Installed software alone does not mean it has an authenticated, tested inference route.

## Catalog contracts

Fifteen HTTP catalogs are implemented, plus configured Z.AI models and explicit deployment/subscription/extension inventory rows.

| Provider | Contract used | Limits and metadata |
| --- | --- | --- |
| xAI / Grok | [REST API](https://api.x.ai/docs/) | `/v1/models`; exact IDs; omitted capabilities/pricing stay unknown |
| Moonshot / Kimi | [List models](https://platform.kimi.ai/docs/api/list-models) | `/v1/models`; exact IDs, context length and explicit image capability |
| MiniMax | [List models](https://platform.minimax.io/docs/api-reference/models/openai/list-models) | `/v1/models`; OpenAI-compatible chat/tool route with complete assistant text retained |
| Z.AI / GLM | [API introduction](https://docs.z.ai/api-reference/introduction) | No account model-list endpoint in the documented API; exact user-provided `sota.zaiModels` remain selectable with unknown capabilities |
| Anthropic | [Models list](https://platform.claude.com/docs/en/api/models/list) | `/v1/models`, `after_id` paging; explicit image capability and context limits |
| OpenAI | [Models API](https://platform.openai.com/docs/api-reference/models) | `/v1/models`; tools, images and pricing stay unknown when omitted |
| Google Gemini | [Models API](https://ai.google.dev/api/models) | `/v1beta/models`, page tokens; `generateContent` filtering |
| OpenRouter | [Models list](https://openrouter.ai/docs/api/api-reference/models/get-models) | Input/output modalities, supported parameters, per-token pricing converted to per-million |
| DeepSeek | [Models list](https://api-docs.deepseek.com/api/list-models) | `/v1/models`; exact IDs |
| Mistral | [Models API](https://docs.mistral.ai/api/endpoint/models) | `/v1/models`; explicit completion/tool/vision flags |
| Groq | [Supported models](https://console.groq.com/docs/models) | `/openai/v1/models`; exact IDs |
| Cerebras | [Models API](https://inference-docs.cerebras.ai/api-reference/models/public-models) | `/v1/models`; unknown fields remain unknown |
| Together AI | [Models API](https://docs.together.ai/reference/models) | `/v1/models`, array response, type and reported pricing |
| Fireworks | [List models](https://docs.fireworks.ai/api-reference/list-models) | Public `accounts/fireworks` management catalog and page tokens; private/dedicated inventory requires account management access |
| Ollama | [List local models](https://docs.ollama.com/api/tags) | `/api/tags`; extension local discovery is enabled by default and can be disabled; no model download/loading |
| LM Studio | [List models](https://lmstudio.ai/docs/developer/rest/list) | `/api/v1/models`; fallback to `/v1/models` on 404; local discovery can be disabled |

Microsoft Foundry / Azure OpenAI and Amazon Bedrock list configured deployment/invocation mappings and explain that account-wide deployment/model enumeration requires management access. Bedrock execution remains limited to the existing Claude adapter. Claude Code and Codex subscription entries explain that subscription access is separate from API credentials. Copilot reports its extension/account entitlement requirement rather than inventing a public API catalog.

ACP models come only from a configured adapter's actual `session/new` or `session/load` response. The selected model is validated against its advertised `availableModels` and set using `session/set_model` before prompting. Discovery never starts an ACP process merely to populate the picker. ACP catalog selections must run through a specialist with that adapter, not the native orchestrator.

## Automatic refresh and explicit verification

Configured HTTP catalogs and already-running local Ollama/LM Studio servers refresh at startup, hourly, on relevant settings/credential changes, and on focus after the one-hour cache TTL. There are four concurrent catalog workers, six-second request deadlines, at most ten pages/10,000 models per provider, and an 8 MiB response limit. Remote endpoints require HTTPS; redirects are rejected. Extension discovery uses User settings for remote endpoints, honors the effective legacy workspace Anthropic key and local-server URLs, and requires an authenticated LM Studio endpoint to match its User setting. Anonymous local catalogs can use workspace URLs; workspace overrides cannot redirect a credential-bearing background request. Failed refreshes retain cached model IDs and report an error. The standalone core API still requires explicit local discovery; the IDE enables it by default under `sota.discovery.localServers`, without starting servers, loading models, or downloading anything. API catalogs may include models without account inference entitlement; a successful list is not a successful inference test.

`Anton: Find Providers and Models` offers selection/setup, including a masked API-key input saved in IDE secret storage. Native catalog selections override a specialist’s adapter pin and unpinned specialists inherit the selected catalog model during approved plan execution. Explicit specialist model pins retain precedence and are resolved from the current profile each turn, so profile changes take effect without rebuilding the agent stack. `sota.verifyProviderModel` explicitly probes one selected HTTP model with a synthetic echo tool, a 30-second deadline, at most 256 output tokens, and no retries. This can incur the provider's normal inference charge. No host filesystem/command/MCP tool is executed. A matching tool call records observed tool support and its verification date for 24 hours across catalog refreshes. An unsuccessful probe preserves unknown capability and reports a redacted reason. Ordinary successful offered tool calls can also record observed support. Images are never assumed supported merely because tool calling was verified.

## ACP recovery, Plan mode and budgets

The IDE composer and host enforce 10 images and a 5 MiB decoded total per message. The reusable core runtime has a separate 24 MiB encoded transport limit. Image prompts require advertised image capability and validated base64 PNG/JPEG/WebP/GIF blocks (10 images and 24 MiB encoded total). Native specialist images follow the same validation and are preserved through provider serialization.

Native Plan turns have no tool definitions. ACP Plan turns require an advertised `plan` mode; mutation permissions are denied before host approval, reported mutation tools abort the turn, and leaving the required mode aborts. This is protocol enforcement for a compliant adapter, not an operating-system sandbox around arbitrary external executables.

Host-owned ACP transcript records persist in global storage, with a bounded 256 KiB recent transcript per conversation/route. Settled sessions use `session/load` only when the adapter advertises it; unsupported/stale sessions receive transcript context in a fresh session. Interrupted sessions are never resumed automatically: their uncertain tool outcomes are recorded as context and no old tool is replayed. Raw image bytes and raw tool inputs are not retained in the recovery transcript. Ordinary conversation release/archive preserves recovery records. Permanent conversation deletion cancels scoped work, waits for its final durable writes, and removes the indexed host recovery records; it does not attempt to erase opaque adapter-owned remote session storage.

ACP runtime/tool-call caps apply even when billing is unavailable. Context occupancy and cumulative session cost retain their protocol meanings; they are not fabricated billed input/output tokens. Budget snapshots distinguish unmetered requests from estimated/reported cost. LlmClient accounting snapshots provide per-request mixed-model estimated cost plus unmetered request counts, so a parent orchestrator cannot present partial API spend as the complete cost of an ACP fan-out. Actual provider billing and subscription invoices remain authoritative.

## Validation

Core TypeScript build passed before tests. The focused suite passed 96 tests covering ACP lifecycle/recovery/images/modes/budgets/advertised model selection, discovery/redaction/cache/local opt-in/pagination/exact dynamic routing, synthetic capability verification, and native provider serialization contracts. The suite includes native Plan/image parity, approval-time runtime/tool budget propagation, orchestrator deadline cancellation, four additional provider tool contracts, Kimi reasoning-content retention, and scoped permanent recovery deletion. Validation uses disposable local fixtures and mocked HTTP responses; it does not claim live account inference validation for every provider. Extension compilation and live UI checks are performed by the parent task.

Additional provider compatibility follows [Kimi reasoning retention](https://platform.kimi.ai/docs/guide/use-thinking-models) and [MiniMax OpenAI compatibility](https://platform.minimax.io/docs/api-reference/text-openai-api). Kimi/Z.AI reasoning content is retained internally for subsequent tool-result messages. Coding Plan and general API endpoints/keys stay separate; no subscription entitlement is inferred from a successful catalog listing.
