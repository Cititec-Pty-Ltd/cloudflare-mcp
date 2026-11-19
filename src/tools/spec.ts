import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { cfRequest, getToken, scrub } from '../client.js';
import type { Envelope, Method } from '../client.js';
import { CloudflareApiError, CloudflareAuthError, CloudflareRateLimitError } from '../types.js';
import type { CallToolResult } from './types.js';
import {
  InputError,
  MismatchError,
  errorResult,
  missingTokenResult,
  redactSecrets,
  textResult,
  toDomain,
  toId,
  toZoneRef,
} from './shared.js';

/**
 * Every tool is a row in a table: a fixed name, typed parameters and a
 * handler that calls fixed Cloudflare API paths. No tool takes a free-form
 * path, method or body.
 */

export type ParamType = 'string' | 'int' | 'boolean' | 'id' | 'zone' | 'domain' | 'string_list';

export interface ParamSpec {
  type: ParamType;
  description: string;
  required?: boolean;
  enum?: readonly string[];
  min?: number;
  max?: number;
  minItems?: number;
  maxItems?: number;
  maxLength?: number;
  /** Send text exactly as given (no trimming), e.g. TXT content where whitespace can matter. */
  keepWhitespace?: boolean;
  default?: unknown;
}

/**
 * - read: changes nothing. Goes in the host's read_tools.
 * - write: changes something at Cloudflare. Goes in the host's write_tools,
 *   so every call is a proposal an administrator approves before it is sent.
 *   The change itself is sent once and never retried.
 */
export type ToolKind = 'read' | 'write';

/** What a handler may call. Reads get `get` and `graphql` only. */
export interface Api {
  /** A GET (replay-safe; retried once on a short Retry-After). */
  get(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<Envelope>;
  /** The GraphQL Analytics API (a POST that only reads; replay-safe). */
  graphql(query: string, variables: Record<string, unknown>): Promise<Envelope>;
  /** The one change a write tool makes. Never retried. Throws for read tools. */
  change(method: Exclude<Method, 'GET'>, path: string, body?: unknown): Promise<Envelope>;
}

export interface ToolSpec {
  name: string;
  description: string;
  kind: ToolKind;
  /** Deletes something or cannot be undone simply (delete a record, purge everything): the host may gate these further. */
  destructive?: boolean;
  params: Record<string, ParamSpec>;
  /** Extra checks across parameters (after conversion). */
  validate?: (args: Record<string, unknown>) => void;
  run: (args: Record<string, unknown>, api: Api) => Promise<unknown>;
}

function jsonSchemaFor(p: ParamSpec): Record<string, unknown> {
  const description = p.description;
  switch (p.type) {
    case 'boolean':
      return { type: 'boolean', description };
    case 'int':
      return {
        type: 'integer',
        description,
        ...(p.min !== undefined ? { minimum: p.min } : {}),
        ...(p.max !== undefined ? { maximum: p.max } : {}),
      };
    case 'string_list':
      return {
        type: 'array',
        items: { type: 'string' },
        description,
        ...(p.minItems !== undefined ? { minItems: p.minItems } : {}),
        ...(p.maxItems !== undefined ? { maxItems: p.maxItems } : {}),
      };
    default:
      return {
        type: 'string',
        description,
        ...(p.enum ? { enum: [...p.enum] } : {}),
        ...(p.maxLength !== undefined ? { maxLength: p.maxLength } : {}),
      };
  }
}

export function buildTool(spec: ToolSpec): Tool {
  const properties: Record<string, object> = {};
  const required: string[] = [];
  for (const [key, p] of Object.entries(spec.params)) {
    properties[key] = jsonSchemaFor(p);
    if (p.required) required.push(key);
  }
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false },
    annotations: {
      readOnlyHint: spec.kind === 'read',
      destructiveHint: spec.kind === 'write' && spec.destructive === true,
      idempotentHint: spec.kind === 'read',
      openWorldHint: true,
    },
  };
}

