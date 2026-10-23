## 2024-05-24 - Accessibility Fix: TriStateCheckbox
**Learning:** For custom tri-state checkboxes, screen readers will announce them incorrectly as `unchecked` or similar if they are just backed by a boolean property and do not have `aria-checked="mixed"` when in the mixed state. Also, overriding methods like `applyStyles()` in a subclass requires ensuring you also initialize the state properly if it affects the base class.
**Action:** Explicitly set `aria-checked="mixed"` on the toggle element when in the mixed state, rather than just changing the icon.
