## 2023-10-24 - Dynamic Text Toggle Accessibility
**Learning:** Toggle buttons with generic text that changes dynamically (like "show" / "hide") are confusing for screen readers because the text loses context.
**Action:** Apply a stable, descriptive `aria-label` (e.g., "Toggle Extension Data") along with `aria-expanded` to provide consistent context regardless of the visual state.
