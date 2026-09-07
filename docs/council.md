# AI Council

AI Council reviews a captured Git diff with independent participants, a separate chair, and an optional final reviewer. Open **Anton: Review with Council** from the Command Palette, chat header, or task board. **Council History** is also available from chat History.

Choose an objective, saved group, and base revision (default `HEAD`). The comparison includes tracked staged and unstaged changes against that revision. Starting a review requires workspace trust and uses the configured model providers or ACP adapters. Each participant gets its own conversation; first-round members cannot see one another's answers. Later rounds see the previous rounds, and the chair synthesizes the available evidence. The final reviewer audits that synthesis and the member reports.

## Results and follow-up work

The panel streams member progress, then renders structured findings with file and line references, disagreements, unanswered questions, and reported token usage. Unsupported or unavailable usage remains unknown. Completion means the configured review stages completed successfully; it does not prove every generated claim is correct.

**Open Evidence** opens the referenced working file. **Captured Review Scope** records the base commit, HEAD, and SHA-256 of the reviewed patch: the working file may have changed since capture. **Export Markdown** opens a local report containing every participant's attribution and available result. Full raw responses are retained in the authoritative JSON report, including partial responses from failed or cancelled stages.

**Add Findings to Board** creates tasks in a separate Council conversation. Repeating the action for the same stage does not duplicate cards. Tasks retain the reviewed digest and require the executing specialist to verify the current code. Promotion does not execute changes. **Run Task** captures the current workspace (including staged, unstaged and nonignored untracked files) and runs the specialist in a retained, detached Git worktree. The task asks for a regression test and relevant compiler/test commands. **Cancel Task** stops execution and keeps partial changes. Failed and interrupted tasks also retain their files.

An edited task moves to **In Review**. **Review Changes** opens a binary-capable patch and lists its files before **Apply Reviewed Changes** can modify the original workspace. Application checks the reviewed SHA-256, HEAD and every affected file against its starting version; conflicting current edits stop application. A recovery checkpoint is persisted before writing, while HEAD and the index stay unchanged. An applied task becomes **Done**; reviewing it again offers checkpoint restoration. Restoration previews the affected files and returns the task to review when confirmed. Unsaved editor buffers must be saved or closed before application/restoration.

Proposals live under the extension's workspace-specific global storage, in `isolated-tasks/<id>/`, with `proposal.json`, `changes.patch`, and `workspace/`. No automatic worktree or checkpoint deletion occurs. Recovery survives host restarts, and crashed operation owners cannot leave a permanent application lock. Patches are limited to 8 MiB and 500 affected files. Isolation protects the original checkout from ordinary edits; an external executable still has its own operating-system permissions and must be trusted. Agent-reported test results require review and are not a host-certified test pass.

Board state and reassignment persist with the report; an interrupted execution is restored as failed so it cannot appear to be running indefinitely. Persisted task execution summaries are capped at 2,000 characters and marked when truncated. Collapsed cards show a bounded title; expand one for the full instruction, evidence and execution summary.

## Saved groups and routes

Use **Edit Groups** or `sota council groups --create` to create an editable `groups.json`. The default Change Review group has code, test, and security members, a quorum of two, one round, concurrency two, a two-minute participant timeout, and a ten-minute run deadline. The final reviewer is opt-in when starting a run. Each member has expertise and a responsibility (`investigate`, `verify`, `challenge`, or `synthesize`). Member, chair, and reviewer IDs must be distinct.

A native participant uses a configured model:

```json
{
  "id": "code",
  "label": "Code Reviewer",
  "expertise": "correctness and architecture",
  "stance": "investigate",
  "model": "sonnet"
}
```

An ACP participant instead names an entry from `sota.acp.agents` and its advertised read-only mode:

```json
{
  "id": "code",
  "label": "Code Reviewer",
  "expertise": "correctness and architecture",
  "stance": "investigate",
  "acpAgent": "local-council",
  "readOnlyMode": "council-review"
}
```

The Son of Anton CLI provides `sota acp --agent anton-docs --read-only`. This dedicated server exposes only `council-review`, skips construction of specialist tools, MCP clients, hooks, and memory services, and refuses mode changes. Configure its launch command as the absolute path to the installed `sota` executable with those arguments. Configure the selected specialist's model in CLI settings; IDE and CLI provider preferences remain separate. The launched CLI also needs trust for its workspace, following the existing CLI trust mechanism.

Native Council model requests expose no tools. ACP Council requests supply no MCP servers or host filesystem/terminal capabilities, deny permission requests, negotiate the required mode before prompting, and cancel if the adapter announces a different mode. An external adapter's read-only mode is a protocol contract, **not an operating-system sandbox**: use an adapter that implements that contract. Registry discovery does not establish that an adapter has a suitable review mode. Mode negotiation follows the [ACP session modes protocol](https://agentclientprotocol.com/protocol/v1/session-modes).

## Persistence and limits

The default directory is `~/.son-of-anton/councils/<workspace-path-hash>`. IDE and CLI share this location for the same canonical workspace path. `sota.council.storageDirectory` overrides it; configure both hosts if overriding. Group files are not overwritten by regeneration. Reports use atomic JSON replacement, private file permissions, and monotonically increasing event sequences. A reconnected panel requests an authoritative snapshot and ignores older events. History sends full details only for the selected report; other rows carry summary metadata. Setup drafts survive webview recreation.

The runner permits 2–8 members, 1–3 rounds, concurrency 1–4, participant timeouts up to ten minutes, and a total deadline up to thirty minutes. Only one Council run is active per host. A participant response is bounded to 64 KiB; the synthesis dossier allocates equal portions of its 48,000-character budget and marks truncation. JSON reports are bounded to 8 MiB, and History exposes the newest 200 reports. There is no automatic deletion of old reports. Finding promotion is capped at 200 cards per report.

The captured diff is limited to 256 KiB. Untracked/ignored files, binary contents, unchanged context outside the diff, and executed test results are excluded. Capture checks HEAD and the diff again before accepting the snapshot and does not modify the index, stash, or refs. This is a review of tracked changes, not a repository-wide test run.

Failed, cancelled, oversized, or invalid responses cannot count toward quorum. Insufficient quorum skips synthesis; chair and final-review failures retain earlier findings with distinct unsuccessful outcomes. Cancellation and deadlines close owned ACP sessions. On restart, a saved run whose owning process exited is marked interrupted. Failed persistence aborts work and surfaces an error while leaving the last successfully written report available.

## CLI

```sh
sota council groups --create
sota council history
sota council run "Review correctness and security" --base HEAD --group change-review --final-review
sota council show <report-id>
sota council show <report-id> --json
```

Run from a trusted Git workspace. `run` writes the report to stdout and progress to stderr; incomplete outcomes return a nonzero exit code. SIGINT/SIGTERM cancel the run and trigger cleanup. Native models and ACP share the same Council engine and durable report format in the CLI and IDE.
