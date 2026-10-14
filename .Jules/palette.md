## 2025-01-23 - Accessible Toggles with Dynamic Visual Text
**Learning:** For toggle buttons with generic visual text that changes dynamically (e.g., switching between 'show' and 'hide'), screen readers lose context. If it just says 'show', users don't know *what* is being shown.
**Action:** Assign a stable, descriptive `aria-label` (e.g., 'Toggle Extension Data'). The `aria-label` overrides the visible text content for screen readers, providing consistent context regardless of the current visual state.
