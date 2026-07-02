/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Headless `vscode` test double.
 *
 * The authoritative test runner is `@vscode/test-cli` (see `.vscode-test.mjs`),
 * which launches a real VS Code extension host and injects the genuine `vscode`
 * module. That harness needs a display (or `xvfb`), which isn't available in
 * every CI / sandbox. This shim lets the pure-logic portion of the suite run
 * under plain Mocha (`npm run test:node`) by satisfying `require('vscode')`
 * with a minimal, side-effect-free stand-in.
 *
 * It is intentionally NOT loaded by the `@vscode/test-cli` harness — only by the
 * `test:node` fallback via Mocha's `--require`. Tests that exercise real VS Code
 * behaviour (windows, editors, tree views) will not pass here; those are the
 * ones reported as "harness-only".
 */
'use strict';

const Module = require('node:module');

/** Minimal but functional EventEmitter matching `vscode.EventEmitter`. */
class EventEmitter {
	constructor() {
		this._listeners = new Set();
		this.event = (listener) => {
			this._listeners.add(listener);
			return { dispose: () => { this._listeners.delete(listener); } };
		};
	}
	fire(data) {
		for (const listener of [...this._listeners]) {
			listener(data);
		}
	}
	dispose() {
		this._listeners.clear();
	}
}

class Disposable {
	constructor(callOnDispose) {
		this._callOnDispose = callOnDispose;
	}
	dispose() {
		if (typeof this._callOnDispose === 'function') {
			this._callOnDispose();
		}
	}
	static from(...disposables) {
		return new Disposable(() => {
			for (const d of disposables) {
				if (d && typeof d.dispose === 'function') {
					d.dispose();
				}
			}
		});
	}
}

class Position {
	constructor(line, character) {
		this.line = line;
		this.character = character;
	}
}

class Range {
	constructor(startLine, startChar, endLine, endChar) {
		if (typeof startLine === 'object') {
			this.start = startLine;
			this.end = startChar;
		} else {
			this.start = new Position(startLine, startChar);
			this.end = new Position(endLine, endChar);
		}
	}
}

class Selection extends Range {}

class Location {
	constructor(uri, rangeOrPosition) {
		this.uri = uri;
		this.range = rangeOrPosition;
	}
}

class Diagnostic {
	constructor(range, message, severity) {
		this.range = range;
		this.message = message;
		this.severity = severity;
	}
}

class ThemeIcon {
	constructor(id, color) {
		this.id = id;
		this.color = color;
	}
}

class ThemeColor {
	constructor(id) {
		this.id = id;
	}
}

class MarkdownString {
	constructor(value) {
		this.value = value ?? '';
	}
	appendText(v) { this.value += v; return this; }
	appendMarkdown(v) { this.value += v; return this; }
	appendCodeblock(v) { this.value += v; return this; }
}

class TreeItem {
	constructor(label, collapsibleState) {
		this.label = label;
		this.collapsibleState = collapsibleState;
	}
}

class RelativePattern {
	constructor(base, pattern) {
		this.baseUri = base;
		this.pattern = pattern;
	}
}

class WorkspaceEdit {
	constructor() { this._edits = []; }
	replace() { /* no-op */ }
	insert() { /* no-op */ }
	delete() { /* no-op */ }
	set() { /* no-op */ }
}

class SnippetString {
	constructor(value) { this.value = value ?? ''; }
}

class CancellationTokenSource {
	constructor() {
		this._emitter = new EventEmitter();
		this.token = {
			isCancellationRequested: false,
			onCancellationRequested: this._emitter.event,
		};
	}
	cancel() {
		this.token.isCancellationRequested = true;
		this._emitter.fire(undefined);
	}
	dispose() {
		this._emitter.dispose();
	}
}

