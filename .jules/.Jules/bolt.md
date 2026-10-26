## 2024-05-19 - Replace O(N^2) reduce.concat with flat()
**Learning:** Found multiple instances of `array.reduce((a, b) => a.concat(b), [])` in the codebase. This is a known O(N^2) anti-pattern because `.concat()` creates a new array every time it's called in the reduce loop. This can cause significant memory allocation overhead and performance degradation for larger arrays.
**Action:** Replace `reduce((a, b) => a.concat(b), [])` with `flat()` or `flatMap()`.
