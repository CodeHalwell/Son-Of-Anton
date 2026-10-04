## 2026-10-04 - Optimize Array filtering with Set for lookup
**Learning:** In highly interactive components (like debug panels or SCM diff widgets), using `Array.includes()` or `Array.indexOf()` within an `Array.filter()` callback leads to O(N*M) nested iterations. This happens often when filtering a list of elements based on another list of IDs.
**Action:** Convert the lookup array into a `Set` outside the `filter` callback and use `Set.has()` inside, reducing time complexity to O(N+M) and noticeably improving responsiveness during state updates.
