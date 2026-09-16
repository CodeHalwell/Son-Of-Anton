# Son of Anton real-user acceptance test — 14 September 2026

**Retest result: the four blocking workflows found in the first walkthrough are fixed.** The rebuilt macOS desktop now supports live Codex chat, complete Council reviews and export, board task execution, and checkpoint file comparison. Additional fixes cover specialist selection, unavailable usage, cancellation presentation, board checklist updates, and failed tool results.

## Fix and retest round

The initial findings below are retained as reproduction evidence, not the current status.

| Change | Verification |
| --- | --- |
| Replaced the guessed Codex arguments and Claude event parser with `codex exec --json`, stdin conversation history, developer instructions, JSONL assistant/usage/error events, and cancellation/error cleanup | Five process-level regressions pass. Installed Codex 0.154.0 returned `Codex connection works.` through the adapter. The desktop **Codex CLI Default** selection returned “Hello. What can I help with?” and token usage. |
| Replaced unsupported GPT-5 subscription picker entries with the installed CLI’s default | A live request confirmed the older `gpt-5` ID is rejected by this account; the default succeeds. Older IDs remain readable for saved history. |
| Corrected Council's message-origin check for VS Code's hidden parent window | Saved Group populated with Change Review; Start Review became enabled. All three live Codex member reviews and chair synthesis completed; Export Markdown opened the report. Report `9ac80240-08c8-4779-b9c4-b1c1acc0e6bd` is retained in the fixture's Council storage. |
| Replaced approval of a cleared plan with selected saved-task execution | Run Task moved Ready → Running → Done, requested the expected edit/test approvals, fixed `cart.js`, and passed both tests. Independent `npm test` also passed 2/2. Run Again started a second real execution. |
| Scoped board actions to the displayed conversation; added visible cancellable progress and retryable failure states | Regression tests cover conversation identity, completed dependency context, provider failure, cancellation, and a declined tool followed by a final response. A declined command can no longer be marked Done simply because the agent replies. |
| Opened per-file `vscode.changes` comparisons instead of a directory diff | The real editor displayed the before/after `cart.js` change. Regression covers edits, added/deleted files, and captured untracked files, including Git's default mixed untracked-file display. Final desktop retest confirmed the captured untracked file is no longer marked deleted. |
| Synchronized roster selection with the host and composer placeholder | Selecting Anton Docs updated the active specialist and placeholder immediately while preserving the draft. |
| Corrected usage detection through dynamically routed ACP agents | A real Anton Code subscription reply displayed **Usage Unavailable** in both task and session meters, instead of misleading zero counts. |
| Settled running tool cards on cancellation and synchronized chat checklists from board snapshots | Browser regressions confirm stopped cards have no Running status and a settled planning response follows subsequent board completion. |
| Clarified missing Anthropic API credential errors | The error now explains that Claude Code subscriptions use the separate model picker option. API and subscription authentication remain distinct. |

Validation after the fixes: **653 passing automated checks** (150 core, 437 extension, 42 browser/webview, 22 CLI, 2 offline graph). Core compilation, extension TypeScript checking, `gulp compile-extensions`, and the extension bundle build passed. Test logs are `/tmp/sota-fixes-{core,extension,ui,cli,graph}-tests.log`; build logs use `/tmp/sota-fixes-*`.

The test profile and fixture remain open for inspection. The fixture now contains the verified quantity fix. Its generated `.son-of-anton/metrics` data is also retained. The completed Council report also survived the final application reload. Council's temporary model changes were restored to the original saved group after the successful review. No changes were committed, pushed, deployed, or published.

## Environment and method

- Current local working copy, editor version 1.112.0, base commit `1dc6348acb5`, including existing uncommitted changes. This was the rebuilt development application, not a newly downloaded installer.
- macOS arm64, Electron 39.6.0; Node 22 used for application build checks. Installed Codex CLI: 0.154.0.
- Actual desktop interaction through native controls: chat, model picker, command palette, terminal, task board, Source Control, settings, and checkpoint menus. Live model requests were made; no synthetic model responses were used for this walkthrough.
- Disposable workspace: `/tmp/sota-real-user-20260914` (canonical path `/private/tmp/sota-real-user-20260914`). Isolated app profile: `/tmp/sota-real-user-profile-20260914`.
- Fixture: four-file JavaScript project with `cartTotal(items)` incorrectly summing prices without quantities. `npm test` initially had one passing and one failing test (actual 16, expected 44).
- Existing Claude Code sign-in was used. The application's Configure Claude ACP flow added the pinned `@agentclientprotocol/claude-agent-acp@0.76.0` adapter to the test profile. No credentials were copied into the report.
- Application source was not changed during the initial walkthrough; the subsequent fix round modified and rebuilt the application. Agent edits were confined to the disposable fixture. No changes were published or pushed.

