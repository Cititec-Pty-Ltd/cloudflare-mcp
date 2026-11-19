import { logger } from './utils/logger.js';

/**
 * Bounded retry for rate-limited responses (Cititec fleet 429 policy).
 *
 * Cloudflare allows 1,200 requests per 5 minutes per user (dashboard and API
 * tokens counted together) and 200 requests per second per IP. Going over
 * answers HTTP 429 and blocks every call for 5 minutes
 * (developers.cloudflare.com/fundamentals/api/reference/limits).
 *
 * - A read (replay-safe) is retried once, only when Retry-After is given and
 *   is at most 10 s. With no Retry-After, or a longer one, the caller gets
 *   the error at once, so a tool call is never held for long.
 * - A write is never retried: nothing says a rate-limited write was rejected
 *   before it ran, and an approved proposal must be sent at most once.
 */
export const RATE_LIMIT_RETRY = {
  /** Retries after the first attempt (fleet 429 policy: at most one). */
  maxRetries: 1,
  /** Longest wait that is retried. A missing or larger Retry-After is not retried. */
  maxWaitMs: 10_000,
};

/** Wait reported for a 429 without Retry-After: Cloudflare blocks for 5 minutes. */
export const DEFAULT_RETRY_AFTER_SECONDS = 300;

/** Parses a Retry-After value into milliseconds from `now`; undefined if absent or invalid. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.ceil(Number(trimmed) * 1000);
  if (!/[a-z]/i.test(trimmed)) return undefined;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/** Whole seconds from a response's Retry-After header (at least 1), or undefined. */
export function retryAfterSecondsOf(res: Response): number | undefined {
  const ms = parseRetryAfter(res.headers.get('retry-after'));
  return ms === undefined ? undefined : Math.max(1, Math.ceil(ms / 1000));
}

/** Milliseconds to wait before retry number `attempt` (0-based), or undefined for no retry. */
export function retryDelayMs(attempt: number, retryAfterMs: number | undefined): number | undefined {
  if (attempt >= RATE_LIMIT_RETRY.maxRetries) return undefined;
  if (retryAfterMs === undefined || retryAfterMs > RATE_LIMIT_RETRY.maxWaitMs) return undefined;
  return retryAfterMs;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * fetch() with the bounded retry above. `makeInit` is called for every
 * attempt so each one gets a fresh timeout signal. `replaySafe` is true only
 * for reads. Returns the last response, which may still be a 429.
 */
export async function fetchWithRateLimitRetry(
  url: string,
  label: string,
  replaySafe: boolean,
  makeInit: () => RequestInit
): Promise<Response> {
  let res = await fetch(url, makeInit());
  for (let attempt = 0; ; attempt++) {
    const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
    const retryable = replaySafe && (res.status === 429 || (res.status === 503 && retryAfterMs !== undefined));
    if (!retryable) return res;
    const delay = retryDelayMs(attempt, retryAfterMs);
    if (delay === undefined) return res;
    logger.warn('Cloudflare asked us to slow down; retrying', { status: res.status, request: label, delayMs: delay });
    await res.body?.cancel().catch(() => undefined);
    await sleep(delay);
    res = await fetch(url, makeInit());
  }
}