function convert(key: string, p: ParamSpec, value: unknown): unknown {
  switch (p.type) {
    case 'boolean':
      if (typeof value !== 'boolean') throw new InputError(`${key} must be true or false`);
      return value;
    case 'int': {
      const n = typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isInteger(n)) throw new InputError(`${key} must be a whole number`);
      if (p.min !== undefined && n < p.min) throw new InputError(`${key} must be at least ${p.min}`);
      if (p.max !== undefined && n > p.max) throw new InputError(`${key} must be at most ${p.max}`);
      return n;
    }
    case 'id':
      return toId(value, key);
    case 'zone':
      return toZoneRef(value, key);
    case 'domain':
      return toDomain(value, key);
    case 'string_list': {
      if (!Array.isArray(value) || value.length === 0) throw new InputError(`${key} must be a non-empty list`);
      if (p.minItems !== undefined && value.length < p.minItems) throw new InputError(`${key} needs at least ${p.minItems} entries`);
      if (p.maxItems !== undefined && value.length > p.maxItems) throw new InputError(`${key} can have at most ${p.maxItems} entries`);
      const list = value.map((v, i) => {
        if (typeof v !== 'string' || v.trim() === '') throw new InputError(`${key}[${i}] must be text`);
        if (p.maxLength !== undefined && v.trim().length > p.maxLength) {
          throw new InputError(`${key}[${i}] is longer than ${p.maxLength} characters`);
        }
        return v.trim();
      });
      if (new Set(list).size !== list.length) throw new InputError(`${key} has the same entry twice`);
      return list;
    }
    default: {
      if (typeof value !== 'string') throw new InputError(`${key} must be text`);
      const s = p.keepWhitespace ? value : value.trim();
      if (s.trim() === '') throw new InputError(`${key} must not be empty`);
      if (p.enum && !p.enum.includes(s)) throw new InputError(`${key} must be one of: ${p.enum.join(', ')}`);
      if (p.maxLength !== undefined && s.length > p.maxLength) throw new InputError(`${key} is longer than ${p.maxLength} characters`);
      return s;
    }
  }
}

/** Validates and converts the arguments. Exported for tests. */
export function parseArgs(spec: ToolSpec, args: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(args)) {
    if (!(key in spec.params)) throw new InputError(`Unknown parameter: ${key}`);
  }
  const out: Record<string, unknown> = {};
  for (const [key, p] of Object.entries(spec.params)) {
    const given = args[key];
    const raw = given === undefined || given === null ? p.default : given;
    if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '' && !p.keepWhitespace)) {
      if (p.required) throw new InputError(`${key} is required`);
      continue;
    }
    out[key] = convert(key, p, raw);
  }
  spec.validate?.(out);
  return out;
}

function makeApi(token: string, kind: ToolKind): Api {
  let changes = 0;
  return {
    get: (path, query) => cfRequest(token, 'GET', path, { query, replaySafe: true }),
    graphql: (query, variables) => cfRequest(token, 'POST', '/graphql', { body: { query, variables }, replaySafe: true }),
    change: (method, path, body) => {
      if (kind !== 'write') throw new Error('internal: a read tool tried to make a change');
      // One change per approved proposal: what the approver saw is all that is sent.
      if (++changes > 1) throw new Error('internal: a write tool tried to make a second change');
      return cfRequest(token, method, path, { body, replaySafe: false });
    },
  };
}

export async function runSpec(spec: ToolSpec, args: Record<string, unknown>): Promise<CallToolResult> {
  const token = getToken();
  if (!token) return missingTokenResult();
  try {
    const parsed = parseArgs(spec, args);
    const out = await spec.run(parsed, makeApi(token, spec.kind));
    return textResult(redactSecrets(out));
  } catch (err) {
    const message = scrub((err as Error).message, token);
    if (err instanceof CloudflareRateLimitError) return errorResult(message, 'rate_limited', err.retryAfterSeconds);
    if (err instanceof CloudflareAuthError) return errorResult(message, 'auth');
    if (err instanceof InputError) return errorResult(message, 'invalid_input');
    if (err instanceof MismatchError) return errorResult(`${message} Nothing was changed.`, 'invalid_input');
    if (err instanceof CloudflareApiError && err.httpStatus === 404) return errorResult(message, 'not_found');
    return errorResult(message, 'api_error');
  }
}
