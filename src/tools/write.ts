import type { Api, ParamSpec, ToolSpec } from './spec.js';
import { InputError, MismatchError, isIpv4, isIpv6, pick, toRecordName } from './shared.js';
import { recordSummary } from './read.js';
import { ZONE_ID, ZONE_NAME, verifyZone } from './zone.js';

// Write tools. On the MCP host each call is a proposal that an administrator
// approves before it runs. Every write takes zone_id AND zone_name: before
// changing anything the server reads the zone and stops if the ID is not that
// zone (and, for record changes, reads the record and stops if it is not the
// one named). Then it sends exactly one change, never retried.

/** Record types the write tools accept (content is a single value for each). */
export const RECORD_TYPES_WRITE = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'] as const;
const PROXIABLE = new Set(['A', 'AAAA', 'CNAME']);

const HOST = /^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/i;

function checkContent(type: string, content: string): void {
  const c = content.trim();
  switch (type) {
    case 'A':
      if (!isIpv4(c)) throw new InputError('content must be an IPv4 address for an A record');
      return;
    case 'AAAA':
      if (!isIpv6(c)) throw new InputError('content must be an IPv6 address for an AAAA record');
      return;
    case 'CNAME':
    case 'MX':
    case 'NS':
      if (!HOST.test(c.replace(/\.$/, ''))) throw new InputError(`content must be a host name for a ${type} record`);
      return;
    case 'TXT':
      if (content.length > 2048) throw new InputError('TXT content is longer than 2048 characters');
      return;
    default:
      throw new InputError(`record type ${type} cannot be changed with these tools`);
  }
}

function checkTtl(ttl: unknown): void {
  if (ttl !== undefined && ttl !== 1 && ((ttl as number) < 60 || (ttl as number) > 86400)) {
    throw new InputError('ttl must be 1 (automatic) or 60 to 86400 seconds');
  }
}

const RECORD_ID: ParamSpec = { type: 'id', required: true, description: 'The DNS record ID (from cloudflare_list_dns_records).' };

const CONTENT: ParamSpec = {
  type: 'string',
  keepWhitespace: true,
  maxLength: 2048,
  description: 'Record content: an IPv4 (A) or IPv6 (AAAA) address, a host name (CNAME, MX, NS), or TXT text without surrounding quotes.',
};
const TTL: ParamSpec = { type: 'int', min: 1, max: 86400, description: 'TTL in seconds: 1 = automatic (default), or 60 to 86400.' };
const PROXIED: ParamSpec = {
  type: 'boolean',
  description: 'Proxy through Cloudflare (orange cloud). A, AAAA and CNAME only; default false (DNS only).',
};
const PRIORITY: ParamSpec = { type: 'int', min: 0, max: 65535, description: 'MX priority (required for MX).' };
const COMMENT: ParamSpec = { type: 'string', maxLength: 100, description: 'A note on the record (Cloudflare record comment).' };
const COMMENT_UPDATE: ParamSpec = {
  ...COMMENT,
  allowEmpty: true,
  description: 'New note on the record (Cloudflare record comment); "" removes the existing one.',
};

async function getRecord(api: Api, zoneId: string, recordId: string): Promise<Record<string, unknown>> {
  const { result } = await api.get(`/zones/${zoneId}/dns_records/${recordId}`);
  return (result ?? {}) as Record<string, unknown>;
}

function zoneArgs(a: Record<string, unknown>): [string, string] {
  return [a.zone_id as string, a.zone_name as string];
}

async function setSetting(api: Api, a: Record<string, unknown>, setting: string, value: string) {
  const [zoneId, zoneName] = zoneArgs(a);
  await verifyZone(api, zoneId, zoneName);
  const { result } = await api.change('PATCH', `/zones/${zoneId}/settings/${setting}`, { value });
  return { zone: zoneName, zone_id: zoneId, setting, ...pick(result, ['value', 'modified_on']) };
}

