/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Son of Anton Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const Module = require('module');
const path = require('path');
const fs = require('fs');

// Minimal vscode stub so tests that reference vscode types can run outside a
// VS Code host.  Only the runtime values actually called in test setup are
// implemented; all others are stubs that throw if invoked unexpectedly.
const vscodeMock = {
	EventEmitter: class EventEmitter {
		constructor() {
			this._listeners = [];
			this.event = (listener) => {
				this._listeners.push(listener);
				return { dispose: () => {} };
			};
		}
		fire(data) { for (const l of this._listeners) { l(data); } }
		dispose() { this._listeners = []; }
	},
	workspace: {
		isTrusted: true,
		workspaceFolders: undefined,
		getConfiguration: () => ({
			get: (_key, defaultValue) => defaultValue,
			has: () => false,
			inspect: () => undefined,
			update: async () => undefined,
		}),
	},
	window: {
		showWarningMessage: async () => undefined,
		showInformationMessage: async () => undefined,
		showErrorMessage: async () => undefined,
		createOutputChannel: () => ({ appendLine: () => {}, dispose: () => {} }),
	},
	commands: { registerCommand: () => ({ dispose: () => {} }), executeCommand: async () => undefined },
	Uri: {
		parse: (s) => ({ toString: () => s, scheme: 'https', fsPath: s }),
		file: (p) => ({ fsPath: p, scheme: 'file', toString: () => p }),
		joinPath: (base, ...segments) => ({ fsPath: path.join(base.fsPath, ...segments), scheme: 'file' }),
	},
	ThemeIcon: class ThemeIcon { constructor(id) { this.id = id; } },
	TreeItem: class TreeItem { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
	TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
	ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
	StatusBarAlignment: { Left: 1, Right: 2 },
	ViewColumn: { Active: -1, Beside: -2, One: 1 },
	ProgressLocation: { Notification: 15, Window: 10, Explorer: 1 },
	CancellationTokenSource: class CancellationTokenSource {
		constructor() {
			this.token = {
				isCancellationRequested: false,
				onCancellationRequested: () => ({ dispose: () => {} }),
			};
		}
		cancel() { this.token.isCancellationRequested = true; }
		dispose() {}
	},
};

// son-of-anton-core dist root — built by the CI step prior to running these tests.
const coreDistRoot = path.resolve(__dirname, '..', '..', '..', 'son-of-anton-core', 'dist');

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') {
		return vscodeMock;
	}
	if (request === 'son-of-anton-core') {
		return originalLoad.call(this, path.join(coreDistRoot, 'index.js'), parent, isMain);
	}
	if (request.startsWith('son-of-anton-core/')) {
		const subpath = request.slice('son-of-anton-core/'.length);
		const candidates = [
			path.join(coreDistRoot, subpath + '.js'),
			path.join(coreDistRoot, subpath, 'index.js'),
		];
		for (const candidate of candidates) {
			if (fs.existsSync(candidate)) {
				return originalLoad.call(this, candidate, parent, isMain);
			}
		}
	}
	return originalLoad.apply(this, arguments);
};