/** URI stand-in — covers the members the codebase actually reads. */
class Uri {
	constructor(scheme, authority, fsPath) {
		this.scheme = scheme ?? 'file';
		this.authority = authority ?? '';
		this.path = fsPath ?? '';
		this.fsPath = fsPath ?? '';
		this.fragment = '';
		this.query = '';
	}
	static file(p) { return new Uri('file', '', p); }
	static parse(value) {
		const scheme = typeof value === 'string' && value.includes(':') ? value.split(':')[0] : 'file';
		return new Uri(scheme, '', value);
	}
	static joinPath(base, ...segments) {
		const joined = [base.fsPath || base.path, ...segments].join('/').replace(/\/+/g, '/');
		return new Uri(base.scheme, base.authority, joined);
	}
	with(change) {
		const next = new Uri(this.scheme, this.authority, this.fsPath);
		Object.assign(next, change);
		if (change && change.path !== undefined) { next.fsPath = change.path; }
		return next;
	}
	toString() { return `${this.scheme}://${this.path}`; }
}

const noop = () => { /* no-op */ };
const asDisposable = () => ({ dispose: noop });
const resolved = (value) => Promise.resolve(value);

function createOutputChannel(name) {
	return {
		name,
		append: noop,
		appendLine: noop,
		replace: noop,
		clear: noop,
		show: noop,
		hide: noop,
		dispose: noop,
	};
}

function createStatusBarItem() {
	return {
		text: '',
		tooltip: '',
		command: undefined,
		color: undefined,
		backgroundColor: undefined,
		alignment: 1,
		priority: 0,
		show: noop,
		hide: noop,
		dispose: noop,
	};
}

function createDiagnosticCollection(name) {
	const map = new Map();
	return {
		name,
		set: (uri, diagnostics) => { map.set(String(uri), diagnostics); },
		delete: (uri) => { map.delete(String(uri)); },
		get: (uri) => map.get(String(uri)),
		has: (uri) => map.has(String(uri)),
		clear: () => map.clear(),
		forEach: (cb) => map.forEach((v, k) => cb(k, v)),
		dispose: () => map.clear(),
	};
}

function getConfiguration() {
	return {
		get: (_key, defaultValue) => defaultValue,
		has: () => false,
		inspect: () => undefined,
		update: () => resolved(undefined),
	};
}

const fs = {
	readFile: () => resolved(new Uint8Array()),
	writeFile: () => resolved(undefined),
	createDirectory: () => resolved(undefined),
	delete: () => resolved(undefined),
	stat: () => resolved({ type: 1, ctime: 0, mtime: 0, size: 0 }),
	readDirectory: () => resolved([]),
	rename: () => resolved(undefined),
	copy: () => resolved(undefined),
};

