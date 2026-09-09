# PR #259 security review

The review addressed CodeQL's model-label property injection finding with `Map` dictionaries and catalog ID filtering in the chat webview. Catalog refreshes cannot overwrite built-in model metadata, special object keys cannot alter dictionary prototypes, and removed catalog entries lose their picker metadata. Browser regressions exercise these cases through the shipped webview.

The impact classifier now uses separate directory and filename predicates, with path-boundary tests for POSIX and Windows. File checkpoints inspect an opened descriptor before reading, compare its identity with the path before and after bounded reads, reject symlinks, and reject substitutions or growth. CodeQL marked these findings and the model-property injection finding fixed on the PR; analysis of review commit `4baa6856bdf` contained only the two configured-provider flows below.

The later completed analysis of review commit `9a6343a6f0bc` (analysis `1747435212`, merge commit `1b6b0bca6c7363be49c11415f0885c7e38521eec`) reported zero results without analysis errors or warnings. GitHub marked all five earlier alerts fixed on the PR. The provider-boundary rationale below remains documented; no alert was suppressed or dismissed.

## Provider catalog network boundary

CodeQL alerts [787](https://github.com/CodeHalwell/Son-Of-Anton/security/code-scanning/787) and [788](https://github.com/CodeHalwell/Son-Of-Anton/security/code-scanning/788) trace the CLI's JSON settings reader into the catalog request URL and authorization header. These are intentional uses of a user's configured provider endpoint and credential. The alerts have not been suppressed or dismissed.

- `son-of-anton-cli/src/cliHost.ts` reads the user's own configuration and, when explicitly enabled, plaintext secret storage. Provider discovery selects documented endpoint and credential fields; it does not send those files as request bodies.
- `extensions/son-of-anton/src/providers/ProviderFinder.ts` takes discovery endpoints from global or default settings. Workspace settings cannot redirect an automatically authenticated catalog request.
- `son-of-anton-core/src/llm/ProviderDiscovery.ts` sends catalog GET requests without a body, permits HTTPS or explicit HTTP loopback endpoints, and rejects redirects. Credentials are limited to the selected provider's authorization headers. Coding-tool discovery extracts documented model preferences and sign-in-file presence; it does not import those tools' credentials.
- `son-of-anton-core/src/llm/ProviderDiscoverySecurity.test.ts` uses real disposable HTTP servers to verify the exact request, exclusion of unrelated configuration and tool-file contents, absence of secrets in the resulting inventory, and refusal to forward credentials across redirects. Existing discovery tests cover endpoint and response bounds.

A user can intentionally configure a compatible provider or proxy endpoint. That endpoint receives its configured credential; it must therefore be chosen by the user, rather than derived from workspace contents or an untrusted redirect.
