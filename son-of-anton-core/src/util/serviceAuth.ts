/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Authorization header for calls from the agent runtime to the Son of Anton
 * backend services (spec-pipeline, penetration-tester, …).
 *
 * The backend services fail closed when `SOTA_SERVICE_TOKEN` is set: they
 * reject every non-health request that doesn't carry a matching
 * `Authorization: Bearer <token>`. Callers in the runtime must therefore
 * attach the same token. Returns the Bearer header when the token is set, or
 * an empty object when it isn't (so a password-less local dev stack keeps
 * working) — spread the result into the request headers.
 */
export function serviceAuthHeader(): Record<string, string> {
	const token = process.env.SOTA_SERVICE_TOKEN;
	return token && token.trim() ? { Authorization: `Bearer ${token.trim()}` } : {};
}
