import { CloudflareApiError } from '../types.js';
import type { Api, ParamSpec, ToolSpec } from './spec.js';
import { ID32, InputError, MismatchError, asList, isIpv4, isIpv6, pick, toRecordName } from './shared.js';
import { parseBindZone } from './bind.js';
import { recordSummary } from './read.js';
import { ZONE, ZONE_ID, ZONE_NAME, resolveZone, verifyZone } from './zone.js';

// Write tools. On the MCP host each call is a proposal that an administrator
// approves before it runs. Every write on an existing zone takes zone_id AND
// zone_name: before changing anything the server reads the zone and stops if
// the ID is not that zone (and, for record changes, reads the record and stops
// if it is not the one named). Then it sends exactly one change, never retried.
// cloudflare_create_zone is the exception: the zone does not exist yet, so it
// takes the new zone's name (and the account) instead.

/** Cloudflare's error code for "a zone with this name already exists". */
const ZONE_EXISTS = 1061;

/** Largest zone file cloudflare_import_dns_records accepts, in characters (about 256 KB). */
const MAX_ZONE_FILE = 262_144;

/** Accounts read when account_id is left out (the token must see exactly one). */
const ACCOUNTS_PAGE = 50;

/** The account a new zone goes in: account_id as given, or the token's only account. */
async function accountForNewZone(api: Api, accountId: string | undefined): Promise<{ id: string; name?: string }> {
  if (accountId) return { id: accountId };
  const { result, result_info } = await api.get('/accounts', { page: 1, per_page: ACCOUNTS_PAGE });
  const accounts = asList(result).filter((x) => typeof x.id === 'string');
  const total = Math.max(Number(result_info?.total_count ?? 0) || 0, accounts.length);
  if (total === 1) return { id: accounts[0].id as string, name: accounts[0].name as string | undefined };
  if (accounts.length === 0) throw new InputError('The token cannot see any Cloudflare account, so there is nowhere to create the zone.');
  const list = accounts.map((x) => `${String(x.name ?? '(no name)')} (${String(x.id)})`).join('; ');
  const more = total > accounts.length ? ` ... and ${total - accounts.length} more (cloudflare_list_accounts with name finds one)` : '';
  throw new InputError(`account_id is required: the token can see ${total} accounts. Give the client's account ID: ${list}${more}.`);
}

