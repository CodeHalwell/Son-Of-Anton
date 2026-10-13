## 2024-05-18 - TriStateCheckbox ARIA state mixed
**Learning:** Tri-state checkboxes implementing 'mixed' state need to explicitly set `aria-checked="mixed"` on the DOM node instead of being bound only to the underlying true/false state. Without this, screen readers misrepresent the 'mixed' state.
**Action:** Always ensure that tri-state or indeterminate component wrappers correctly map their internal mixed state to the DOM node's `aria-checked` attribute.
