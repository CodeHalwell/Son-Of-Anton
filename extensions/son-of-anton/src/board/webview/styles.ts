/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Theme-aware layout shared by the board and its assistant. */
export const boardStyles = `
.dependency-editor { display: grid; grid-template-columns: minmax(260px, 1fr) minmax(280px, 1fr); overflow: auto; gap: 24px; border: 1px solid var(--sota-border); border-radius: 10px; padding: 20px; }
.dependency-controls, .dependency-preview { min-width: 0; overflow-wrap: anywhere; }
.dependency-editor h2, .dependency-editor h3 { margin-top: 0; }
.dependency-editor p, .dependency-editor small { color: var(--sota-muted); }
.dependency-controls > label { display: grid; gap: 6px; margin-bottom: 16px; }
.dependency-controls fieldset { border: 1px solid var(--sota-border); border-radius: 6px; margin: 0 0 16px; }
.dependency-options { max-height: 300px; overflow: auto; }
.dependency-options label { display: flex; align-items: flex-start; gap: 8px; padding: 8px 0; }
.dependency-editor small { display: block; font-size: 11px; overflow-wrap: anywhere; }
.dependency-wave { border-left: 2px solid var(--sota-accent); padding-left: 12px; margin-bottom: 16px; }
.dependency-wave ul { padding: 0; list-style: none; }
.dependency-wave button { text-align: left; width: 100%; border: 1px solid var(--sota-border); margin-bottom: 6px; }
.dependency-wave button[aria-pressed="true"] { border-color: var(--sota-accent); }
.dependency-error { color: var(--vscode-errorForeground) !important; }
@media (max-width: 760px) { .dependency-editor { grid-template-columns: 1fr; } }

:root {
	--sota-surface: var(--vscode-editor-background, #16191e);
	--sota-raised: var(--vscode-editorWidget-background, #21252c);
	--sota-muted: var(--vscode-descriptionForeground, #a6adb8);
	--sota-border: var(--vscode-panel-border, #363b44);
	--sota-accent: var(--vscode-focusBorder, #63acff);
	--sota-status-backlog: var(--sota-muted);
	--sota-status-ready: var(--vscode-charts-blue, #63acff);
	--sota-status-progress: var(--vscode-charts-yellow, #e8bd62);
	--sota-status-review: var(--vscode-charts-purple, #ba9cf1);
	--sota-status-done: var(--vscode-charts-green, #72c9a6);
	--sota-status-failed: var(--vscode-errorForeground, #f48771);
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body, #root { margin: 0; height: 100%; font: 13px/1.5 var(--vscode-font-family, system-ui); color: var(--vscode-foreground, #e1e5eb); background: var(--sota-surface); }
button, input, select, textarea { font: inherit; color: inherit; }
button { cursor: pointer; }
button:disabled { cursor: default; opacity: .45; }
button, input, select, textarea, summary { transition: border-color 120ms ease, background-color 120ms ease; }
:focus-visible { outline: 2px solid var(--sota-accent); outline-offset: 3px; }
button { border: 1px solid transparent; border-radius: 6px; padding: 7px 11px; background: transparent; }
button:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground, #ffffff0d); }
.primary-button { background: var(--vscode-button-background, #2768bc); color: var(--vscode-button-foreground, white); font-weight: 600; }
.primary-button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground, #347aca); }
.secondary-button, .card-action { border-color: var(--sota-border); background: var(--sota-raised); }
.quiet-button { color: var(--sota-muted); }
.shell { display: flex; flex-direction: column; height: 100dvh; padding: 28px 28px 18px; gap: 20px; overflow: hidden; }
.header { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.board-heading { min-width: 0; }
.eyebrow { display: block; color: var(--sota-muted); font-size: 10px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; }
.header h1 { font-size: clamp(20px, 2.5vw, 28px); line-height: 1.25; letter-spacing: -.025em; margin: 8px 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.header p { color: var(--sota-muted); margin: 0; font-size: 12px; }
.header-actions { display: flex; flex-shrink: 0; gap: 6px; }
.board-overview { display: flex; align-items: center; flex-wrap: wrap; gap: 24px; border-block: 1px solid var(--sota-border); padding: 16px 0; }
.progress-summary { display: flex; align-items: center; gap: 14px; min-width: 215px; }
.progress-summary strong { font-size: 26px; font-weight: 500; letter-spacing: -.04em; font-variant-numeric: tabular-nums; }
.progress-summary > div { display: grid; gap: 6px; flex: 1; color: var(--sota-muted); font-size: 11px; }
progress { appearance: none; width: 100%; height: 4px; border: 0; border-radius: 4px; overflow: hidden; background: var(--sota-border); }
progress::-webkit-progress-bar { background: var(--sota-border); }
progress::-webkit-progress-value { background: var(--sota-status-done); }
.overview-filters { display: flex; flex-wrap: wrap; gap: 6px; }
.overview-filter { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--sota-muted); }
.overview-filter[aria-pressed="true"] { background: var(--sota-raised); border-color: var(--sota-border); color: var(--vscode-foreground); }
.filter-count { font-variant-numeric: tabular-nums; opacity: .8; }
.status-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--status-color, var(--sota-muted)); flex-shrink: 0; }
.active { --status-color: var(--sota-status-progress); }
.attention { --status-color: var(--sota-status-failed); }
.done { --status-color: var(--sota-status-done); }
.board-toolbar { display: flex; align-items: center; gap: 12px; }
.task-search { display: flex; align-items: center; gap: 8px; padding: 0 10px; border: 1px solid var(--sota-border); border-radius: 6px; background: var(--vscode-input-background, var(--sota-raised)); width: min(340px, 50%); }
.task-search:focus-within { outline: 1px solid var(--sota-accent); }
.task-search > span { font-size: 23px; color: var(--sota-muted); line-height: 1; }
.task-search input { width: 100%; padding: 8px 0; border: 0; background: transparent; outline: none; min-width: 0; }
input::placeholder, textarea::placeholder { color: var(--vscode-input-placeholderForeground, var(--sota-muted)); }
select { padding: 7px 24px 7px 10px; border: 1px solid var(--sota-border); border-radius: 6px; background: var(--vscode-dropdown-background, var(--sota-raised)); min-width: 0; }
.results-count { margin-left: auto; color: var(--sota-muted); font-size: 11px; white-space: nowrap; }
.board-layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; flex: 1; min-height: 0; }
.board-layout.with-assistant { grid-template-columns: minmax(0, 1fr) 320px; }
.columns { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(220px, 1fr); gap: 14px; overflow-x: auto; min-width: 0; min-height: 0; padding: 2px 2px 12px; scrollbar-gutter: stable; scroll-snap-type: x proximity; }
.column { display: flex; flex-direction: column; min-height: 0; border: 1px solid transparent; border-radius: 9px; background: color-mix(in srgb, var(--sota-raised) 42%, transparent); padding: 10px; scroll-snap-align: start; }
.column[data-state="backlog"] { --status-color: var(--sota-status-backlog); }
.column[data-state="ready"] { --status-color: var(--sota-status-ready); }
.column[data-state="in-progress"] { --status-color: var(--sota-status-progress); }
.column[data-state="review"] { --status-color: var(--sota-status-review); }
.column[data-state="done"] { --status-color: var(--sota-status-done); }
.column[data-state="failed"] { --status-color: var(--sota-status-failed); }
.column.drag-over { border-color: var(--sota-accent); background: color-mix(in srgb, var(--sota-accent) 8%, var(--sota-surface)); }
.column-header { display: flex; align-items: center; gap: 8px; padding: 4px 2px 14px; }
.column-header h2 { margin: 0; font-size: 12px; font-weight: 600; }
.column-count { color: var(--sota-muted); margin-left: auto; font-size: 11px; font-variant-numeric: tabular-nums; }
.column-body { display: flex; flex-direction: column; gap: 10px; overflow-y: auto; padding: 2px 2px 10px; min-height: 0; }
.column-empty { color: var(--sota-muted); border: 1px dashed var(--sota-border); padding: 22px 10px; text-align: center; border-radius: 7px; font-size: 11px; }
.tile { background: var(--sota-surface); border: 1px solid var(--sota-border); border-radius: 8px; padding: 13px; overflow-wrap: anywhere; }
.tile:hover, .tile:focus-within { border-color: color-mix(in srgb, var(--sota-accent) 55%, var(--sota-border)); }
.tile[draggable="true"] { cursor: grab; }
.tile.dragging { opacity: .5; cursor: grabbing; }
.tile-row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.tile-id { font: 10px var(--vscode-editor-font-family, monospace); color: var(--sota-muted); }
.tile-status-pill { margin-left: auto; color: var(--status-color); background: color-mix(in srgb, var(--status-color) 10%, transparent); border: 1px solid color-mix(in srgb, var(--status-color) 20%, transparent); padding: 1px 6px; border-radius: 4px; font-size: 9px; text-transform: capitalize; white-space: nowrap; }
.tile-instruction { font-size: 13px; line-height: 1.55; font-weight: 500; cursor: pointer; list-style-position: outside; margin-left: 10px; padding-left: 1px; }
.tile-instruction::marker { font-size: 9px; color: var(--sota-muted); }
.tile-instruction span { display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.task-full-instruction { white-space: pre-wrap; overflow-wrap: anywhere; }
.task-detail-body { font-size: 11px; color: var(--sota-muted); border-top: 1px solid var(--sota-border); margin-top: 10px; }
.task-detail-body ul { padding-left: 16px; }
.task-detail-body code { font-family: var(--vscode-editor-font-family, monospace); }
.tile-assignee { display: flex; align-items: center; gap: 7px; margin: 13px 0 8px; }
.avatar { display: grid; place-items: center; width: 23px; height: 23px; border-radius: 6px; background: var(--sota-raised); font-size: 10px; font-weight: 600; }
.tile-name { color: var(--sota-muted); font-size: 11px; }
.chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
.chip { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 2px 5px; border: 1px solid var(--sota-border); border-radius: 4px; font: 10px var(--vscode-editor-font-family, monospace); color: var(--sota-muted); }
.chip.dep { border: 0; padding: 2px 0; font-family: inherit; }
.tile-summary { font-size: 11px; color: var(--sota-status-failed); margin-top: 10px; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.tile-actions { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px; margin-top: 13px; padding-top: 10px; border-top: 1px solid var(--sota-border); }
.tile-actions button { padding: 4px 6px; font-size: 10px; }
.empty { display: flex; align-items: center; justify-content: center; flex-direction: column; text-align: center; border: 1px solid var(--sota-border); border-radius: 12px; padding: 32px; overflow-y: auto; }
.empty h2 { font-size: clamp(22px, 3vw, 32px); letter-spacing: -.03em; font-weight: 500; margin: 14px 0 8px; }
.empty p { max-width: 380px; color: var(--sota-muted); line-height: 1.8; margin: 0 0 22px; }
.empty-workflow { display: flex; flex-wrap: wrap; justify-content: center; gap: 26px; margin-top: 42px; color: var(--sota-muted); font-size: 11px; }
.empty-board-mark { display: flex; gap: 5px; margin-bottom: 24px; height: 48px; transform: rotate(-7deg); }
.empty-board-mark span { width: 20px; height: 42px; border: 1px solid var(--sota-border); border-top: 3px solid var(--sota-status-ready); border-radius: 4px; background: var(--sota-raised); }
.empty-board-mark span:nth-child(2) { height: 32px; border-top-color: var(--sota-status-progress); }
.empty-board-mark span:nth-child(3) { height: 22px; border-top-color: var(--sota-status-done); }
.assistant-container { min-height: 0; min-width: 0; }
.chat-pane { height: 100%; display: flex; flex-direction: column; border: 1px solid var(--sota-border); border-radius: 10px; overflow: hidden; background: var(--sota-surface); }
.chat-header { padding: 16px; border-bottom: 1px solid var(--sota-border); display: flex; align-items: center; gap: 9px; }
.chat-header strong { font-size: 13px; font-weight: 600; }
.chat-header small { display: block; color: var(--sota-muted); font-size: 10px; }
.chat-log { flex: 1; overflow-y: auto; padding: 18px 14px; min-height: 0; overflow-wrap: anywhere; }
.chat-empty { margin: 20px 0; color: var(--sota-muted); font-size: 12px; }
.chat-empty h3 { font-size: 17px; font-weight: 500; color: var(--vscode-foreground); margin: 0 0 8px; }
.chat-suggestions { display: grid; gap: 7px; margin-top: 18px; }
.chat-suggestions button { text-align: left; border-color: var(--sota-border); font-size: 11px; }
.chat-bubble { white-space: pre-wrap; margin-bottom: 20px; font-size: 12px; line-height: 1.7; }
.chat-role { display: block; font-size: 10px; font-weight: 600; color: var(--sota-muted); margin-bottom: 6px; }
.chat-user { background: var(--sota-raised); border: 1px solid var(--sota-border); padding: 10px 12px; border-radius: 9px; }
.chat-tool-calls { padding: 0; list-style: none; }
.chat-tool-call { padding: 7px; margin: 5px 0; border: 1px solid var(--sota-border); border-radius: 5px; font-size: 10px; }
.chat-tool-call-args { display: block; color: var(--sota-muted); }
.chat-input { margin: 0 12px 12px; border: 1px solid var(--sota-border); border-radius: 8px; padding: 10px; background: var(--vscode-input-background, var(--sota-raised)); }
.chat-input:focus-within { border-color: var(--sota-accent); }
.chat-input textarea { border: 0; outline: none; background: transparent; width: 100%; min-height: 54px; max-height: 150px; resize: vertical; font-size: 12px; }
.chat-input-footer { display: flex; align-items: center; gap: 10px; justify-content: space-between; }
.chat-input-footer span { font-size: 9px; color: var(--sota-muted); }
.chat-input-footer button { font-size: 11px; padding: 5px 10px; }
.chat-status { padding: 4px 14px; color: var(--sota-muted); font-size: 10px; }
.chat-jump { margin: 0 auto 8px; font-size: 10px; border-color: var(--sota-border); background: var(--sota-raised); }
@media (max-width: 1000px) {
	.shell { padding: 20px 16px 12px; gap: 16px; }
	.board-layout.with-assistant { grid-template-columns: minmax(0, 1fr) 290px; }
	.board-overview { gap: 14px; }
}
@media (max-width: 640px) {
	.shell { padding: 16px 10px 10px; gap: 12px; }
	.header { align-items: flex-start; gap: 8px; }
	.header-actions { flex-direction: column-reverse; }
	.header p { display: none; }
	.header h1 { white-space: normal; font-size: 20px; }
	.eyebrow { font-size: 9px; }
	.overview-filter { padding: 5px 7px; font-size: 10px; }
	.progress-summary { min-width: 180px; }
	.board-toolbar { flex-wrap: wrap; gap: 8px; }
	.task-search { width: 100%; }
	.board-layout.with-assistant { grid-template-columns: minmax(0, 1fr); }
	.with-assistant > .columns, .with-assistant > .empty { display: none; }
	.columns { display: flex; flex-direction: column; overflow-x: hidden; overflow-y: auto; }
	.column { flex-shrink: 0; }
	.column-body { overflow: visible; }
	.shell:has(.with-assistant) .board-overview, .shell:has(.with-assistant) .board-toolbar { display: none; }
}
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; scroll-behavior: auto !important; } }
body.vscode-high-contrast .tile, body.vscode-high-contrast-light .tile { border-color: var(--vscode-contrastBorder, var(--sota-border)); }
`;
