## 2024-05-25 - Replace O(N) array lookup with O(1) Set lookup in ExtensionManagementService
**Learning:** Checking visited state inside recursive functions tracking dependent items using array `indexOf` creates O(N) lookups, causing O(N*M) or O(N^2) complexity in extreme cases. Using `Set` lookups drops the lookup overhead to O(1).
**Action:** When tracking checked/visited items in deep recursion trees across many components, pass a `Set` alongside or inside the recursive tracking logic to ensure O(1) membership checks.
