## 2026-10-23 - O(N^2) Array Flattening
**Learning:** Using `array.reduce((a, b) => a.concat(b), [])` is an O(N^2) anti-pattern because `concat` creates a new array on every iteration. This is a common pattern in the codebase that can severely degrade performance on large arrays.
**Action:** Always use `Array.prototype.flatMap()` or `Array.prototype.flat()` which perform this operation in O(N) time natively.
