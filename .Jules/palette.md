## 2024-05-24 - Localized ARIA labels
**Learning:** Hardcoded ARIA labels like "scroll to top" fail internationalization. It's critical to use `localize` for all labels.
**Action:** Use `escape(localize('scrollToTop', "Scroll to top"))` inside template strings instead of hardcoded strings for UI components in VS Code.
