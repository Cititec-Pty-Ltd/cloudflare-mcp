/** Cloudflare refused the token (HTTP 401/403, or an authentication error code). */
export class CloudflareAuthError extends Error {
  constructor(message: string, readonly httpStatus?: number) {
    super(message);
  }
}

/** Cloudflare rate-limited the request (HTTP 429, or 503 with Retry-After). */
export class CloudflareRateLimitError extends Error {
  /** Seconds to wait before trying again (Retry-After, or 300 when Cloudflare did not say). */
  constructor(message: string, readonly retryAfterSeconds: number) {
    super(message);
  }
}

/** Any other failure: success=false, a non-2xx status, a GraphQL error, a timeout. */
export class CloudflareApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number,
    readonly codes: readonly number[] = []
  ) {
    super(message);
  }
}