/** For a "zone already exists" error: the existing zone, if the token can see it. */
async function existingZoneNote(api: Api, name: string): Promise<string> {
  try {
    const { result } = await api.get('/zones', { name, per_page: 5 });
    const z = asList(result).find((x) => String(x.name).toLowerCase() === name);
    if (z) {
      const account = z.account as Record<string, unknown> | undefined;
      return (
        `It is zone ${String(z.id)} (status ${String(z.status ?? 'unknown')}` +
        `${account?.name ? `, account ${String(account.name)}` : ''}); see cloudflare_get_zone.`
      );
    }
  } catch {
    // Fall through: the zone is not visible to this token.
  }
  return 'It is not in any account this token can see (another Cloudflare account has it).';
}

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
    name: 'cloudflare_create_zone',
    kind: 'write',
    description:
      'Add a domain to Cloudflare as a new zone (full setup: Cloudflare hosts its DNS). The zone starts "pending" with no DNS ' +
      'records (none are imported unless jump_start is true) and becomes active once the registrar uses the name servers ' +
      'Cloudflare assigns, which are returned. Recreate the domain\'s records before changing the name servers. ' +
      'Proposal: an administrator approves it before it runs.',
    params: {
      zone_name: {
        type: 'domain',
        required: true,
        description: 'The domain to add, e.g. example.com.au (the registered domain, not a subdomain; IDNs in xn-- form).',
      },
      account_id: {
        type: 'id',
        description:
          'The Cloudflare account to create it in (from cloudflare_list_accounts). Required unless the token can see only one account.',
      },
      jump_start: {
        type: 'boolean',
        description:
          'Ask Cloudflare to scan the domain\'s current DNS and import the records it finds (default false: none are imported). ' +
          'A scan can miss records, and Cloudflare\'s current API reference no longer lists this option, so check the records ' +
          'with cloudflare_list_dns_records either way.',
      },
    },
    run: async (a, api) => {
      const name = a.zone_name as string;
      const account = await accountForNewZone(api, a.account_id as string | undefined);
      const body = { name, account: { id: account.id }, type: 'full', ...(a.jump_start === true ? { jump_start: true } : {}) };
      let result: unknown;
      try {
        ({ result } = await api.change('POST', '/zones', body));
      } catch (err) {
        if (err instanceof CloudflareApiError && err.codes.includes(ZONE_EXISTS)) {
          throw new CloudflareApiError(
            `A Cloudflare zone named ${name} already exists, so nothing was created. ${await existingZoneNote(api, name)}`,
            err.httpStatus,
            err.codes
          );
        }
        throw err;
      }
      const z = (result ?? {}) as Record<string, unknown>;
      const nameServers = Array.isArray(z.name_servers) ? (z.name_servers as unknown[]).map(String) : [];
      const zoneAccount = z.account as Record<string, unknown> | undefined;
      return {
        created: true,
        zone: String(z.name ?? name),
        zone_id: z.id,
        status: z.status,
        type: z.type,
        account: pick(zoneAccount ?? account, ['id', 'name']),
        name_servers: nameServers,
        original_name_servers: Array.isArray(z.original_name_servers) ? z.original_name_servers : [],
        ...pick(z, ['original_registrar', 'original_dnshost', 'created_on']),
        jump_start: a.jump_start === true,
        next_step:
          'The zone stays pending until the domain uses Cloudflare\'s name servers. First recreate the domain\'s DNS records ' +
          'in this zone (cloudflare_create_dns_record), then set these name servers at the registrar: ' +
          `${nameServers.join(', ') || '(see cloudflare_get_zone)'} (for a domain registered through Synergy Wholesale: ` +
          'synergy_update_nameservers). Then check cloudflare_get_zone until status is active.',
      };
    },
  },
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
    name: 'cloudflare_import_dns_records',
    kind: 'write',
    description:
      'Import DNS records into a zone from a BIND zone file (as exported by another DNS provider), in one change. ' +
      'The text is checked first: anything that is not a BIND zone file is refused (convert it to BIND format first), ' +
      'every record must be in the zone, and SOA and the apex NS records are left out (Cloudflare manages them). It only ' +
      'adds records, never deletes or changes existing ones, but importing the same records twice can create duplicates: ' +
      'list the zone\'s records first (cloudflare_list_dns_records) and leave out any that already exist. ' +
      'Proposal: an administrator approves it before it runs.',
    params: {
      zone: ZONE,
      zone_file: {
        type: 'string',
        required: true,
        keepWhitespace: true,
        maxLength: MAX_ZONE_FILE,
        description:
          'The zone file text in BIND format (up to 256 KB): one record per line, e.g. "www 3600 IN A 192.0.2.10". ' +
          'Names are relative to the zone unless they end with a dot; $ORIGIN and $TTL are allowed.',
      },
      proxied: {
        type: 'boolean',
        description: 'Proxy the imported A, AAAA and CNAME records through Cloudflare (orange cloud). Default false (DNS only).',
      },
    },
    validate: (a) => {
      // A zone given by name: check the text now, before any request.
      if (!ID32.test(a.zone as string)) parseBindZone(a.zone_file as string, a.zone as string);
    },
    run: async (a, api) => {
      const z = await resolveZone(api, a.zone as string);
      const zoneName = z.name.toLowerCase();
      const parsed = parseBindZone(a.zone_file as string, zoneName);
      const proxied = a.proxied === true;
      const form = new FormData();
      form.append('file', new Blob([parsed.text], { type: 'text/plain' }), 'zone.txt');
      form.append('proxied', proxied ? 'true' : 'false');
      const { result, messages } = await api.change('POST', `/zones/${z.id}/dns_records/import`, form);
      const r = (result ?? {}) as Record<string, unknown>;
      const sentCount = parsed.records.length;
      const added = typeof r.recs_added === 'number' ? r.recs_added : undefined;
      const notes = asList(messages).map((m) => pick(m, ['code', 'message']));
      return {
        imported: true,
        zone: zoneName,
        zone_id: z.id,
        proxied,
        records_sent: sentCount,
        records_by_type: parsed.counts,
        recs_added: added,
        total_records_parsed: r.total_records_parsed,
        ...(added !== undefined && added < sentCount
          ? { not_added: `${sentCount - added} of the records sent were not added (already in the zone, or rejected; see cloudflare_messages).` }
          : {}),
        skipped: parsed.skipped,
        ...(notes.length ? { cloudflare_messages: notes } : {}),
      };
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
