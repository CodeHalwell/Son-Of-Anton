## 2026-04-19 - Command Injection in freePortKillProcess
**Vulnerability:** The `port` string extracted via regex from the terminal output was passed directly into a `child_process.exec()` call (`netstat -ano | findstr "${port}"` or `lsof -nP -iTCP -sTCP:LISTEN | grep ${port}`). An attacker who could inject text into the terminal matching the regex could supply a malicious port string like `8080; touch /tmp/pwned` to achieve arbitrary code execution.
**Learning:** Even internal RPC functions processing regex matches from known outputs can be vulnerable to injection if the underlying regex is loose or if the input isn't explicitly sanitized before being passed to shell commands.
**Prevention:** Always use strict validation (e.g., `/^\d+$/`) on parameters before inserting them into `exec()` or use `execFile()` to bypass the shell completely.

## 2026-04-20 - Command Injection in Process Utilities
**Vulnerability:** Command injection was possible in `src/vs/base/node/ps.ts` where unvalidated array elements (PIDs) and paths were interpolated or directly passed into `child_process.exec`.
**Learning:** Developers attempted to sanitize dynamic inputs by passing paths through `JSON.stringify()`, expecting it to escape spaces. However, double quotes do not prevent shell evaluation like `$()` command substitution, maintaining the injection vector.
**Prevention:** Always refactor to `child_process.execFile` when working with system commands. It bypasses the shell completely, eliminating the injection class entirely while robustly handling paths with spaces natively without hacky string-escaping.

## 2026-05-02 - Command Injection in Git Blame Extension
**Vulnerability:** Command injection was possible in `extensions/son-of-anton/src/personality/GitBlameEasterEgg.ts` where unvalidated file paths were directly interpolated into a `child_process.exec` shell command (`git blame --porcelain "${filePath}"`). A workspace path like `"; touch /tmp/pwned; #` would execute the payload.
**Learning:** Even internal API data that seems safe like file paths from `vscode.Uri` can contain malicious shell metacharacters and should be treated as untrusted input.
**Prevention:** Always refactor to `child_process.execFile` when executing binaries like git to bypass shell evaluation and safely pass arguments natively.

## 2024-05-19 - Command Injection in Terminal Suggest
**Vulnerability:** Command injection vulnerability identified in `extensions/terminal-suggest/src/fig/autocomplete-parser/parseArguments.ts` where user-controlled strings (from the shell context) were interpolated into a bash string argument for `child_process.exec`.
**Learning:** Even though `command` was wrapped in double quotes `"${command}"`, `bash` command interpolation evaluates any nested commands (e.g., `$()`) inside double quotes, which can lead to command injection.
**Prevention:** Direct use of `child_process.execFile` instead of `exec` guarantees arguments are properly tokenized before execution and passed as CLI argument arrays instead of a concatenated shell string. Always use `execFile` where execution environment shell parsing is not implicitly required.

## 2025-05-16 - Prevent Command Injection via AppleScript's do shell script with osascript
**Vulnerability:** Constructing `osascript` commands using string interpolation of paths into an AppleScript `do shell script` string (e.g., ``osascript -e "do shell script \\"rm \'${path}\'\\" with administrator privileges"``) is vulnerable to command injection if the path is user-controlled or malformed, even if escaped with single quotes.
**Learning:** Migrating to `execFile('osascript', ...)` alone is insufficient if the script payload remains a single interpolated string block.
**Prevention:** Always refactor the `osascript` payload to use an `on run argv` block, pass the dynamic parameters as trailing array elements after `--`, and strictly evaluate them inside AppleScript using `quoted form of (item N of argv)`.

## 2025-05-26 - Eliminate Command Injection Risk in ptyService
**Vulnerability:** Found `child_process.exec` being used with string interpolation for `netstat` and `lsof` commands.
**Learning:** Even when inputs are validated (e.g. `!/^\d+$/.test(port)`), using `exec` exposes the system to potential shell expansion and injection risks.
**Prevention:** Replace `child_process.exec` with `child_process.execFile` whenever possible to avoid shell execution. For shell pipes (like `| findstr` or `| grep`), implement the filtering in JS or use specific command flags (like `lsof -iTCP:<port>`).
## 2026-06-01 - Command Injection in WorktreeManager
**Vulnerability:** Found `child_process.exec` being used to execute git commands in `extensions/son-of-anton/src/parallel/WorktreeManager.ts` where string inputs like `agentId`, `branch`, and `commitMessage` were interpolated into the command strings.
**Learning:** Even if developers attempt to escape quotes (e.g., `commitMessage.replace(/"/g, '\\"')`), using shell interpolation for arguments like git branch names or commit messages is inherently unsafe, as an attacker could inject shell operators to achieve command execution.
**Prevention:** Always refactor to use `child_process.execFile` instead of `exec`, passing variables as an array of discrete arguments, which completely bypasses the shell parser and eliminates command injection risks natively.

## 2024-05-31 - TraceViewerPanel XSS Fix
**Vulnerability:** Found unsanitized dynamic fields (`span.id` and `span.type`) directly embedded into the webview's HTML generation in `TraceViewerPanel.ts`.
**Learning:** Even internal backend IDs and types can contain malicious payloads if compromised or manipulated before display, leading to XSS inside VS Code webviews.
**Prevention:** Always use the internal `escapeHtml` string sanitizer function on all dynamic data injected into HTML strings, even for supposedly "safe" fields like identifiers or types.

## 2026-06-03 - Cypher Injection in Memory Graph
**Vulnerability:** Found `db.query` calls in `services/mcp-gateway/src/tools/memoryQuery.ts` where values like `params.type`, `id`, and `now` were being interpolated directly into Cypher query strings instead of parameterized. Wait, what about labels? Cypher graph labels like `(:Decision)` cannot be parameterized normally in Neo4j/FalkorDB.
**Learning:** In FalkorDB/Neo4j, while values should always be parameterized (e.g. `$content`), node labels (like `:${params.type}`) cannot be parameterized via query parameters. If a label is user-controlled and directly interpolated, it allows Cypher injection.
**Prevention:** For node labels or property keys that cannot be parameterized in Cypher, always validate them against a strict predefined allowlist before interpolation to prevent Cypher injection vulnerabilities. Always use query parameters for standard values like `$id` and `$createdAt`.
## 2026-07-20 - Command Injection / Path Hijacking in terminalProfiles.ts
**Vulnerability:** Found `cp.exec('wsl.exe -l -q', ...)` being used to query WSL distributions. Hardcoding the binary name `wsl.exe` and running it through a shell (`exec`) instead of using the resolved absolute path allows an attacker to perform PATH hijacking (Untrusted Search Path) or command injection.
**Learning:** Even if a binary seems like a safe standard OS utility, executing it without its absolute path in an `exec()` shell environment exposes the application to environmental manipulation.
**Prevention:** Always refactor `cp.exec` to `cp.execFile` and use explicitly resolved absolute paths (like `wslPath` from `findExecutable`) to guarantee execution of the intended binary and bypass shell interpretation entirely.
