## 2024-05-18 - Fix aria-checked for TriStateCheckbox
**Learning:** Screen readers misinterpret mixed state checkboxes as 'unchecked' if backed by standard boolean properties, making them inaccessible.
**Action:** Explicitly set `aria-checked="mixed"` when TriStateCheckbox is in a mixed state so screen readers properly announce it.