## Initial confirmed defects (fixed in the retest round)

### P1 — Codex subscription requests fail before generation

1. Open chat and select **GPT-5 via Codex CLI**.
2. Send: “Please read cart.js and cart.test.js. Explain why the quantity test fails. Do not modify any files yet.”
3. The response reports `Codex CLI exited 2: error: unexpected argument '--system-prompt' found`.

The installed CLI's help confirms its noninteractive interface is `codex exec`, while `son-of-anton-core/src/llm/codexRunner.ts:117` constructs Claude-style `--system-prompt`, `--output-format stream-json`, `--max-turns`, and `-p` arguments. This is an application integration failure, not evidence of an authentication failure. Codex live generation, tools, and recovery could not be validated beyond this point.

### P1 — Council stays in its initial loading state

1. Open **Review with Council** in either the main repository or the fresh fixture.
2. Observe an empty Saved Group picker, disabled Start Review button, and “Loading Council reports…”.
3. Click **Refresh**. No recovery occurs.
4. Click **Edit Groups**. A valid-looking default `groups.json` opens, proving the action reaches the host.
5. Reload the window and reopen Council. The loading state remains.

Reproduced in two separate profiles/workspaces, including the fresh profile after reload. Council cannot start a review through the tested UI. Member responses, synthesis, export, evidence navigation, and promotion to the board are therefore blocked in this live test.

Investigate the host-to-webview state path in `extensions/son-of-anton/src/council/CouncilController.ts:77` and the message filter in `extensions/son-of-anton/media/council.js:63`. The exact root cause was not established; the presence of a rendered form and working Edit Groups button must not be treated as a successful Council test.

### P2 — Checkpoint comparison opens a directory as a text file

1. Complete a coding request that changes `cart.js`.
2. Open the checkpoint menu on that request and choose **Compare with current**.
3. The editor says: “The editor could not be opened due to an unexpected error.”
4. **Show Logs** reports that `/tmp/sota-real-user-20260914` is actually a directory and cannot be read as a file.

`extensions/son-of-anton/src/chat/ChatPanel.ts:2716` passes the workspace root and its Git URI to `vscode.diff`, rather than providing file pairs or a supported multi-file comparison. This prevents users from inspecting checkpoint changes through that control. Ordinary Source Control file diffs work.

### P2 — Board Retry / Run Task does not execute the task

1. Generate a one-task plan using **Sonnet via Claude Code** before configuring the ACP adapter.
2. Send `/approve`; the task fails with the actionable missing-adapter error.
3. Run **Anton: Configure Claude ACP** and complete its pinned-package configuration flow.
4. Open **Tasks → Open Full Board → Retry → Run Again**.
5. The task moves from Failed to Ready. No execution starts.
6. Click **Run Task**. The task remains Ready, the app remains idle, and no new response or error appears.

A direct Anton Code request succeeded immediately afterward using the configured adapter, so provider unavailability does not explain the silent board behavior. Investigate board dispatch/retry routing through `extensions/son-of-anton/src/extension.ts:882` and `runApprove` at line 964. Root cause beyond this boundary was not established.

## Other observations from the initial walkthrough

- **Default provider friction:** the status bar reports “Connections Configured,” but the initial Sonnet request fails with “No Claude credentials configured.” Settings lists Anthropic as not configured even after a successful Claude Code subscription turn. The status tooltip distinguishes installed CLIs from verified authentication, but the default selection and provider cards do not guide a new user to the working route.
- **Cancellation presentation:** Stop generating returns the app to idle and allows another successful request, but unfinished tool cards retain `RUNNING` labels beside “Response Stopped.”
- **Specialist placeholder:** switching from Anton Code to Anton Docs via the roster changes the picker and active-specialist label but leaves the composer placeholder saying “Anton Code is here — what should we build?”.
- **Usage ambiguity:** the first Claude planning turn added 456 tokens. Subsequent ACP coding work left the displayed totals unchanged, and the second conversation displayed zero tokens after a live answer. Treat these figures as incomplete; provider billing was not independently measured.
- **Read-only request behavior:** the cancelled review request said not to run commands, but the agent executed a read-only `find … | head -50` command before cancellation. No fixture edits resulted from that request. This is an observed agent-instruction compliance issue, separate from the cancellation mechanism.

## Workflow results

