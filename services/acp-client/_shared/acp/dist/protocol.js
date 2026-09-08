"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.cancelledPermission = exports.AcpError = exports.ACP_VERSION = void 0;
exports.object = object;
exports.abortError = abortError;
exports.validateAgent = validateAgent;
/** Stable ACP v1 subset. Optional extensions are negotiated, never assumed. */
exports.ACP_VERSION = 1;
class AcpError extends Error {
    code;
    data;
    constructor(code, message, data) {
        super(message);
        this.code = code;
        this.data = data;
        this.name = 'AcpError';
    }
}
exports.AcpError = AcpError;
function object(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function abortError() { return new DOMException('ACP request cancelled', 'AbortError'); }
const cancelledPermission = () => ({ outcome: { outcome: 'cancelled' } });
exports.cancelledPermission = cancelledPermission;
function validateAgent(value) {
    if (!object(value) || typeof value.id !== 'string' || !value.id.trim() || typeof value.command !== 'string' || !value.command.trim()) {
        throw new Error('ACP agent requires a non-empty id and command');
    }
    if (value.args !== undefined && (!Array.isArray(value.args) || !value.args.every(arg => typeof arg === 'string'))) {
        throw new Error(`ACP agent ${value.id}: args must be strings`);
    }
    if (value.env !== undefined && (!object(value.env) || !Object.values(value.env).every(item => typeof item === 'string'))) {
        throw new Error(`ACP agent ${value.id}: env must map names to strings`);
    }
    if (value.authMethodId !== undefined && typeof value.authMethodId !== 'string') {
        throw new Error(`ACP agent ${value.id}: authMethodId must be a string`);
    }
}
//# sourceMappingURL=protocol.js.map