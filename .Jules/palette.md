## 2024-05-24 - Revealing hidden lists with tooltips
**Learning:** For aggregate UI chips (like '+N more' or 'X dependencies') that hide list contents to save space, assigning a newline-separated string to the native `title` attribute provides an accessible, zero-dependency hover state to reveal the hidden items without layout shifts.
**Action:** Always add `title` attributes to summary chips if the full data array is available in memory but visually truncated.
