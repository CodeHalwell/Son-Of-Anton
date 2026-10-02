## 2024-05-18 - Avoid instantiating Sets inside recursive functions
**Learning:** Instantiating a new `Set` locally within a function body recursively (e.g., `new Set(checked)`) causes an O(N) memory allocation and hashing overhead on every execution, becoming a pessimization compared to O(N) array loops.
**Action:** Instantiate a `Set` once at the entry point of the recursive function and explicitly pass it down through the recursive calls to maintain state. Ensure array modifications are mirrored in the `Set` to prevent desynchronization.
