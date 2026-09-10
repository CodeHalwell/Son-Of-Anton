# Installed IDE review — 10 September 2026

Tested the installed macOS application at commit `6fe880fb4356d886099ef233e1ffaef103fbe091` using native computer-use controls. Tests used an empty window and a previously approved disposable workspace containing a README and a TypeScript function. The installed application was not modified by these source changes.

## Findings addressed in this change

| Finding | Reproduction and effect | Change |
| --- | --- | --- |
| ACP model picker is locked | Choose a specialist assigned to an ACP adapter. Composer and specialist settings disable model selection and show “Managed by ACP”. | Keep both pickers enabled, offer advertised ACP and discovered provider routes, display the chosen model or the adapter default, and refresh the catalog after an ACP turn. Hide bundled overrides that the adapter cannot honor, including saved values restored by settings or catalog refreshes. |
| No project folder produces a dead-end trust error | Send to Anton Code in an empty window. The turn fails with “ACP agents require a trusted workspace”; there is no setup action beside the draft. | Explain missing folder versus untrusted workspace in the composer, provide Open Folder / Review Workspace Trust actions, retain the draft, and enforce preflight in the host before hooks, context or persistence. |
| Blank native response reported as completed | A live Gemini request completed in about two seconds with a blank assistant body, zero reported tokens and a completed task in Traces. | The Google parser demonstrably discarded CRLF-framed and unterminated final events and accepted empty/error streams as success. Fix those paths and test fragmented UTF-8, tool calls and usage. A live rerun on the updated installer is still required to establish whether this accounts for the observed request. |
| Board opens the wrong chat section | Select Tasks, open Full Board, then Open Chat. The new editor pane also shows Tasks. | Explicit Open Chat switches the editor chat session to its Chat tab, including when a pane already exists. |
| History search changes the active conversation title | Filter out the active conversation; the title changes to “New Conversation” even though the transcript remains active. | Read only the active manifest asynchronously, independently of search results, without rescanning history or loading the transcript. Cancel superseded lookups and isolate damaged metadata. |
| Empty search says no conversations exist | Search for a nonexistent term in populated History. | Show the no-matches state and Clear Filters instead of the first-use empty state. |
| Provider descriptions advertise obsolete model families | API settings still describe OpenAI/Gemini using old generation lists despite newer discovered options. | Describe discovery and supported provider use without a fixed generation list. |

The regression test for workspace setup also exposed that the mouse event was being passed as the `renderOnly` flag to Send. The click handler now passes no event argument, so mouse and keyboard sends use the same preflight.

## Other observed issues requiring follow-up

- Usage totals are scoped to a panel lifetime. Reopening the same transcript in another pane, or branching, shows zero session turns/cost while the transcript/header retains incomplete usage. The scope needs clearer labeling or shared persisted accounting; zero must not imply a free historical run.
- Anton Review appears in Specialist Models and the configured ACP route list but is absent from the Roster and composer specialist menu. Anton Spec is present in the Roster but absent from Specialist Models.
- Branching the successful ACP response restored its text, table, code and feedback, but omitted the read-tool card. Durable tool-event rendering needs separate attention.
- In an empty editor, “Add Context → Current File” creates a generic attachment chip even though there is no current source file. It should explain the unavailable source.
- About labels the extension version `0.1.0` as “Version”, which does not identify the IDE build used for installer troubleshooting.

## Manual coverage

- Chat, Tasks, History, Settings and Roster tabs; sidebar and editor chat surfaces.
- All nine Settings sections inspected: API Configuration, Models, Specialist Models, Features, Personality, MCP Servers, Integrations, Terminal and About.
- History search, workspace filtering and Clear Filters; specialist selection; context menu and current-file attachment; new workspace conversation.
- MCP Add, empty-form Save validation and Cancel. Integration search and configuration warnings (994 discovered entries, three metadata parsing warnings). Update check returned no newer stable release.
- Full board and board sidebar empty states; Full Board, Refresh and Open Chat actions; Agent Status, Task Queue, task-to-Traces navigation.
- Code graph became healthy and indexed one source file / one symbol in the disposable workspace. Semantic search was disabled, so no semantic retrieval claim is made.
- Live native and ACP requests compared. ACP read only the test README, returned its marker, and rendered a tool card, Markdown table and TypeScript code block. Tool output expansion, code Copy, Open in Editor, feedback, Reuse Prompt, Undo and Branch Here worked. The generated unsaved preview was discarded.

This is a bounded review, not proof that every button and execution path is bug-free. Destructive history/settings actions, purchases, authentication changes, deployment/publishing, external MCP execution, native Windows/Linux behavior, and nonempty board execution were not exercised on the installed app in this pass. Existing automated suites cover additional fixture-based interactions.

## Automated validation

Core compilation, extension and webview type checks, built-in extension compilation and the extension bundle completed successfully. The initial change passed 404 core tests. Following review fixes, the full extension and browser suites passed 685 and 78 tests respectively; core source was unchanged in that follow-up. Regression coverage includes asynchronous title lookup, cancellation and damaged metadata, catalog refreshes after ACP versus native turns, and restoring saved model selections. Browser fixtures exercise the shipped webview code; they do not replace the live native model rerun called out above.
