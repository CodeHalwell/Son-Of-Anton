import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
/** Environment variable that holds the shared inter-service bearer token. */
export declare const SERVICE_TOKEN_ENV = "SOTA_SERVICE_TOKEN";
/**
 * Read the shared service token from the environment, failing closed when it is
 * unset. Logs an error and exits the process with a non-zero code so a service
 * never starts without inter-service authentication configured.
 *
 * Call this once from a service's real startup entrypoint (never from the code
 * paths exercised by unit tests).
 */
export declare function requireServiceToken(serviceName: string): string;
/** True if `pathname` is exempt from authentication (health/metrics probes). */
export declare function isExemptPath(pathname: string | undefined): boolean;
/**
 * Validate the bearer token on a set of request headers against `expectedToken`.
 * Returns true only when a matching `Authorization: Bearer <token>` is present.
 */
export declare function isAuthorized(headers: Pick<IncomingHttpHeaders, 'authorization'>, expectedToken: string): boolean;
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
export declare function enforceHttpAuth(req: IncomingMessage, res: ServerResponse, token?: string): boolean;
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
export declare function createAuthMiddleware(token?: string): AuthMiddleware;
/**
 * Build the `Authorization` header for an outbound inter-service request. Spread
 * the result into an existing headers object. Returns an empty object when no
 * token is configured so behaviour is unchanged in unauthenticated setups.
 */
export declare function serviceAuthHeaders(token?: string): Record<string, string>;
