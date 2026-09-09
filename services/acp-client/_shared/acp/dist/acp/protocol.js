"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.cancelledPermission = exports.AcpError = exports.ACP_VERSION = void 0;
exports.validateImages = validateImages;
exports.object = object;
exports.abortError = abortError;
exports.isValidAcpModelId = isValidAcpModelId;
exports.validateAgent = validateAgent;
/** Stable ACP v1 subset. Optional extensions are negotiated, never assumed. */
exports.ACP_VERSION = 1;
/** Validate before spawning an adapter; an invalid attachment must never silently disappear. */
function validateImages(images = []) {
    if (images.length > 10) {
        throw new Error('A turn supports at most 10 images');
    }
    let bytes = 0;
    for (const image of images) {
        if (!/^image\/(png|jpeg|webp|gif)$/.test(image.mimeType) || !image.data || image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) {
            throw new Error('Image attachments require valid base64 PNG, JPEG, WebP or GIF content');
        }
        bytes += Buffer.byteLength(image.data);
    }
    if (bytes > 24 * 1024 * 1024) {
        throw new Error('Image attachments exceed the 24 MiB encoded turn limit');
    }
}
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
/** The limit applies to the adapter's raw model ID, excluding host catalog namespaces. */
function isValidAcpModelId(value) {
    return typeof value === 'string' && !!value.trim() && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}
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
    if (value.modelId !== undefined && !isValidAcpModelId(value.modelId)) {
        throw new Error(`ACP agent ${value.id}: modelId must be a non-empty advertised model ID`);
    }
    if (value.authMethodId !== undefined && typeof value.authMethodId !== 'string') {
        throw new Error(`ACP agent ${value.id}: authMethodId must be a string`);
    }
}
//# sourceMappingURL=protocol.js.map