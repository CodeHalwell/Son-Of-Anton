## 2024-10-24 - Replace reduce-concat with flatMap/flat
**Learning:** The O(N^2) anti-pattern `array.reduce((a, b) => a.concat(b), [])` causes performance issues due to intermediate array allocations.
**Action:** Replace `reduce-concat` with `Array.prototype.flatMap()` or `Array.prototype.flat()`, which flatten arrays natively in O(N) time and eliminate intermediate allocations.
