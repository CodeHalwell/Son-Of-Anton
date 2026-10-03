## 2024-05-13 - Add explicit aria-checked='mixed' state to TriStateCheckbox
**Learning:** Custom tri-state checkboxes require explicit `aria-checked="mixed"` to be announced correctly by screen readers, otherwise they are announced incorrectly as 'unchecked' if backed by a standard boolean property.
**Action:** When creating custom tri-state checkboxes, explicitly set `aria-checked="mixed"` when in the mixed state.
