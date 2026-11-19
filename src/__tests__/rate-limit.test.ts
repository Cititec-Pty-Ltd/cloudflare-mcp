import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RATE_LIMIT_RETRY, parseRetryAfter, retryDelayMs } from '../rate-limit.js';
import { cfRequest, runWithToken } from '../client.js';
import { dispatchToolCall } from '../tools/index.js';
import { CloudflareRateLimitError } from '../types.js';
import { ZONE, ZONE_ID, fail, ok, textOf } from './test-helpers.js';

const TOKEN = 'test-token-0123456789';
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const limited = (retryAfter?: string, status = 429) =>
  fail(status, [{ code: 971, message: 'Please wait and consider throttling your request speed' }], retryAfter !== undefined ? { 'Retry-After': retryAfter } : {});

describe('parseRetryAfter', () => {
  it('reads seconds and HTTP dates, ignores junk', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter('1.5')).toBe(1500);
    const now = Date.parse('2026-11-19T00:00:00Z');
    expect(parseRetryAfter('Thu, 19 Nov 2026 00:00:07 GMT', now)).toBe(7000);
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('-1')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  it('retries at most once, only for a Retry-After within 10 s', () => {
    expect(RATE_LIMIT_RETRY).toEqual({ maxRetries: 1, maxWaitMs: 10_000 });
    expect(retryDelayMs(0, 3000)).toBe(3000);
    expect(retryDelayMs(0, 10_001)).toBeUndefined();
    expect(retryDelayMs(0, undefined)).toBeUndefined();
    expect(retryDelayMs(1, 1000)).toBeUndefined();
  });
});

describe('429 handling', () => {
  it('a read waits for a short Retry-After and tries once more', async () => {
    fetchMock.mockResolvedValueOnce(limited('2')).mockResolvedValueOnce(ok([ZONE]));
    const p = cfRequest(TOKEN, 'GET', '/zones', { replaySafe: true });
    await vi.advanceTimersByTimeAsync(2000);
    await expect(p).resolves.toMatchObject({ result: [ZONE] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a read gives up after one retry, with the wait in the error', async () => {
    fetchMock.mockResolvedValueOnce(limited('1')).mockResolvedValueOnce(limited('4'));
    const p = cfRequest(TOKEN, 'GET', '/zones', { replaySafe: true }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(1000);
    const err = await p;
    expect(err).toBeInstanceOf(CloudflareRateLimitError);
    expect(err.message).toBe('Cloudflare rate-limited the request (HTTP 429): GET /zones. Try again in 4 s.');
    expect(err.retryAfterSeconds).toBe(4);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a read is not retried without Retry-After (5-minute block assumed) or with a long one', async () => {
    fetchMock.mockResolvedValueOnce(limited());
    await expect(cfRequest(TOKEN, 'GET', '/zones', { replaySafe: true })).rejects.toThrow(/Try again in 300 s/);
    fetchMock.mockResolvedValueOnce(limited('30'));
    await expect(cfRequest(TOKEN, 'GET', '/zones', { replaySafe: true })).rejects.toThrow(/Try again in 30 s/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a 503 is retried only with Retry-After', async () => {
    fetchMock.mockResolvedValueOnce(limited('1', 503)).mockResolvedValueOnce(ok([]));
    const p = cfRequest(TOKEN, 'GET', '/zones', { replaySafe: true });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toMatchObject({ result: [] });
    fetchMock.mockResolvedValueOnce(fail(503, [{ code: 1, message: 'down' }]));
    await expect(cfRequest(TOKEN, 'GET', '/zones', { replaySafe: true })).rejects.toThrow(/HTTP 503/);
  });

  it('a write is never retried, even with a short Retry-After', async () => {
    fetchMock.mockResolvedValueOnce(limited('1'));
    const err = await cfRequest(TOKEN, 'POST', `/zones/${ZONE_ID}/purge_cache`, { body: {}, replaySafe: false }).catch((e) => e);
    expect(err).toBeInstanceOf(CloudflareRateLimitError);
    expect(err.message).toMatch(/not retried/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a tool reports a structured rate_limited error the host limiter can read', async () => {
    fetchMock.mockResolvedValueOnce(limited('120'));
    const res = await runWithToken(TOKEN, () => dispatchToolCall('cloudflare_list_zones', {}));
    expect(res.isError).toBe(true);
    const text = textOf(res);
    // ratelimit.py looks for "HTTP 429" and "Try again in N s".
    expect(text).toMatch(/HTTP 429/);
    expect(text).toMatch(/Try again in 120 s/);
    expect(res.structuredContent).toMatchObject({ error: 'rate_limited', retry_after_seconds: 120 });
    expect(text).toContain('"retry_after_seconds":120');
  });

  it('an approved write that is rate-limited is sent once and reported', async () => {
    fetchMock.mockResolvedValueOnce(ok(ZONE)).mockResolvedValueOnce(limited('1'));
    const res = await runWithToken(TOKEN, () =>
      dispatchToolCall('cloudflare_purge_cache_everything', { zone_id: ZONE_ID, zone_name: 'example.com.au' })
    );
    expect(res.structuredContent).toMatchObject({ error: 'rate_limited', retry_after_seconds: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2); // the zone check and the one purge
  });
});
