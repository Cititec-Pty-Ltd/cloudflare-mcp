import { AsyncLocalStorage } from 'node:async_hooks';
import { logger } from './utils/logger.js';
import { DEFAULT_RETRY_AFTER_SECONDS, fetchWithRateLimitRetry, retryAfterSecondsOf } from './rate-limit.js';
import { CloudflareApiError, CloudflareAuthError, CloudflareRateLimitError } from './types.js';

/** Cloudflare API v4. Fixed: the token is never sent anywhere else. */
export const API_BASE = 'https://api.cloudflare.com/client/v4';

/** Largest response read, in characters. */
const MAX_RESPONSE_CHARS = 20_000_000;

const TOKEN_HINT =
  ' Check CLOUDFLARE_API_TOKEN: the token may be expired, revoked, limited to other accounts or zones,' +
  ' limited by client IP address, or missing the permission this tool needs (see the README).';

// Request-scoped token, for tests and embedding. The MCP host uses the
// process environment (the service's env file).
const tokenStore = new AsyncLocalStorage<string>();

export function runWithToken<T>(token: string, fn: () => T): T {
  return tokenStore.run(token, fn);
}

export function getToken(): string | null {
  const scoped = tokenStore.getStore();
  if (scoped) return scoped;
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!token) {
    logger.warn('Missing CLOUDFLARE_API_TOKEN');
    return null;
  }
  return token;
}

/** Removes the token from any text that leaves this module. */
export function scrub(text: string, token: string): string {
  return token.length >= 8 ? text.split(token).join('[REDACTED]') : text;
}

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** True for reads (GET, and the GraphQL analytics POST): only these are retried after a 429. */
  replaySafe: boolean;
  timeoutMs?: number;
}

export interface Envelope {
  result: unknown;
  result_info?: Record<string, unknown>;
  messages?: unknown[];
  /** GraphQL only. */
  data?: unknown;
}

interface CfError {
  code?: number;
  message?: string;
}

function errorList(json: unknown): CfError[] {
  const errs = (json as { errors?: unknown })?.errors;
  return Array.isArray(errs) ? (errs.filter((e) => e && typeof e === 'object') as CfError[]) : [];
}

function describeErrors(errs: CfError[], token: string): string {
  return scrub(
    errs
      .slice(0, 5)
      .map((e) => (e.code !== undefined ? `${e.code}: ${e.message ?? ''}` : String(e.message ?? '')))
      .join('; '),
    token
  ).slice(0, 600);
}

/** Error codes Cloudflare uses for a bad or under-privileged token. */
const AUTH_CODES = new Set([6003, 6111, 9106, 9109, 10000]);

/** The path as shown in messages: method and path, never the query or body. */
function label(method: Method, path: string): string {
  return `${method} ${path}`;
}

/**
 * Sends one request and returns the decoded envelope. Throws on a network
 * error, HTTP 429 (CloudflareRateLimitError), 401/403 (CloudflareAuthError),
 * success=false, a non-2xx status or (GraphQL) an errors array.
 * Messages carry the method, path and Cloudflare's error codes, never the token.
 */
export async function cfRequest(token: string, method: Method, path: string, options: RequestOptions): Promise<Envelope> {
  if (!path.startsWith('/') || path.includes('..') || /[?#\s]/.test(path)) {
    throw new CloudflareApiError(`internal: bad path ${path}`);
  }
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(options.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const what = label(method, path);
  let res: Response;
  try {
    res = await fetchWithRateLimitRetry(url.toString(), what, options.replaySafe, () => ({
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    }));
  } catch (err) {
    const e = err as Error;
    const why = e.name === 'TimeoutError' ? 'timed out' : `failed (${e.name}: ${scrub(e.message, token).slice(0, 200)})`;
    throw new CloudflareApiError(`Cloudflare ${what} ${why}`);
  }

  if (res.status === 429 || (res.status === 503 && retryAfterSecondsOf(res) !== undefined)) {
    const wait = retryAfterSecondsOf(res) ?? DEFAULT_RETRY_AFTER_SECONDS;
    await res.body?.cancel().catch(() => undefined);
    throw new CloudflareRateLimitError(
      `Cloudflare rate-limited the request (HTTP ${res.status}): ${what}. Try again in ${wait} s.` +
        (options.replaySafe ? '' : ' The change was not retried; check whether it happened before proposing it again.'),
      wait
    );
  }

  const length = Number(res.headers.get('content-length') ?? '0');
  if (length > MAX_RESPONSE_CHARS) {
    await res.body?.cancel().catch(() => undefined);
    throw new CloudflareApiError(`Cloudflare ${what}: response too large (${length} bytes)`, res.status);
  }
  const text = await res.text();
  if (text.length > MAX_RESPONSE_CHARS) throw new CloudflareApiError(`Cloudflare ${what}: response too large`, res.status);

  let json: unknown;
  try {
    json = text === '' ? {} : JSON.parse(text);
  } catch {
    throw new CloudflareApiError(`Cloudflare ${what} failed: HTTP ${res.status} (not JSON)`, res.status);
  }
  const errs = errorList(json);
  const codes = errs.map((e) => e.code).filter((c): c is number => typeof c === 'number');
  const detail = describeErrors(errs, token);

  if (res.status === 401 || res.status === 403 || (!res.ok && codes.some((c) => AUTH_CODES.has(c)))) {
    throw new CloudflareAuthError(
      `Cloudflare refused the request (HTTP ${res.status}): ${what}${detail ? ` - ${detail}` : ''}.${TOKEN_HINT}`,
      res.status
    );
  }
  const body = json as { success?: boolean; result?: unknown; result_info?: Record<string, unknown>; messages?: unknown[]; data?: unknown };
  const graphql = path === '/graphql';
  if (!res.ok || (!graphql && body.success === false) || (graphql && errs.length > 0)) {
    throw new CloudflareApiError(
      `Cloudflare ${what} failed: HTTP ${res.status}${detail ? ` - ${detail}` : ''}`,
      res.status,
      codes
    );
  }
  return { result: body.result, result_info: body.result_info, messages: body.messages, data: body.data };
}
