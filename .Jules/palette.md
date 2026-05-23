## 2026-05-17 - Keyboard Accessibility in Custom Overlay Widgets
**Learning:** In custom overlay widgets (like `CollapsedCodeOverlayWidget` in the diff editor), simply setting `role="button"` and `tabindex="0"` on container `div`s or `a` tags without `href` attributes is insufficient for true accessibility. These elements do not natively handle 'Enter' or 'Space' keypresses. While mouse interactions (`mousedown`/`mouseup`/`click`) work for sighted users, keyboard-only or screen-reader users remain blocked from triggering these actions.
**Action:** When implementing or modifying custom interactive elements with `role="button"`, always verify that a corresponding `onkeydown` handler is present to intercept `e.key === 'Enter'` and `e.key === ' '`, call `e.preventDefault()`, and trigger the identical logic used in the mouse interaction handler.

## 2026-05-02 - Missing aria-label in custom Notebook Diff Cell Overlay widgets
**Learning:** The custom `DOM.$('a')` elements used as icon-only buttons in `CollapsedCellOverlayWidget` and `UnchangedCellOverlayWidget` within `notebook/browser/diff/diffComponents.ts` define `role: 'button'` and `tabindex: 0` but miss an explicitly localized `aria-label` attribute, which breaks accessibility for screen readers.
**Action:** When working on custom icon-only overlay widgets or inline buttons constructed via DOM helper functions, ensure the `aria-label` attribute is added utilizing the localized title string.

## 2026-05-14 - Keyboard Accessibility for Custom Interactive Elements
**Learning:** When using custom DOM elements (like `<span>` or `<div>`) equipped with `role="button"` and `tabindex="0"` for user interaction, attaching a `'click'` listener alone is insufficient for keyboard accessibility.
**Action:** Always complement `'click'` event listeners with `'keydown'` handlers that capture `Enter` and `Space` key presses for all custom interactive components to ensure full accessibility support for keyboard users.
