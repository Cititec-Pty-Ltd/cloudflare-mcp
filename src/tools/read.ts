import { CloudflareApiError } from '../types.js';
import type { ParamSpec, ToolSpec } from './spec.js';
import { InputError, asList, pick, toRecordName } from './shared.js';
import { ZONE, resolveZone, zoneIdOf, zoneSummary } from './zone.js';

// Read tools: GET requests (and one GraphQL analytics query) that change
// nothing. On the MCP host they go in read_tools. Results keep listed fields
// only, and every result also passes through redactSecrets.

const PAGE: ParamSpec = { type: 'int', min: 1, max: 10_000, description: 'Page number (default 1).' };

function perPage(max: number, def: number, min = 1): ParamSpec {
  return { type: 'int', min, max, description: `Results per page (default ${def}, at most ${max}).` };
}

function paging(info: Record<string, unknown> | undefined): Record<string, unknown> {
  return pick(info, ['page', 'per_page', 'count', 'total_count', 'total_pages']);
}

const ZONE_STATUSES = ['initializing', 'pending', 'active', 'moved'] as const;

export const RECORD_TYPES_READ = ['A', 'AAAA', 'CAA', 'CNAME', 'DS', 'HTTPS', 'MX', 'NS', 'PTR', 'SRV', 'SVCB', 'TXT', 'URI'] as const;

export function recordSummary(r: Record<string, unknown>): Record<string, unknown> {
  return pick(r, ['id', 'type', 'name', 'content', 'data', 'priority', 'proxied', 'proxiable', 'ttl', 'comment', 'tags', 'modified_on']);
}

/** Settings shown by cloudflare_get_zone_settings (the rest with full=true). */
const MAIN_SETTINGS = [
  'ssl', 'always_use_https', 'min_tls_version', 'tls_1_3', 'automatic_https_rewrites', 'security_header',
  'opportunistic_encryption', 'development_mode', 'security_level', 'browser_check', 'challenge_ttl', 'cache_level',
  'browser_cache_ttl', 'always_online', 'http3', 'ipv6', 'websockets', 'email_obfuscation', 'hotlink_protection',
  'rocket_loader', 'early_hints', 'pseudo_ipv4', 'ip_geolocation', '0rtt', 'http2', 'brotli',
];

const SSL_SETTINGS = ['ssl', 'always_use_https', 'min_tls_version', 'tls_1_3', 'automatic_https_rewrites', 'security_header'];

function settingsMap(result: unknown, only?: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of asList(result)) {
    const id = String(s.id ?? '');
    if (!id || (only && !only.includes(id))) continue;
    out[id] = s.editable === false ? { value: s.value, editable: false } : s.value;
  }
  return out;
}

function accessAppSummary(a: Record<string, unknown>): Record<string, unknown> {
  const policies = asList(a.policies).map((p) => pick(p, ['id', 'name', 'decision', 'precedence']));
  const destinations = asList(a.destinations).map((d) => pick(d, ['type', 'uri', 'hostname', 'cidr', 'port_range']));
  const saas = a.saas_app as Record<string, unknown> | undefined;
  return {
    ...pick(a, ['id', 'name', 'type', 'domain', 'self_hosted_domains', 'session_duration', 'app_launcher_visible']),
    ...pick(a, ['auto_redirect_to_identity', 'allowed_idps', 'created_at', 'updated_at']),
    ...(destinations.length ? { destinations } : {}),
    ...(policies.length ? { policies } : {}),
    // A SaaS app's OIDC client secret and SAML keys are never returned: only its type.
    ...(saas ? { saas_app: pick(saas, ['auth_type', 'name_id_format', 'consumer_service_url', 'sp_entity_id', 'redirect_uris']) } : {}),
  };
}

function certPackSummary(p: Record<string, unknown>): Record<string, unknown> {
  return {
    ...pick(p, ['id', 'type', 'status', 'hosts', 'certificate_authority', 'validation_method', 'validity_days', 'backup']),
    certificates: asList(p.certificates).map((c) => pick(c, ['hosts', 'issuer', 'status', 'expires_on'])),
  };
}

function isNoEntrypoint(err: unknown): boolean {
  return err instanceof CloudflareApiError && (err.httpStatus === 404 || err.codes.includes(10003));
}

