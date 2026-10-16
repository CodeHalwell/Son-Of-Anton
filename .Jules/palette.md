## 2024-06-25 - Correct aria-checked for TriStateCheckbox
**Learning:** For custom tri-state checkboxes, the `aria-checked` attribute must explicitly support the 'mixed' state, not just boolean values. The underlying boolean toggle sets it incorrectly to 'false' if it's not strictly 'true', which confuses screen readers.
**Action:** Explicitly set `aria-checked="mixed"` on the `domNode` in the custom tri-state checkbox component logic when the state is mixed, overriding the boolean underlying component.
