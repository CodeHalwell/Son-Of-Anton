## 2024-04-22 - O(N*M) nested iterations in array filtering for notebook cell selections
**Learning:** Checking for element presence with `Array.prototype.includes()` inside an `Array.prototype.filter()` callback over another large array creates an O(N*M) time complexity bottleneck. This occurs in UI selection logic like notebook cell selections, blocking the main thread when many elements are involved.
**Action:** When filtering a large array against another large array, always convert the target array to a `Set` first and use `Set.has()` instead of `includes()`. This reduces time complexity to O(N+M).

## 2024-05-24 - N+1 Query Problem in Cypher
**Learning:** Found a major N+1 query loop in `services/indexer/src/writers/graphWriter.ts` inside `writeCallSites`, mapping array of calls to sequential db writes. Replaced with `UNWIND`. When testing optimizations with scratchpad benchmark files, always remove them before creating PR to avoid repository pollution and failing code review constraints.
**Action:** Always clean up local scratchpads and benchmark files. Cypher batch modifications are very safe for these graphs when implemented exactly matching original mapping logic.

## 2024-05-25 - O(N*M) lookups in Git optimistic updates
**Learning:** Found nested loops during Git operations (`add`, `revert`, `clean`) when comparing file resource URI paths in array filter closures using `includes()`. This O(N*M) issue is similar to the notebook cells problem, proving this is a recurring codebase-specific performance pattern in extensions when dealing with file resources.
**Action:** When working on extension host array manipulations, especially with large amounts of workspace resource strings (URIs), instinctively apply the `Set.has()` optimization.
## 2024-05-26 - O(N*M) nested loop optimization in User Data Sync configuration

**Learning:** Found nested loops during `registerIgnoredSettingsSchema` initialization where `allSettings.properties` (containing thousands of items) is filtered using `includes()` against `defaultIgnoredSettings` and `disallowedIgnoredSettings`. This is the same codebase-specific performance pattern seen in Git resources and notebook cell selections, causing O(N*M) blocking computation.

**Action:** Consistently use `Set` conversion for target arrays before filtering large sequences (reducing complexity to O(N+M)). Look out for `.filter(x => !array.includes(x))` patterns and proactively optimize them.

## 2024-05-24 - Optimize array filtering over large extension lists
**Learning:** Found nested iteration bottleneck O(N*M) where `.includes()` is called inside `.filter()` repeatedly, especially in extension lists (e.g. `getAllRecommendationsModel` where N=extensions and M=local extensions).
**Action:** Convert the filter condition lists into `Set` structures and utilize `.has()` before doing `.filter()`, mitigating complexity to O(N+M) and improving extension discovery/view rendering performance.
## 2025-02-12 - O(N*M) nested iterations in array filtering for extension recommendations
**Learning:** Found nested loops during extension recommendation list building, where `includes()` is called inside `filter()` using `ignoredRecommendations`. This is similar to previous O(N*M) lookups.
**Action:** Convert the `ignoredRecommendations` arrays to `Set` and use `.has()` instead of `.includes()`, reducing time complexity from O(N*M) to O(N+M). This pattern is especially important for extension lists which can grow large.
## 2024-05-29 - O(N*M) bottlenecks during array filtering in extension lists
**Learning:** When filtering extension arrays against an exclusion list (e.g. `exclude?.length ? extensions.filter(e => !exclude.includes(e.identifier.id.toLowerCase()))`), a nested `Array.prototype.includes()` inside `Array.prototype.filter()` introduces an O(N*M) time complexity bottleneck.
**Action:** Convert the secondary/target array to a `Set` before filtering to reduce time complexity to O(N+M) using `Set.has()`. Apply this optimization especially in components that process extension or notebook recommendations/selections where arrays can become large.