export const WRITE_SPECS: ToolSpec[] = [
  {
    name: 'cloudflare_create_dns_record',
    kind: 'write',
    description:
      'Create a DNS record (A, AAAA, CNAME, MX, TXT or NS) in a zone. name may be "@", "www" or the full name. ' +
      'Proposal: an administrator approves it before it runs.',
    params: {
      zone_id: ZONE_ID,
      zone_name: ZONE_NAME,
      type: { type: 'string', required: true, enum: RECORD_TYPES_WRITE, description: 'Record type.' },
      name: { type: 'string', required: true, maxLength: 253, description: 'Record name: "@" (the apex), "www", or the full name.' },
      content: { ...CONTENT, required: true },
      ttl: TTL,
      proxied: PROXIED,
      priority: PRIORITY,
      comment: COMMENT,
    },
    validate: (a) => {
      const type = a.type as string;
      checkContent(type, a.content as string);
      checkTtl(a.ttl);
      if (type === 'MX' && a.priority === undefined) throw new InputError('priority is required for an MX record');
      if (type !== 'MX' && a.priority !== undefined) throw new InputError('priority is only for MX records');
      if (a.proxied === true && !PROXIABLE.has(type)) throw new InputError('only A, AAAA and CNAME records can be proxied');
      if (a.proxied === true && a.ttl !== undefined && a.ttl !== 1) throw new InputError('a proxied record has ttl 1 (automatic)');
      toRecordName(a.name, a.zone_name as string, 'name');
    },
    run: async (a, api) => {
      const [zoneId, zoneName] = zoneArgs(a);
      await verifyZone(api, zoneId, zoneName);
      const type = a.type as string;
      const body = {
        type,
        name: toRecordName(a.name, zoneName, 'name'),
        content: type === 'TXT' ? (a.content as string) : (a.content as string).trim(),
        ttl: (a.ttl as number | undefined) ?? 1,
        ...(PROXIABLE.has(type) ? { proxied: a.proxied === true } : {}),
        ...(a.priority !== undefined ? { priority: a.priority } : {}),
        ...(a.comment !== undefined ? { comment: a.comment } : {}),
      };
      const { result } = await api.change('POST', `/zones/${zoneId}/dns_records`, body);
      return { created: true, zone: zoneName, record: recordSummary((result ?? {}) as Record<string, unknown>) };
    },
  },
  {
    name: 'cloudflare_update_dns_record',
    kind: 'write',
    description:
      'Change a DNS record: its content, name, TTL, proxied, MX priority or comment (not its type). current_name must be the ' +
      'record\'s name now; it is checked first. Proposal: an administrator approves it before it runs.',
    params: {
      zone_id: ZONE_ID,
      zone_name: ZONE_NAME,
      record_id: RECORD_ID,
      current_name: {
        type: 'string',
        required: true,
        maxLength: 253,
        description: 'The record\'s name now ("@", "www" or the full name). If it does not match, nothing is changed.',
      },
      name: { type: 'string', maxLength: 253, description: 'New name, if it changes.' },
      content: CONTENT,
      ttl: TTL,
      proxied: PROXIED,
      priority: PRIORITY,
      comment: COMMENT_UPDATE,
    },
    validate: (a) => {
      if (['name', 'content', 'ttl', 'proxied', 'priority', 'comment'].every((k) => a[k] === undefined)) {
        throw new InputError('give at least one of name, content, ttl, proxied, priority, comment');
      }
      checkTtl(a.ttl);
      toRecordName(a.current_name, a.zone_name as string, 'current_name');
      if (a.name !== undefined) toRecordName(a.name, a.zone_name as string, 'name');
    },
    run: async (a, api) => {
      const [zoneId, zoneName] = zoneArgs(a);
      await verifyZone(api, zoneId, zoneName);
      const before = await getRecord(api, zoneId, a.record_id as string);
      const currentName = toRecordName(a.current_name, zoneName, 'current_name');
      if (String(before.name ?? '').toLowerCase() !== currentName) {
        throw new MismatchError(`Record ${String(a.record_id)} is ${String(before.name)}, not ${currentName}.`);
      }
      const type = String(before.type ?? '');
      if (a.content !== undefined) checkContent(type, a.content as string);
      if (a.priority !== undefined && type !== 'MX') throw new InputError('priority is only for MX records');
      if (a.proxied === true && !PROXIABLE.has(type)) throw new InputError('only A, AAAA and CNAME records can be proxied');
      const body = {
        ...(a.name !== undefined ? { name: toRecordName(a.name, zoneName, 'name') } : {}),
        ...(a.content !== undefined ? { content: type === 'TXT' ? a.content : (a.content as string).trim() } : {}),
        ...(a.ttl !== undefined ? { ttl: a.ttl } : {}),
        ...(a.proxied !== undefined ? { proxied: a.proxied } : {}),
        ...(a.priority !== undefined ? { priority: a.priority } : {}),
        ...(a.comment !== undefined ? { comment: a.comment } : {}),
      };
      const { result } = await api.change('PATCH', `/zones/${zoneId}/dns_records/${a.record_id as string}`, body);
      return {
        updated: true,
        zone: zoneName,
        before: recordSummary(before),
        after: recordSummary((result ?? {}) as Record<string, unknown>),
      };
    },
  },
  {
    name: 'cloudflare_delete_dns_record',
    kind: 'write',
    destructive: true,
    description:
      'DESTRUCTIVE: delete a DNS record. name and type must match the record; they are checked first. The deleted record ' +
      'is returned so it can be recreated. Proposal: an administrator approves it before it runs.',
    params: {
      zone_id: ZONE_ID,
      zone_name: ZONE_NAME,
      record_id: RECORD_ID,
      name: { type: 'string', required: true, maxLength: 253, description: 'The record\'s name ("@", "www" or the full name).' },
      type: { type: 'string', required: true, enum: ['A', 'AAAA', 'CAA', 'CNAME', 'HTTPS', 'MX', 'NS', 'PTR', 'SRV', 'SVCB', 'TXT', 'URI'], description: 'The record\'s type.' },
    },
    validate: (a) => {
      toRecordName(a.name, a.zone_name as string, 'name');
    },
    run: async (a, api) => {
      const [zoneId, zoneName] = zoneArgs(a);
      await verifyZone(api, zoneId, zoneName);
      const before = await getRecord(api, zoneId, a.record_id as string);
      const name = toRecordName(a.name, zoneName, 'name');
      if (String(before.name ?? '').toLowerCase() !== name || String(before.type ?? '') !== a.type) {
        throw new MismatchError(`Record ${String(a.record_id)} is ${String(before.type)} ${String(before.name)}, not ${String(a.type)} ${name}.`);
      }
      await api.change('DELETE', `/zones/${zoneId}/dns_records/${a.record_id as string}`);
      return { deleted: true, zone: zoneName, record: recordSummary(before) };
    },
  },
  {
    name: 'cloudflare_purge_cache_urls',
    kind: 'write',
    description:
      'Purge up to 30 URLs from Cloudflare\'s cache in one zone (each URL must be on the zone or a subdomain of it). ' +
      'Proposal: an administrator approves it before it runs.',
    params: {
      zone_id: ZONE_ID,
      zone_name: ZONE_NAME,
      urls: {
        type: 'string_list',
        required: true,
        minItems: 1,
        maxItems: 30,
        maxLength: 2048,
        description: 'Full URLs, e.g. https://www.example.com.au/styles.css (1 to 30).',
      },
    },
    validate: (a) => {
      const zone = a.zone_name as string;
      (a.urls as string[]).forEach((u, i) => {
        let url: URL;
        try {
          url = new URL(u);
        } catch {
          throw new InputError(`urls[${i}] is not a URL`);
        }
        if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new InputError(`urls[${i}] must start with https:// or http://`);
        const host = url.hostname.toLowerCase();
        if (host !== zone && !host.endsWith(`.${zone}`)) throw new InputError(`urls[${i}] is not on ${zone}`);
      });
    },
    run: async (a, api) => {
      const [zoneId, zoneName] = zoneArgs(a);
      await verifyZone(api, zoneId, zoneName);
      await api.change('POST', `/zones/${zoneId}/purge_cache`, { files: a.urls });
      return { purged: true, zone: zoneName, urls: a.urls };
    },
  },
  {
    name: 'cloudflare_purge_cache_everything',
    kind: 'write',
    destructive: true,
    description:
      'DESTRUCTIVE: purge EVERYTHING from Cloudflare\'s cache for a zone. Every visitor\'s next requests go to the origin, ' +
      'which can overload it. Prefer cloudflare_purge_cache_urls. Proposal: an administrator approves it before it runs.',
    params: { zone_id: ZONE_ID, zone_name: ZONE_NAME },
    run: async (a, api) => {
      const [zoneId, zoneName] = zoneArgs(a);
      await verifyZone(api, zoneId, zoneName);
      await api.change('POST', `/zones/${zoneId}/purge_cache`, { purge_everything: true });
      return { purged: 'everything', zone: zoneName };
    },
  },
  {
    name: 'cloudflare_set_ssl_mode',
    kind: 'write',
    description:
      'Set a zone\'s SSL/TLS encryption mode: off, flexible (HTTPS to visitors, HTTP to the origin), full (HTTPS to the ' +
      'origin, any certificate) or strict (HTTPS to the origin with a valid certificate). Proposal: an administrator approves it before it runs.',
    params: {
      zone_id: ZONE_ID,
      zone_name: ZONE_NAME,
      mode: { type: 'string', required: true, enum: ['off', 'flexible', 'full', 'strict'], description: 'The new mode.' },
    },
    run: (a, api) => setSetting(api, a, 'ssl', a.mode as string),
  },
  {
    name: 'cloudflare_set_always_use_https',
    kind: 'write',
    description:
      'Turn Always Use HTTPS on or off for a zone (redirects every http:// request to https://). Proposal: an administrator approves it before it runs.',
    params: {
      zone_id: ZONE_ID,
      zone_name: ZONE_NAME,
      enabled: { type: 'boolean', required: true, description: 'true = on, false = off.' },
    },
    run: (a, api) => setSetting(api, a, 'always_use_https', a.enabled === true ? 'on' : 'off'),
  },
  {
    name: 'cloudflare_set_development_mode',
    kind: 'write',
    description:
      'Turn development mode on or off for a zone (bypasses Cloudflare\'s cache; turns itself off after 3 hours). ' +
      'Proposal: an administrator approves it before it runs.',
    params: {
      zone_id: ZONE_ID,
      zone_name: ZONE_NAME,
      enabled: { type: 'boolean', required: true, description: 'true = on, false = off.' },
    },
    run: (a, api) => setSetting(api, a, 'development_mode', a.enabled === true ? 'on' : 'off'),
  },
];
