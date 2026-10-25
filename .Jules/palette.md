## 2026-10-25 - Tri-state Checkbox Accessibility
**Learning:** Tri-state checkboxes backed by standard boolean toggles must explicitly override the native `aria-checked` attribute to `mixed` for screen readers, as the underlying boolean toggle will otherwise default to `false` (unchecked) when the state is mixed.
**Action:** When implementing custom tri-state controls (like `TriStateCheckbox`), intercept lifecycle methods (like `applyStyles`) to manually enforce `aria-checked="mixed"` when the state is not purely true or false, handling the initialization phase where state might be undefined.
