# Offline evaluation baseline

The versioned results in this directory are deterministic regression fixtures, measured locally on Node 22 / macOS arm64. They establish executable behavior checks. They do not measure a live model's coding ability or demonstrate a ranking improvement over lexical search.

| Fixture | Acceptance |
|---|---|
| Retrieval: settings lookup | Expected `loadProjectSettings` is the first semantic result |
| Retrieval: retry lookup | Expected `scheduleRetry` is the first semantic result |
| Freshness: rename / delete | Obsolete definitions disappear and renamed files resolve correctly |
| Negative: different workspace | A database cannot serve another workspace's symbols |
| Persistence: restart | Retained definitions remain and deleted definitions stay absent |
| Task: fix an addition bug | No edit before approval; executable acceptance check passes afterward |
| Edit scope / recovery | Only `sum.cjs` changes; a new store instance restores the original snapshot and can recover the edit |
| Provider contract matrix | Fourteen direct-provider variants complete the same two-turn tool interaction with correct IDs and usage |

The installed runtime suite uses a deterministic embedding server that deliberately returns embeddings in reverse input order. Its recall-at-1 result reflects fixture correctness, not embedding-model quality. The task suite uses synthetic tool proposals; the reported 40 input and 10 output tokens are fixture values, not measured provider billing. Recorded latency is a local observation without a benchmark claim.

After building, regenerate results with:

```sh
SOTA_EVAL_OUTPUT="$PWD/docs/evaluations/retrieval-v1.json" npm run test:sota:offline
cd son-of-anton-core
SOTA_TASK_EVAL_OUTPUT="$PWD/../docs/evaluations/workflow-v1.json" node --test dist/agents/workflow.test.js
```

Before tuning retrieval or claiming agent-quality gains, extend this baseline with reviewed real repository tasks (cross-file fixes, tests and dependency analysis), run lexical/vector/combined retrieval on the same cases, and measure accepted changes, unrelated edits, interventions, latency and cost. Live evaluation requires a chosen provider and task corpus. CI retains the offline outputs and UI screenshots for each run.
