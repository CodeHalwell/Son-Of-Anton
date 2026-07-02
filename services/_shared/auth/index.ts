// Copyright (c) Son-Of-Anton. All rights reserved.
// Licensed under the MIT License.
//
// Shared service authentication for Son of Anton backend services.
//
// Every backend HTTP service authenticates inbound requests with a single
// shared bearer token read from the `SOTA_SERVICE_TOKEN` environment variable:
//
//   * `requireServiceToken(name)` — call once at process startup. If the token
//     is unset the service logs and exits non-zero, so a service never boots
//     unauthenticated (fail closed).
//   * `createAuthMiddleware()` — Express middleware enforcing the bearer token.
//   * `enforceHttpAuth(req, res)` — helper for services that hand-roll
//     `http.createServer`.
//   * `serviceAuthHeaders()` — attach the bearer token to outbound
//     inter-service requests so downstream services keep accepting them.
//
// `/health` and `/metrics` are always exempt so readiness probes and Prometheus
// scrapers keep working. Token comparison is constant-time via
// `crypto.timingSafeEqual`.

import { timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';

/** Environment variable that holds the shared inter-service bearer token. */
export const SERVICE_TOKEN_ENV = 'SOTA_SERVICE_TOKEN';

/** Paths that never require authentication (liveness probes and metrics scraping). */
const EXEMPT_PATHS = new Set<string>(['/health', '/metrics']);

const UNAUTHORIZED_BODY = JSON.stringify({ error: 'Unauthorized — missing or invalid bearer token' });

/**
 * Read the shared service token from the environment, failing closed when it is
 * unset. Logs an error and exits the process with a non-zero code so a service
 * never starts without inter-service authentication configured.
 *
 * Call this once from a service's real startup entrypoint (never from the code
 * paths exercised by unit tests).
 */
export function requireServiceToken(serviceName: string): string {
	const token = process.env[SERVICE_TOKEN_ENV] ?? '';
	if (!token) {
		console.error(
			`[${serviceName}] ${SERVICE_TOKEN_ENV} must be set to run ${serviceName}; ` +
			'refusing to start without inter-service authentication.'
		);
		process.exit(1);
	}
	return token;
}

/** Resolve the expected token, preferring an explicit value over the environment. */
function resolveToken(token?: string): string {
	return token ?? process.env[SERVICE_TOKEN_ENV] ?? '';
}

/** Constant-time comparison of the expected and provided tokens. */
function tokensMatch(expected: string, provided: string): boolean {
	const expectedBuffer = Buffer.from(expected, 'utf8');
	const providedBuffer = Buffer.from(provided, 'utf8');
	if (expectedBuffer.length !== providedBuffer.length) {
		return false;
	}
	return timingSafeEqual(expectedBuffer, providedBuffer);
}

/** Extract the token from an `Authorization: Bearer <token>` header value. */
function extractBearer(header: string | string[] | undefined): string | undefined {
	const value = Array.isArray(header) ? header[0] : header;
	if (typeof value !== 'string') {
		return undefined;
	}
	const match = value.match(/^Bearer\s+(.+)$/i);
	return match ? match[1].trim() : undefined;
}

/** Normalise a request path, stripping any query string. */
function normalisePath(pathname: string | undefined): string {
	return (pathname ?? '/').split('?')[0];
}

/** True if `pathname` is exempt from authentication (health/metrics probes). */
export function isExemptPath(pathname: string | undefined): boolean {
	return EXEMPT_PATHS.has(normalisePath(pathname));
}

/**
 * Validate the bearer token on a set of request headers against `expectedToken`.
 * Returns true only when a matching `Authorization: Bearer <token>` is present.
 */
export function isAuthorized(headers: Pick<IncomingHttpHeaders, 'authorization'>, expectedToken: string): boolean {
	const provided = extractBearer(headers.authorization);
	if (provided === undefined) {
		return false;
	}
	return tokensMatch(expectedToken, provided);
}

/**
 * Enforce bearer-token auth on a raw Node `http` request. Health and metrics
 * probes are exempt. Returns true when the caller should continue handling the
 * request; when it returns false a 401 response has already been written and the
 * handler must stop.
 *
 * When no token is configured this is a pass-through — the startup check in
 * `requireServiceToken` guarantees a token is present in production, so this
 * only affects tests and library-style imports.
 */
export function enforceHttpAuth(req: IncomingMessage, res: ServerResponse, token?: string): boolean {
	if (isExemptPath(req.url)) {
		return true;
	}
	const expected = resolveToken(token);
	if (!expected || isAuthorized(req.headers, expected)) {
		return true;
	}
	res.writeHead(401, { 'Content-Type': 'application/json' });
	res.end(UNAUTHORIZED_BODY);
	return false;
}

/** Minimal structural view of an Express request used by the auth middleware. */
export interface AuthRequestLike {
	headers: Pick<IncomingHttpHeaders, 'authorization'>;
	path?: string;
	url?: string;
}

/** Minimal structural view of an Express response used by the auth middleware. */
export interface AuthResponseLike {
	status(code: number): AuthResponseLike;
	json(body: unknown): unknown;
}

/** Express `next` callback shape. */
export type AuthNextLike = (err?: unknown) => void;

/** Express middleware handler shape produced by {@link createAuthMiddleware}. */
export type AuthMiddleware = (req: AuthRequestLike, res: AuthResponseLike, next: AuthNextLike) => void;

/**
 * Create an Express middleware that enforces bearer-token auth on every request,
 * exempting `/health` and `/metrics`.
 *
 * When no token is configured the middleware is a pass-through (see
 * {@link enforceHttpAuth}); the startup check in {@link requireServiceToken}
 * guarantees a token is present in production.
 */
export function createAuthMiddleware(token?: string): AuthMiddleware {
	return function authMiddleware(req: AuthRequestLike, res: AuthResponseLike, next: AuthNextLike): void {
		const pathname = req.path ?? req.url;
		if (isExemptPath(pathname)) {
			next();
			return;
		}
		const expected = resolveToken(token);
		if (!expected || isAuthorized(req.headers, expected)) {
			next();
			return;
		}
		res.status(401).json({ error: 'Unauthorized — missing or invalid bearer token' });
	};
}

/**
 * Build the `Authorization` header for an outbound inter-service request. Spread
 * the result into an existing headers object. Returns an empty object when no
 * token is configured so behaviour is unchanged in unauthenticated setups.
 */
export function serviceAuthHeaders(token?: string): Record<string, string> {
	const resolved = resolveToken(token);
	return resolved ? { Authorization: `Bearer ${resolved}` } : {};
}
