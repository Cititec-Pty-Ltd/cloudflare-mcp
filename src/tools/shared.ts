import type { CallToolResult } from './types.js';

/** Largest tool response, in characters. Bigger results are cut with a note, so one call cannot flood the conversation. */
export const MAX_RESPONSE_CHARS = 60_000;

export function textResult(value: unknown): CallToolResult {
  let text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text.length > MAX_RESPONSE_CHARS) {
    text =
      text.slice(0, MAX_RESPONSE_CHARS) +
      `\n... [response cut at ${MAX_RESPONSE_CHARS} characters; narrow the request (a filter, a smaller per_page) and call again]`;
  }
  return { content: [{ type: 'text', text }] };
}

/** Error codes in structured errors. */
export type ErrorKind = 'rate_limited' | 'auth' | 'invalid_input' | 'not_found' | 'api_error' | 'config';

/**
 * A tool error. The first line is for people and for the MCP host's rate
 * limiter ("HTTP 429 ... Try again in N s"); `structuredContent` carries the
 * same as data: { error, message, retry_after_seconds? }.
 */
export function errorResult(message: string, kind: ErrorKind = 'api_error', retryAfterSeconds?: number): CallToolResult {
  const structured: Record<string, unknown> = {
    error: kind,
    message,
    ...(retryAfterSeconds !== undefined ? { retry_after_seconds: retryAfterSeconds } : {}),
  };
  return {
    content: [{ type: 'text', text: `Error: ${message}\n${JSON.stringify(structured)}` }],
    structuredContent: structured,
    isError: true,
  };
}

export function missingTokenResult(): CallToolResult {
  return errorResult('No Cloudflare API token configured. Set CLOUDFLARE_API_TOKEN.', 'config');
}

/** Thrown for bad tool input; the message is shown to the caller as is. */
export class InputError extends Error {}

/** Thrown when a write's safety check fails (zone or record is not what the proposal named). Nothing was changed. */
export class MismatchError extends Error {}

/** A Cloudflare identifier: 32 hex characters (zones, accounts, DNS records). */
export const ID32 = /^[0-9a-f]{32}$/;

export function toId(value: unknown, key: string): string {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!ID32.test(s)) throw new InputError(`${key} must be a Cloudflare ID (32 hexadecimal characters)`);
  return s;
}

// A domain name: letters, digits and hyphens per label (IDNs as xn--), at least two labels.
const DOMAIN = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

export function toDomain(value: unknown, key: string): string {
  if (typeof value !== 'string') throw new InputError(`${key} must be a domain name, e.g. example.com.au`);
  const d = value.trim().toLowerCase().replace(/\.$/, '');
  if (!DOMAIN.test(d)) throw new InputError(`${key} must be a domain name, e.g. example.com.au (IDNs in xn-- form)`);
  return d;
}

/** A zone: its ID, or its name. */
export function toZoneRef(value: unknown, key: string): string {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (ID32.test(s)) return s;
  return toDomain(value, key);
}

// A DNS record name label: letters, digits, hyphens, underscores (_dmarc, _domainkey), or a leading "*".
const RECORD_LABEL = /^(?:\*|[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)$/;

/**
 * A record name as the full name within `zone`. Accepts "@" (the apex), a
 * relative name ("www", "_dmarc") or the full name ("www.example.com.au").
 */
export function toRecordName(value: unknown, zone: string, key: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new InputError(`${key} must be a record name, e.g. www or @`);
  let n = value.trim().toLowerCase().replace(/\.$/, '');
  if (n === '@') return zone;
  if (n !== zone && !n.endsWith(`.${zone}`)) n = `${n}.${zone}`;
  if (n.length > 253) throw new InputError(`${key} is too long`);
  const labels = n.slice(0, n.length - zone.length).replace(/\.$/, '');
  if (labels !== '') {
    const parts = labels.split('.');
    parts.forEach((p, i) => {
      if (!RECORD_LABEL.test(p) || (p === '*' && i !== 0)) {
        throw new InputError(`${key}: "${p}" is not a valid DNS label (letters, digits, hyphens, underscores; "*" only first)`);
      }
    });
  }
  return n;
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV6 = /^[0-9a-f:.]{2,45}$/i;

export function isIpv4(s: string): boolean {
  return IPV4.test(s);
}

export function isIpv6(s: string): boolean {
  return IPV6.test(s) && s.includes(':') && (s.match(/::/g) ?? []).length <= 1;
}

/** Keeps only the listed keys that are present. */
export function pick(obj: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!obj || typeof obj !== 'object') return {};
  const src = obj as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (src[k] !== undefined && src[k] !== null && src[k] !== '') out[k] = src[k];
  }
  return out;
}

export function asList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value.filter((v) => v && typeof v === 'object') as Record<string, unknown>[]) : [];
}

/**
 * Field names that can hold a secret in Cloudflare responses (Access SaaS app
 * client secrets, service tokens, private keys, tunnel tokens, ...). Every
 * tool result is passed through redactSecrets as a second line of defence;
 * the shapes already keep only listed fields.
 */
const SECRET_FIELD = /^(?:client_secret|secret|.*_secret|token|.*_token|api_key|apikey|private_key|privatekey|key|password|.*_password|signing_key|tunnel_secret|credentials)$/i;

/** Field names that look secret but are not (kept as is). */
const NOT_SECRET = new Set(['token_type']);

export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 32) return value;
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] =
        SECRET_FIELD.test(k) && !NOT_SECRET.has(k.toLowerCase()) && v !== null && v !== '' && typeof v !== 'boolean'
          ? '[hidden]'
          : redactSecrets(v, depth + 1);
    }
    return out;
  }
  return value;
}
