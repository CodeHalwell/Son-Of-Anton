## 2026-10-07 - Recursive Set Initializations
**Learning:** When refactoring functions to add secondary tracking parameters (like a Set alongside an existing array for O(1) lookups), do not assign an empty default value in the method signature. This causes state desynchronization. Instead, conditionally initialize the secondary structure within the function body using the primary array's contents.
**Action:** Always conditionally initialize tracking parameters inside the function body.
