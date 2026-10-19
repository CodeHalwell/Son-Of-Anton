## 2024-10-19 - Accessible Hover State for Aggregate UI Chips
**Learning:** For aggregate UI chips (e.g., '+N more') that hide list contents, users couldn't see which items were hidden without fully expanding or interacting with the parent element, which is bad for accessibility and UX.
**Action:** A reusable and zero-dependency micro-UX pattern is to assign a newline-separated string to the native `title` attribute of the aggregate chip. This provides an accessible hover state to reveal hidden items without layout shifts.
