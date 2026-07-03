"use strict";
// Copyright (c) Son of Anton Contributors. All rights reserved.
// Licensed under the MIT License.
Object.defineProperty(exports, "__esModule", { value: true });
exports.appliesAtTrustLevel = exports.meetsTrustLevel = exports.resolveTrustLevel = exports.INJECTION_PATTERNS = exports.ContextSanitiser = void 0;
/**
 * Shared prompt-injection sanitiser core.
 *
 * Canonical home of the sanitisation engine used by:
 *  - `services/context-sanitiser` — the HTTP service + background workspace scanner
 *  - `services/mcp-gateway` — inline sanitisation of model-bound tool results (F-4)
 *
 * Consuming services vendor the compiled `dist/` (same pattern as
 * `services/_shared/auth`); this package has no runtime dependencies.
 */
var sanitiser_1 = require("./src/sanitiser");
Object.defineProperty(exports, "ContextSanitiser", { enumerable: true, get: function () { return sanitiser_1.ContextSanitiser; } });
var injectionPatterns_1 = require("./src/patterns/injectionPatterns");
Object.defineProperty(exports, "INJECTION_PATTERNS", { enumerable: true, get: function () { return injectionPatterns_1.INJECTION_PATTERNS; } });
var trustResolver_1 = require("./src/trust/trustResolver");
Object.defineProperty(exports, "resolveTrustLevel", { enumerable: true, get: function () { return trustResolver_1.resolveTrustLevel; } });
Object.defineProperty(exports, "meetsTrustLevel", { enumerable: true, get: function () { return trustResolver_1.meetsTrustLevel; } });
Object.defineProperty(exports, "appliesAtTrustLevel", { enumerable: true, get: function () { return trustResolver_1.appliesAtTrustLevel; } });
//# sourceMappingURL=index.js.map