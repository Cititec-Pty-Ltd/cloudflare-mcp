import type { CallToolResult } from '../tools/types.js';

/** Extracts the text of the first content block, failing loudly if it isn't text. */
export function textOf(result: CallToolResult): string {
  const block = result.content?.[0];
  if (!block || block.type !== 'text') {
    throw new Error(`Expected a text content block, got: ${JSON.stringify(block)}`);
  }
  return block.text;
}

/** The JSON of a successful tool result. */
export function jsonOf(result: CallToolResult): Record<string, unknown> {
  if (result.isError) throw new Error(`Expected success, got: ${textOf(result)}`);
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

/** A Cloudflare v4 success envelope. */
export function ok(result: unknown, resultInfo?: Record<string, unknown>, status = 200): Response {
  return new Response(
    JSON.stringify({ success: true, errors: [], messages: [], result, ...(resultInfo ? { result_info: resultInfo } : {}) }),
    { status, headers: { 'Content-Type': 'application/json' } }
  );
}

/** A Cloudflare v4 error envelope. */
export function fail(status: number, errors: { code: number; message: string }[], headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ success: false, errors, messages: [], result: null }), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export const ZONE_ID = '0123456789abcdef0123456789abcdef';
export const RECORD_ID = 'fedcba9876543210fedcba9876543210';
export const ACCOUNT_ID = 'aaaabbbbccccddddeeeeffff00001111';

export const ZONE = {
  id: ZONE_ID,
  name: 'example.com.au',
  status: 'active',
  paused: false,
  type: 'full',
  development_mode: 0,
  name_servers: ['dom.ns.cloudflare.com', 'shaz.ns.cloudflare.com'],
  original_name_servers: ['ns1.example.net'],
  owner: { id: null, type: 'user', email: 'someone@example.com' },
  account: { id: ACCOUNT_ID, name: 'Example Client' },
  plan: { id: 'x', name: 'Free Website' },
  meta: { page_rule_quota: 3 },
  permissions: ['#zone:read', '#dns_records:edit'],
};