| User workflow | Result | Evidence / limit |
| --- | --- | --- |
| Open fresh project; view source | Pass | Explorer showed all four files; `cart.js` opened in the editor. |
| Integrated terminal | Pass | Ran `npm test` before and after the fix; observed expected failure, then 2/2 passing. |
| Git integration | Pass | Initial clean repository, one modified file after generation, normal working-tree diff. |
| Embedded graph | Pass | Fixture indexed automatically: 2 source files, 1 symbol; refreshed after edits. |
| Workspace trust | Pass | First live turn prompted for trust; session trust was requested again after window reload. |
| Default Sonnet request | Configuration failure | Missing Claude API credentials; visible error rather than a hang. |
| Model picker and search | Pass | Searched for Codex and selected subscription routes. |
| Reuse Prompt | Pass | Restored text and previous model; switching provider after reuse worked. |
| Live Claude planning | Pass | Returned a one-task plan and populated the Tasks tab. |
| Plan execution before adapter setup | Expected setup failure | Explained which command to run to configure the adapter. |
| Configure Claude ACP | Pass | Displayed package/version and download behavior; completion required no reload. |
| Board failed/ready state display | Pass | Failed task and explanation appeared; retry changed its state. |
| Board retry and execution | Fail | Run Again / Run Task did not execute the ready task. |
| Direct live coding | Pass | Anton Code read both files, changed `price` to `price * quantity`, and ran `npm test`. |
| Independent verification of generated code | Pass | Source Control showed the single-line fix; integrated-terminal rerun passed both tests. |
| History search | Pass | Nonmatching search showed zero conversations and Clear Filters recovered the list. |
| Draft preservation | Pass | Draft survived tab navigation, opening another conversation, and window reload. |
| Conversation persistence | Pass | Both conversations appeared in history; reopening restored transcript, specialist, and model. |
| Window reload | Pass for chat | Existing conversation and unsent draft restored. Council remained broken. |
| Checkpoint comparison | Fail | Directory-as-file error in the editor and Window log. |
| Checkpoint restore | Pass | Confirmation named `cart.js` and retained recovery state; restore returned it exactly to original contents. Independent `git diff --exit-code` returned clean. |
| Cancel live generation | Pass with display defect | “Response Stopped”; app returned to idle. Some tool badges remained RUNNING. |
| Continue after cancellation | Pass | Next live request, “Without using tools, answer with just the result of 2 + 2,” returned `4`. |
| New conversation isolation | Pass | New transcript and usage display reset; original conversation and draft remained accessible. |
| Terminal preferences | Pass | Changed line cap from 100 to 270, navigated away/back, verified 270 persisted; restored 100. |
| Integration discovery/search | Pass for browsing | Loaded 951 discovered entries, showed 3 configuration warnings, and filtered by search. No third-party integrations were connected. |
| Specialist roster | Pass with placeholder defect | Talk to Anton Docs selected Anton Docs and preserved the draft. |
| Current-file and terminal attachments | Pass for staging/removal | Both attachment chips could be added and removed. Attached payload delivery was not separately tested. |
| Council review | Blocked | Stuck initialization prevents end-to-end use. |

## State after the initial test (superseded by the retest above)

- The fixture was restored to its original, intentionally failing implementation; the successful fix and test result remain in the first conversation. Its Git working tree was independently verified clean after restore.
- Test conversations and checkpoints are retained for reproduction. The terminal line-cap preference was restored to 100; test attachments were removed.
- The isolated test profile retains the configured Claude adapter. The final UI exposes the Council loading failure for inspection.
- Main run logs: `/tmp/sota-real-user-profile-20260914/logs/20260914T121513/`.
- Checkpoint comparison error: `window1/renderer.log`, timestamp 12:23:43.986, also viewed through the app's Show Logs action.

## Coverage limits

This was a broad macOS desktop acceptance walkthrough, not exhaustive validation of every supported platform and provider. Installer/signing/update flows, Windows/Linux, remote development, debugging/breakpoints, paid API providers, external service connections, semantic embeddings, image uploads, and long-duration workload behavior were not exercised. No claim is made that the other specialist roles were individually tested against live models. The retest exercised Council review and export. Proposal promotion was not exercised live because the review reported no confirmed findings. Codex tool execution through a separate ACP adapter was not tested; the repaired CLI route is a text transport.


## Latest native worker candidate: interactive follow-up

The previously locked desktop became available for native interaction. The installed worker candidate showed semantic search ready. Clicking code graph → Restart displayed starting, then returned to healthy/semantic ready with two files and one symbol (15:38:16). The integrated terminal ran `npm test` successfully: two tests passed and zero failed. Opening AI Council displayed the saved review as Completed, with all four stages and their original responses preserved. These checks used the packaged application and the preserved `/tmp/sota-real-user-20260914` fixture. No new model requests were needed for this persistence check. This closes the pending visual check for the latest macOS worker candidate; distribution signing and other-platform installation checks remain separate.

## Provider-limit candidate: latest desktop check

After rebuilding and verifying the fresh DMG with bounded provider requests, the app was reopened on the same preserved test profile. Council restored its completed four-stage report. Opening `cart.js` showed the saved quantity fix, semantic search reached ready with two files and one symbol (16:06:56), and integrated-terminal `npm test` passed 2/2 with no failures. This is the candidate recorded by `2026-09-14-provider-recovery-verification.json`.
