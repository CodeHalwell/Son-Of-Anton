## 2026-09-19 - Dynamic aria-expanded initialization
**Learning:** Collapsable elements with role="button" should dynamically evaluate their initial `aria-expanded` state on load instead of hardcoding `'false'` to ensure screen readers announce the correct state.
**Action:** Always use a state variable or property (e.g., `String(!!state)`) when initializing `aria-expanded` during DOM creation.