const vscodeStub = {
	// Core classes
	EventEmitter,
	Disposable,
	Position,
	Range,
	Selection,
	Location,
	Diagnostic,
	ThemeIcon,
	ThemeColor,
	MarkdownString,
	TreeItem,
	RelativePattern,
	WorkspaceEdit,
	SnippetString,
	CancellationTokenSource,
	Uri,

	// Enums
	StatusBarAlignment: { Left: 1, Right: 2 },
	ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
	ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
	DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
	TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
	ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
	ExtensionMode: { Production: 1, Development: 2, Test: 3 },
	CompletionItemKind: { Text: 0, Method: 1, Function: 2, Snippet: 14 },
	EndOfLine: { LF: 1, CRLF: 2 },
	FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
	UIKind: { Desktop: 1, Web: 2 },
	QuickPickItemKind: { Separator: -1, Default: 0 },
	TextEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
	CommentThreadCollapsibleState: { Collapsed: 0, Expanded: 1 },

	// Namespaces
	window: {
		activeTextEditor: undefined,
		visibleTextEditors: [],
		terminals: [],
		showInformationMessage: () => resolved(undefined),
		showWarningMessage: () => resolved(undefined),
		showErrorMessage: () => resolved(undefined),
		showQuickPick: () => resolved(undefined),
		showInputBox: () => resolved(undefined),
		showSaveDialog: () => resolved(undefined),
		showOpenDialog: () => resolved(undefined),
		showTextDocument: () => resolved(undefined),
		setStatusBarMessage: () => asDisposable(),
		createOutputChannel,
		createStatusBarItem,
		createTerminal: (opts) => ({
			name: (opts && opts.name) || 'terminal',
			show: noop,
			hide: noop,
			sendText: noop,
			dispose: noop,
		}),
		createTreeView: () => ({ dispose: noop, reveal: () => resolved(undefined), onDidChangeVisibility: () => asDisposable() }),
		createWebviewPanel: () => ({ webview: { html: '', onDidReceiveMessage: () => asDisposable(), postMessage: () => resolved(true) }, onDidDispose: () => asDisposable(), reveal: noop, dispose: noop }),
		registerWebviewViewProvider: () => asDisposable(),
		registerTreeDataProvider: () => asDisposable(),
		createTextEditorDecorationType: () => ({ dispose: noop }),
		onDidChangeActiveTextEditor: () => asDisposable(),
		onDidChangeVisibleTextEditors: () => asDisposable(),
		onDidChangeTextEditorSelection: () => asDisposable(),
		onDidOpenTerminal: () => asDisposable(),
		onDidCloseTerminal: () => asDisposable(),
		withProgress: (_opts, task) => Promise.resolve(task({ report: noop }, new CancellationTokenSource().token)),
	},
	workspace: {
		workspaceFolders: undefined,
		name: undefined,
		isTrusted: true,
		fs,
		getConfiguration,
		getWorkspaceFolder: () => undefined,
		asRelativePath: (p) => (typeof p === 'string' ? p : (p && p.fsPath) || ''),
		openTextDocument: () => resolved({ getText: () => '', uri: Uri.file(''), lineCount: 0, languageId: 'plaintext' }),
		applyEdit: () => resolved(true),
		createFileSystemWatcher: () => ({
			onDidCreate: () => asDisposable(),
			onDidChange: () => asDisposable(),
			onDidDelete: () => asDisposable(),
			dispose: noop,
		}),
		registerTextDocumentContentProvider: () => asDisposable(),
		onDidChangeConfiguration: () => asDisposable(),
		onDidChangeWorkspaceFolders: () => asDisposable(),
		onDidChangeTextDocument: () => asDisposable(),
		onDidSaveTextDocument: () => asDisposable(),
		onDidOpenTextDocument: () => asDisposable(),
		onDidCloseTextDocument: () => asDisposable(),
	},
	commands: {
		registerCommand: () => asDisposable(),
		registerTextEditorCommand: () => asDisposable(),
		executeCommand: () => resolved(undefined),
		getCommands: () => resolved([]),
	},
	languages: {
		createDiagnosticCollection,
		registerInlineCompletionItemProvider: () => asDisposable(),
		registerCompletionItemProvider: () => asDisposable(),
		registerCodeActionsProvider: () => asDisposable(),
		registerCodeLensProvider: () => asDisposable(),
		registerHoverProvider: () => asDisposable(),
		registerDefinitionProvider: () => asDisposable(),
	},
	extensions: {
		all: [],
		getExtension: () => undefined,
		onDidChange: () => asDisposable(),
	},
	env: {
		appName: 'Son of Anton',
		appHost: 'desktop',
		uriScheme: 'son-of-anton',
		language: 'en',
		machineId: 'test-machine',
		sessionId: 'test-session',
		clipboard: { writeText: () => resolved(undefined), readText: () => resolved('') },
		openExternal: () => resolved(true),
	},
};

// Intercept `require('vscode')` and return the stub. We chain the original
// loader so every other module resolves normally.
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') {
		return vscodeStub;
	}
	return originalLoad.call(this, request, parent, isMain);
};

module.exports = vscodeStub;