const ANALYTICS_QUERY = `query ZoneSummary($zoneTag: string, $since: Date!, $until: Date!) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      httpRequests1dGroups(limit: 31, filter: { date_geq: $since, date_leq: $until }, orderBy: [date_ASC]) {
        dimensions { date }
        sum { requests cachedRequests bytes cachedBytes threats pageViews }
        uniq { uniques }
      }
    }
  }
}`;

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const READ_SPECS: ToolSpec[] = [
  {
    name: 'cloudflare_list_accounts',
    kind: 'read',
    description:
      'List the Cloudflare accounts the token can see (Cititec manages each client in its own account): ID, name, type. ' +
      'Use an account ID to filter cloudflare_list_zones or for cloudflare_list_access_apps.',
    params: {
      name: { type: 'string', maxLength: 200, description: 'Only accounts whose name contains this text.' },
      page: PAGE,
      per_page: perPage(50, 50),
    },
    run: async (a, api) => {
      const { result, result_info } = await api.get('/accounts', {
        name: a.name as string | undefined,
        page: (a.page as number) ?? 1,
        per_page: (a.per_page as number) ?? 50,
      });
      const accounts = asList(result).map((x) => pick(x, ['id', 'name', 'type', 'created_on']));
      return { ...paging(result_info), accounts };
    },
  },
  {
    name: 'cloudflare_list_zones',
    kind: 'read',
    description:
      'List zones (domains on Cloudflare): ID, name, status, name servers, account, plan. Filter by exact name, by text in the ' +
      'name, by account or by status. To find which client account a domain is in, use name.',
    params: {
      name: { type: 'domain', description: 'Exact zone name, e.g. example.com.au.' },
      search: { type: 'string', maxLength: 253, description: 'Only zones whose name contains this text.' },
      account_id: { type: 'id', description: 'Only zones in this account.' },
      account_name: { type: 'string', maxLength: 200, description: 'Only zones in the account with this exact name.' },
      status: { type: 'string', enum: ZONE_STATUSES, description: 'Only zones with this status.' },
      page: PAGE,
      per_page: perPage(50, 50),
    },
    validate: (a) => {
      if (a.name && a.search) throw new InputError('give name or search, not both');
      if (typeof a.search === 'string' && /[^a-z0-9.-]/i.test(a.search)) {
        throw new InputError('search may only contain letters, digits, dots and hyphens');
      }
    },
    run: async (a, api) => {
      const { result, result_info } = await api.get('/zones', {
        name: (a.name as string | undefined) ?? (a.search ? `contains:${String(a.search).toLowerCase()}` : undefined),
        'account.id': a.account_id as string | undefined,
        'account.name': a.account_name as string | undefined,
        status: a.status as string | undefined,
        page: (a.page as number) ?? 1,
        per_page: (a.per_page as number) ?? 50,
      });
      return { ...paging(result_info), zones: asList(result).map(zoneSummary) };
    },
  },
  {
    name: 'cloudflare_get_zone',
    kind: 'read',
    description:
      'One zone by name or ID: ID, status, name servers (and the ones before Cloudflare), account, plan, development mode, ' +
      'page rule quota, and the permissions the token has on it.',
    params: { zone: ZONE },
    run: async (a, api) => {
      const z = await resolveZone(api, a.zone as string);
      const full = z.zone ?? {};
      const meta = full.meta as Record<string, unknown> | undefined;
      return {
        ...zoneSummary(full),
        ...pick(full, ['original_registrar', 'original_dnshost', 'vanity_name_servers', 'created_on']),
        ...(meta ? { page_rule_quota: meta.page_rule_quota } : {}),
        ...pick(full, ['permissions']),
      };
    },
  },
  {
    name: 'cloudflare_list_dns_records',
    kind: 'read',
    description:
      'List DNS records in a zone, optionally by type and name. name is exact ("@" for the apex, "www" or the full name); ' +
      'search matches part of the name. Returns ID, type, name, content, priority, proxied, TTL (1 = automatic), comment.',
    params: {
      zone: ZONE,
      type: { type: 'string', enum: RECORD_TYPES_READ, description: 'Only records of this type.' },
      name: { type: 'string', maxLength: 253, description: 'Exact record name: "@", "www", "_dmarc" or the full name.' },
      search: { type: 'string', maxLength: 253, description: 'Only records whose name contains this text.' },
      content: { type: 'string', maxLength: 500, description: 'Only records whose content contains this text (an IP address, a host).' },
      proxied: { type: 'boolean', description: 'Only proxied (true) or DNS-only (false) records.' },
      page: PAGE,
      per_page: perPage(500, 100),
    },
    validate: (a) => {
      if (a.name && a.search) throw new InputError('give name or search, not both');
    },
    run: async (a, api) => {
      let zoneId: string;
      let name: string | undefined;
      if (a.name !== undefined) {
        const z = await resolveZone(api, a.zone as string);
        zoneId = z.id;
        name = toRecordName(a.name, z.name, 'name');
      } else {
        zoneId = await zoneIdOf(api, a.zone as string);
      }
      const { result, result_info } = await api.get(`/zones/${zoneId}/dns_records`, {
        type: a.type as string | undefined,
        name,
        'name.contains': a.search ? String(a.search).toLowerCase() : undefined,
        'content.contains': a.content as string | undefined,
        proxied: a.proxied as boolean | undefined,
        page: (a.page as number) ?? 1,
        per_page: (a.per_page as number) ?? 100,
        order: 'type',
      });
      return { zone_id: zoneId, ...paging(result_info), records: asList(result).map(recordSummary) };
    },
  },
  {
    name: 'cloudflare_get_dns_record',
    kind: 'read',
    description: 'One DNS record by its ID (from cloudflare_list_dns_records).',
    params: {
      zone: ZONE,
      record_id: { type: 'id', required: true, description: 'The DNS record ID.' },
    },
    run: async (a, api) => {
      const zoneId = await zoneIdOf(api, a.zone as string);
      const { result } = await api.get(`/zones/${zoneId}/dns_records/${a.record_id as string}`);
      return { zone_id: zoneId, record: recordSummary((result ?? {}) as Record<string, unknown>) };
    },
  },
  {
    name: 'cloudflare_get_zone_settings',
    kind: 'read',
    description:
      'A zone\'s main settings: SSL mode, Always Use HTTPS, minimum TLS, TLS 1.3, HSTS (security_header), automatic HTTPS ' +
      'rewrites, development mode, security level, cache level, browser cache TTL, HTTP/3, IPv6 and similar. full=true returns every setting.',
    params: {
      zone: ZONE,
      full: { type: 'boolean', description: 'Return every setting, not only the main ones.' },
    },
    run: async (a, api) => {
      const zoneId = await zoneIdOf(api, a.zone as string);
      const { result } = await api.get(`/zones/${zoneId}/settings`);
      return { zone_id: zoneId, settings: settingsMap(result, a.full === true ? undefined : MAIN_SETTINGS) };
    },
  },
  {
    name: 'cloudflare_get_ssl_status',
    kind: 'read',
    description:
      'A zone\'s SSL/TLS: encryption mode (off, flexible, full, strict), Always Use HTTPS, minimum TLS version, HSTS, and its ' +
      'certificate packs (universal, advanced or custom) with status, hosts, authority and expiry dates.',
    params: { zone: ZONE },
    run: async (a, api) => {
      const zoneId = await zoneIdOf(api, a.zone as string);
      const settings = await api.get(`/zones/${zoneId}/settings`);
      const packs = await api.get(`/zones/${zoneId}/ssl/certificate_packs`, { status: 'all', per_page: 50 });
      return {
        zone_id: zoneId,
        settings: settingsMap(settings.result, SSL_SETTINGS),
        certificate_packs: asList(packs.result).map(certPackSummary),
      };
    },
  },
  {
    name: 'cloudflare_list_page_rules',
    kind: 'read',
    description:
      'A zone\'s page rules (the older rules: forwarding URLs, cache and SSL overrides per URL pattern) with their targets, ' +
      'actions, priority and status. Newer redirects are in cloudflare_list_redirect_rules.',
    params: { zone: ZONE },
    run: async (a, api) => {
      const zoneId = await zoneIdOf(api, a.zone as string);
      const { result } = await api.get(`/zones/${zoneId}/pagerules`);
      const rules = asList(result).map((r) => ({
        ...pick(r, ['id', 'status', 'priority']),
        targets: asList(r.targets).map((t) => {
          const c = t.constraint as Record<string, unknown> | undefined;
          return c ? `${String(c.operator ?? '')} ${String(c.value ?? '')}`.trim() : t;
        }),
        actions: asList(r.actions).map((x) => pick(x, ['id', 'value'])),
        ...pick(r, ['modified_on']),
      }));
      return { zone_id: zoneId, count: rules.length, rules };
    },
  },
  {
    name: 'cloudflare_list_redirect_rules',
    kind: 'read',
    description:
      'A zone\'s redirect rules (Single Redirects, the http_request_dynamic_redirect phase): description, enabled, the match ' +
      'expression, target URL or expression, status code and whether the query string is kept.',
    params: { zone: ZONE },
    run: async (a, api) => {
      const zoneId = await zoneIdOf(api, a.zone as string);
      let result: unknown;
      try {
        ({ result } = await api.get(`/zones/${zoneId}/rulesets/phases/http_request_dynamic_redirect/entrypoint`));
      } catch (err) {
        if (isNoEntrypoint(err)) return { zone_id: zoneId, count: 0, rules: [], note: 'This zone has no redirect rules.' };
        throw err;
      }
      const rules = asList((result as Record<string, unknown> | undefined)?.rules).map((r) => {
        const params = r.action_parameters as Record<string, unknown> | undefined;
        const from = params?.from_value as Record<string, unknown> | undefined;
        const target = from?.target_url as Record<string, unknown> | undefined;
        return {
          ...pick(r, ['id', 'description', 'enabled', 'expression', 'action']),
          ...(from
            ? {
                target: target?.value ?? target?.expression,
                ...pick(from, ['status_code', 'preserve_query_string']),
              }
            : {}),
          ...pick(r, ['last_updated']),
        };
      });
      return { zone_id: zoneId, count: rules.length, rules };
    },
  },
  {
    name: 'cloudflare_list_access_apps',
    kind: 'read',
    description:
      'List Cloudflare Zero Trust Access applications in an account: name, type, domain(s), session duration, identity ' +
      'providers and the names of their policies. Read-only; client secrets, keys and policy members are never returned.',
    params: {
      account_id: { type: 'id', required: true, description: 'The account ID (from cloudflare_list_accounts).' },
      search: { type: 'string', maxLength: 200, description: 'Only applications whose name or domain contains this text.' },
      page: PAGE,
      // The Access API refuses per_page below 5 (checked 2026-11-19).
      per_page: perPage(100, 50, 5),
    },
    run: async (a, api) => {
      const { result, result_info } = await api.get(`/accounts/${a.account_id as string}/access/apps`, {
        search: a.search as string | undefined,
        page: (a.page as number) ?? 1,
        per_page: (a.per_page as number) ?? 50,
      });
      return { account_id: a.account_id, ...paging(result_info), apps: asList(result).map(accessAppSummary) };
    },
  },
  {
    name: 'cloudflare_get_zone_analytics',
    kind: 'read',
    description:
      'A zone\'s traffic for the last N days (default 7, at most 30) from the GraphQL Analytics API: requests, cached ' +
      'requests, bandwidth, threats, page views and unique visitors, per day and in total. Older days may be missing on Free plans.',
    params: {
      zone: ZONE,
      days: { type: 'int', min: 1, max: 30, description: 'Days to cover, ending today (UTC). Default 7.' },
    },
    run: async (a, api) => {
      const zoneId = await zoneIdOf(api, a.zone as string);
      const days = (a.days as number) ?? 7;
      const now = Date.now();
      const since = isoDate(now - (days - 1) * 86_400_000);
      const until = isoDate(now);
      const { data } = await api.graphql(ANALYTICS_QUERY, { zoneTag: zoneId, since, until });
      const zones = asList((data as { viewer?: { zones?: unknown } } | undefined)?.viewer?.zones);
      const groups = asList(zones[0]?.httpRequests1dGroups);
      const total = { requests: 0, cachedRequests: 0, bytes: 0, cachedBytes: 0, threats: 0, pageViews: 0 };
      const perDay = groups.map((g) => {
        const sum = (g.sum ?? {}) as Record<string, number>;
        for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += Number(sum[k] ?? 0);
        return {
          date: (g.dimensions as Record<string, unknown> | undefined)?.date,
          ...sum,
          uniques: (g.uniq as Record<string, unknown> | undefined)?.uniques,
        };
      });
      return { zone_id: zoneId, since, until, total, per_day: perDay };
    },
  },
];
