# PR #259 security review

The review addressed CodeQL's model-label property injection finding with `Map` dictionaries and catalog ID filtering in the chat webview. Catalog refreshes cannot overwrite built-in model metadata, special object keys cannot alter dictionary prototypes, and removed catalog entries lose their picker metadata. Browser regressions exercise these cases through the shipped webview.

The impact classifier now uses separate directory and filename predicates, with path-boundary tests for POSIX and Windows. File checkpoints inspect an opened descriptor before reading, compare its identity with the path before and after bounded reads, reject symlinks, and reject substitutions or growth. CodeQL marked these findings and the model-property injection finding fixed on the PR; analysis of review commit `4baa6856bdf` contained only the two configured-provider flows below.

The later completed analysis of review commit `7e43e3af174` (analysis `1747608782`, merge commit `3b7a1f283c09105c54586b90af1a6f516c17b145`) reported zero results without analysis errors or warnings. GitHub marked all five earlier alerts fixed on the PR. The provider-boundary rationale below remains documented; no alert was suppressed or dismissed.

The subsequent analysis of `2e7de85d5bf` (analysis `1747912351`, merge `4e1b074d239888bf4f3351a653e7c5bc6352d08c`) flagged four test-fixture patterns while the five earlier alerts remained fixed. Provider tests now compare parsed URL origins and hostnames exactly. Conversation subprocess tests pass records as data rather than interpolating them into executable code. These changes strengthen the assertions and fixture boundary; the findings were not suppressed or dismissed.

Analysis `1748197929` of review commit `0c64c36550b` (merge `5130a252e4b229f3caea9be94d60bba599c941b5`) confirmed those corrections with zero results and no analysis errors or warnings. All nine prior PR alerts are marked fixed.

The later analysis `1749156061` of review commit `9dd0e693fd2` (merge `7209fe4440d51b53e473534d0d5c680e816cc8cb`, completed September 9, 2026) also reported zero results with no errors or warnings. The merge parents were verified against that exact PR revision and main; all nine alerts remained fixed.

## Provider catalog network boundary

CodeQL alerts [787](https://github.com/CodeHalwell/Son-Of-Anton/security/code-scanning/787) and [788](https://github.com/CodeHalwell/Son-Of-Anton/security/code-scanning/788) trace the CLI's JSON settings reader into the catalog request URL and authorization header. These are intentional uses of a user's configured provider endpoint and credential. The alerts have not been suppressed or dismissed.

- `son-of-anton-cli/src/cliHost.ts` reads the user's own configuration and, when explicitly enabled, plaintext secret storage. Provider discovery selects documented endpoint and credential fields; it does not send those files as request bodies.
- `extensions/son-of-anton/src/providers/ProviderFinder.ts` reads remote discovery endpoints from global or default settings. It honors the legacy workspace Anthropic key and effective local-server URLs. Anonymous local catalogs may use workspace URLs, but credential-bearing LM Studio discovery requires the same full endpoint in User settings. Workspace settings therefore cannot redirect an automatically authenticated catalog request.
- LM Studio inference enforces the same full endpoint binding through live User/default scope inspection, including direct fallback requests without a preceding catalog scan. API keys and nonempty custom headers require that binding. Headers are captured once, and credential-bearing requests reject redirects. Anonymous workspace servers remain usable; the CLI's single-scope configuration remains user-owned. Regression tests cover both environment aliases, stored/settings keys, custom headers, live setting changes and static/discovered routes.
- `son-of-anton-core/src/llm/ProviderDiscovery.ts` sends catalog GET requests without a body, permits HTTPS or explicit HTTP loopback endpoints, and rejects redirects. Credentials are limited to the selected provider's authorization headers. Coding-tool discovery extracts documented model preferences and sign-in-file presence; it does not import those tools' credentials.
- `son-of-anton-core/src/llm/ProviderDiscoverySecurity.test.ts` uses real disposable HTTP servers to verify the exact request, exclusion of unrelated configuration and tool-file contents, absence of secrets in the resulting inventory, and refusal to forward credentials across redirects. Existing discovery tests cover endpoint and response bounds.

A user can intentionally configure a compatible provider or proxy endpoint. That endpoint receives its configured credential; it must therefore be chosen by the user, rather than derived from workspace contents or an untrusted redirect.
