"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkspacePathError = void 0;
exports.workspacePath = workspacePath;
exports.readWorkspaceFile = readWorkspaceFile;
exports.writeWorkspaceFile = writeWorkspaceFile;
exports.removeWorkspaceFile = removeWorkspaceFile;
/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const fs = __importStar(require("node:fs/promises"));
const node_fs_1 = require("node:fs");
const path = __importStar(require("node:path"));
const node_crypto_1 = require("node:crypto");
class WorkspacePathError extends Error {
}
exports.WorkspacePathError = WorkspacePathError;
function missing(error) {
    return error.code === 'ENOENT';
}
/** Resolve relative or absolute workspace paths and reject every symlink component. */
async function workspacePath(root, input, allowRoot = false) {
    if (typeof input !== 'string' || !input || input.includes('\0')) {
        throw new WorkspacePathError('Invalid workspace path');
    }
    const base = await fs.realpath(root);
    const lexicalBase = path.resolve(root);
    const requested = path.resolve(lexicalBase, input);
    let relative = path.relative(lexicalBase, requested);
    if (path.isAbsolute(input) && (input === base || input.startsWith(base + path.sep))) {
        relative = path.relative(base, input);
    }
    if ((!relative && !allowRoot) || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        throw new WorkspacePathError('Path must be inside the workspace');
    }
    let current = base;
    for (const part of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        try {
            const entry = await fs.lstat(current);
            if (entry.isSymbolicLink()) {
                throw new WorkspacePathError('Symlinks are not allowed in workspace operations');
            }
            if (await fs.realpath(current) !== current) {
                throw new WorkspacePathError('Workspace path changed during validation');
            }
        }
        catch (error) {
            if (!missing(error)) {
                throw error;
            }
        }
    }
    return current;
}
/** Read through a non-following file handle; only absence represents a missing file. */
async function readWorkspaceFile(root, input) {
    const target = await workspacePath(root, input);
    let handle;
    try {
        handle = await fs.open(target, node_fs_1.constants.O_RDONLY | node_fs_1.constants.O_NOFOLLOW);
    }
    catch (error) {
        if (missing(error)) {
            return undefined;
        }
        throw error;
    }
    try {
        const opened = await handle.stat();
        const checked = await fs.lstat(await workspacePath(root, input));
        if (!opened.isFile() || opened.ino !== checked.ino || opened.dev !== checked.dev) {
            throw new WorkspacePathError('Workspace file changed during read');
        }
        return await handle.readFile('utf8');
    }
    finally {
        await handle.close();
    }
}
/** Replace files atomically, avoiding truncation through symlinks or hard links. */
async function writeWorkspaceFile(root, input, content) {
    const target = await workspacePath(root, input);
    const parent = path.dirname(target);
    await fs.mkdir(parent, { recursive: true });
    await workspacePath(root, input);
    let mode = 0o600;
    try {
        const original = await fs.lstat(target);
        if (!original.isFile()) {
            throw new WorkspacePathError('Workspace target must be a regular file');
        }
        mode = original.mode & 0o777;
    }
    catch (error) {
        if (!missing(error)) {
            throw error;
        }
    }
    const temporary = path.join(parent, `.sota-restore-${(0, node_crypto_1.randomUUID)()}`);
    try {
        await fs.writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
        await fs.chmod(temporary, mode);
        await workspacePath(root, input);
        await fs.rename(temporary, target);
    }
    finally {
        await fs.unlink(temporary).catch(error => { if (!missing(error)) {
            throw error;
        } });
    }
}
async function removeWorkspaceFile(root, input) {
    const target = await workspacePath(root, input);
    await fs.unlink(target).catch(error => { if (!missing(error)) {
        throw error;
    } });
}
//# sourceMappingURL=workspaceFs.js.map