import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALL_SPECS,
  ALL_TOOLS,
  DESTRUCTIVE_TOOL_NAMES,
  READ_TOOL_NAMES,
  WRITE_TOOL_NAMES,
  dispatchToolCall,
} from '../tools/index.js';
import { API_BASE, runWithToken } from '../client.js';
import { redactSecrets, toRecordName } from '../tools/shared.js';
import { ACCOUNT_ID, RECORD_ID, ZONE, ZONE_ID, fail, jsonOf, ok, textOf } from './test-helpers.js';

const TOKEN = 'SECRET-TOKEN-abcdef0123456789';
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CLOUDFLARE_API_TOKEN;
});

function call(name: string, args: Record<string, unknown> = {}) {
  return runWithToken(TOKEN, () => dispatchToolCall(name, args));
}

interface Sent {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function sent(i: number): Sent {
  const [url, init] = fetchMock.mock.calls.at(i) as [string, RequestInit];
  return {
    url: new URL(url),
    method: String(init.method),
    headers: init.headers as Record<string, string>,
    body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
  };
}

const methods = () => fetchMock.mock.calls.map((_, i) => `${sent(i).method} ${sent(i).url.pathname}`);

const RECORD = {
  id: RECORD_ID,
  type: 'A',
  name: 'www.example.com.au',
  content: '192.0.2.10',
  proxied: true,
  proxiable: true,
  ttl: 1,
  comment: null,
  tags: [],
  meta: { auto_added: false },
  zone_id: ZONE_ID,
  modified_on: '2026-11-01T00:00:00Z',
};

const W = { zone_id: ZONE_ID, zone_name: 'example.com.au' };

describe('tool table', () => {
  it('has one named tool per action and no generic API tool', () => {
    expect(READ_TOOL_NAMES).toEqual([
      'cloudflare_list_accounts',
      'cloudflare_list_zones',
      'cloudflare_get_zone',
      'cloudflare_list_dns_records',
      'cloudflare_get_dns_record',
      'cloudflare_get_zone_settings',
      'cloudflare_get_ssl_status',
      'cloudflare_list_page_rules',
      'cloudflare_list_redirect_rules',
      'cloudflare_list_access_apps',
      'cloudflare_get_zone_analytics',
    ]);
    expect(WRITE_TOOL_NAMES).toEqual([
      'cloudflare_create_dns_record',
      'cloudflare_update_dns_record',
      'cloudflare_delete_dns_record',
      'cloudflare_purge_cache_urls',
      'cloudflare_purge_cache_everything',
      'cloudflare_set_ssl_mode',
      'cloudflare_set_always_use_https',
      'cloudflare_set_development_mode',
    ]);
    expect(DESTRUCTIVE_TOOL_NAMES).toEqual(['cloudflare_delete_dns_record', 'cloudflare_purge_cache_everything']);
    for (const t of ALL_TOOLS) {
      const props = Object.keys((t.inputSchema as { properties: object }).properties);
      expect(props.some((p) => /path|method|url$|endpoint|body/.test(p)), t.name).toBe(false);
      expect((t.inputSchema as unknown as { additionalProperties: boolean }).additionalProperties).toBe(false);
    }
  });

  it('annotations match the kind', () => {
    for (const s of ALL_SPECS) {
      const t = ALL_TOOLS.find((x) => x.name === s.name)!;
      expect(t.annotations?.readOnlyHint).toBe(s.kind === 'read');
      expect(t.annotations?.destructiveHint).toBe(DESTRUCTIVE_TOOL_NAMES.includes(s.name));
      if (s.kind === 'write') {
        expect(Object.keys(s.params)).toEqual(expect.arrayContaining(['zone_id', 'zone_name']));
        expect(t.description).toMatch(/Proposal/);
      }
    }
  });

  it('refuses unknown tools and parameters', async () => {
    expect((await call('cloudflare_api_request', { path: '/zones' })).isError).toBe(true);
    const res = await call('cloudflare_list_zones', { path: '/user' });
    expect(res.structuredContent).toMatchObject({ error: 'invalid_input' });
    expect(textOf(res)).toMatch(/Unknown parameter: path/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('only accepts 32-hex IDs, so no path can be smuggled in', async () => {
    const res = await call('cloudflare_get_dns_record', { zone: ZONE_ID, record_id: '../../user/tokens' });
    expect(textOf(res)).toMatch(/record_id must be a Cloudflare ID/);
    const res2 = await call('cloudflare_list_access_apps', { account_id: `${ACCOUNT_ID}/../x` });
    expect(res2.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('token handling', () => {
  it('says when no token is configured', async () => {
    const res = await dispatchToolCall('cloudflare_list_accounts', {});
    expect(res.structuredContent).toMatchObject({ error: 'config' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads the token from CLOUDFLARE_API_TOKEN and sends it only as a Bearer header to the API', async () => {
    process.env.CLOUDFLARE_API_TOKEN = ' env-token-0123456789 ';
    fetchMock.mockResolvedValueOnce(ok([]));
    await dispatchToolCall('cloudflare_list_accounts', {});
    const s = sent(0);
    expect(s.url.origin + s.url.pathname).toBe(`${API_BASE}/accounts`);
    expect(s.headers.Authorization).toBe('Bearer env-token-0123456789');
    expect(s.url.search).not.toContain('token');
  });

  it('never echoes the token in errors', async () => {
    fetchMock.mockResolvedValueOnce(fail(400, [{ code: 1000, message: `bad thing ${TOKEN}` }]));
    const res = await call('cloudflare_list_zones', {});
    expect(textOf(res)).not.toContain(TOKEN);
    expect(textOf(res)).toContain('[REDACTED]');
    fetchMock.mockRejectedValueOnce(new TypeError(`fetch failed for ${TOKEN}`));
    const res2 = await call('cloudflare_list_zones', {});
    expect(textOf(res2)).not.toContain(TOKEN);
  });

  it('reports a refused token as an auth error with a hint', async () => {
    fetchMock.mockResolvedValueOnce(fail(403, [{ code: 9109, message: 'Unauthorized to access requested resource' }]));
    const res = await call('cloudflare_list_access_apps', { account_id: ACCOUNT_ID });
    expect(res.structuredContent).toMatchObject({ error: 'auth' });
    expect(textOf(res)).toMatch(/HTTP 403.*9109.*permission/s);
  });
});

describe('read tools', () => {
  it('cloudflare_list_accounts keeps id, name and type', async () => {
    fetchMock.mockResolvedValueOnce(
      ok([{ id: ACCOUNT_ID, name: 'Example Client', type: 'standard', settings: { x: 1 }, managed_by: { parent_org_name: 'P' } }], {
        page: 1,
        per_page: 50,
        count: 1,
        total_count: 1,
        total_pages: 1,
      })
    );
    const out = jsonOf(await call('cloudflare_list_accounts', { name: 'Example' }));
    expect(out.accounts).toEqual([{ id: ACCOUNT_ID, name: 'Example Client', type: 'standard' }]);
    expect(out.total_count).toBe(1);
    expect(sent(0).url.searchParams.get('name')).toBe('Example');
    expect(sent(0).url.searchParams.get('per_page')).toBe('50');
  });

  it('cloudflare_list_zones filters by text, account and status', async () => {
    fetchMock.mockResolvedValueOnce(ok([ZONE]));
    const out = jsonOf(await call('cloudflare_list_zones', { search: 'Example', account_id: ACCOUNT_ID, status: 'active' }));
    const q = sent(0).url.searchParams;
    expect(q.get('name')).toBe('contains:example');
    expect(q.get('account.id')).toBe(ACCOUNT_ID);
    expect(q.get('status')).toBe('active');
    const z = (out.zones as Record<string, unknown>[])[0];
    expect(z).toMatchObject({ id: ZONE_ID, name: 'example.com.au', plan: 'Free Website', account: { id: ACCOUNT_ID, name: 'Example Client' } });
    expect(JSON.stringify(out)).not.toContain('someone@example.com');
    expect((await call('cloudflare_list_zones', { search: 'a&b' })).isError).toBe(true);
    expect((await call('cloudflare_list_zones', { name: 'example.com.au', search: 'x' })).isError).toBe(true);
  });

  it('cloudflare_get_zone finds a zone by name, or says it is not on Cloudflare', async () => {
    fetchMock.mockResolvedValueOnce(ok([ZONE]));
    const out = jsonOf(await call('cloudflare_get_zone', { zone: 'Example.com.au.' }));
    expect(sent(0).url.searchParams.get('name')).toBe('example.com.au');
    expect(out).toMatchObject({ id: ZONE_ID, page_rule_quota: 3, permissions: ['#zone:read', '#dns_records:edit'] });
    fetchMock.mockResolvedValueOnce(ok([]));
    const res = await call('cloudflare_get_zone', { zone: 'other.com.au' });
    expect(res.structuredContent).toMatchObject({ error: 'not_found' });
    expect(textOf(res)).toMatch(/No Cloudflare zone named other.com.au/);
  });

  it('cloudflare_get_zone by ID makes one request', async () => {
    fetchMock.mockResolvedValueOnce(ok(ZONE));
    jsonOf(await call('cloudflare_get_zone', { zone: ZONE_ID.toUpperCase() }));
    expect(methods()).toEqual([`GET /client/v4/zones/${ZONE_ID}`]);
  });

  it('cloudflare_list_dns_records expands "@" and relative names to the full name', async () => {
    fetchMock.mockResolvedValueOnce(ok([ZONE])).mockResolvedValueOnce(ok([RECORD], { page: 1, count: 1 }));
    const out = jsonOf(await call('cloudflare_list_dns_records', { zone: 'example.com.au', name: 'www', type: 'A' }));
    const q = sent(1).url.searchParams;
    expect(sent(1).url.pathname).toBe(`/client/v4/zones/${ZONE_ID}/dns_records`);
    expect(q.get('name')).toBe('www.example.com.au');
    expect(q.get('type')).toBe('A');
    expect(out.records).toEqual([
      {
        id: RECORD_ID,
        type: 'A',
        name: 'www.example.com.au',
        content: '192.0.2.10',
        proxied: true,
        proxiable: true,
        ttl: 1,
        tags: [],
        modified_on: '2026-11-01T00:00:00Z',
      },
    ]);

    fetchMock.mockResolvedValueOnce(ok(ZONE)).mockResolvedValueOnce(ok([]));
    await call('cloudflare_list_dns_records', { zone: ZONE_ID, name: '@' });
    expect(sent(3).url.searchParams.get('name')).toBe('example.com.au');
  });

  it('cloudflare_list_dns_records with a zone ID and no name filter makes one request', async () => {
    fetchMock.mockResolvedValueOnce(ok([]));
    await call('cloudflare_list_dns_records', { zone: ZONE_ID, search: '_DMARC', content: '192.0.2', proxied: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const q = sent(0).url.searchParams;
    expect(q.get('name.contains')).toBe('_dmarc');
    expect(q.get('content.contains')).toBe('192.0.2');
    expect(q.get('proxied')).toBe('false');
    expect(q.get('per_page')).toBe('100');
  });

  it('cloudflare_get_zone_settings shows the main settings, all with full', async () => {
    const settings = [
      { id: 'ssl', value: 'strict', editable: true },
      { id: 'always_use_https', value: 'on', editable: true },
      { id: 'polish', value: 'off', editable: false },
      { id: 'development_mode', value: 'off', editable: true, time_remaining: 0 },
    ];
    fetchMock.mockResolvedValueOnce(ok(settings));
    const out = jsonOf(await call('cloudflare_get_zone_settings', { zone: ZONE_ID }));
    expect(out.settings).toEqual({ ssl: 'strict', always_use_https: 'on', development_mode: 'off' });
    fetchMock.mockResolvedValueOnce(ok(settings));
    const all = jsonOf(await call('cloudflare_get_zone_settings', { zone: ZONE_ID, full: true }));
    expect(all.settings).toMatchObject({ polish: { value: 'off', editable: false } });
  });

  it('cloudflare_get_ssl_status combines the mode and the certificate packs', async () => {
    fetchMock
      .mockResolvedValueOnce(ok([{ id: 'ssl', value: 'full' }, { id: 'min_tls_version', value: '1.2' }, { id: 'brotli', value: 'on' }]))
      .mockResolvedValueOnce(
        ok([
          {
            id: 'p1',
            type: 'universal',
            hosts: ['example.com.au', '*.example.com.au'],
            status: 'active',
            certificate_authority: 'lets_encrypt',
            validation_method: 'txt',
            certificates: [{ id: 'c1', issuer: 'LetsEncrypt', status: 'active', expires_on: '2027-01-10T00:00:00Z', hosts: ['example.com.au'] }],
          },
        ])
      );
    const out = jsonOf(await call('cloudflare_get_ssl_status', { zone: ZONE_ID }));
    expect(out.settings).toEqual({ ssl: 'full', min_tls_version: '1.2' });
    expect(sent(1).url.searchParams.get('status')).toBe('all');
    expect((out.certificate_packs as Record<string, unknown>[])[0]).toMatchObject({
      status: 'active',
      certificates: [{ issuer: 'LetsEncrypt', expires_on: '2027-01-10T00:00:00Z' }],
    });
  });

  it('cloudflare_list_page_rules flattens targets and actions', async () => {
    fetchMock.mockResolvedValueOnce(
      ok([
        {
          id: 'r1',
          status: 'active',
          priority: 1,
          targets: [{ target: 'url', constraint: { operator: 'matches', value: 'http://example.com.au/*' } }],
          actions: [{ id: 'forwarding_url', value: { url: 'https://www.example.com.au/$1', status_code: 301 } }],
        },
      ])
    );
    const out = jsonOf(await call('cloudflare_list_page_rules', { zone: ZONE_ID }));
    expect(out.rules).toEqual([
      {
        id: 'r1',
        status: 'active',
        priority: 1,
        targets: ['matches http://example.com.au/*'],
        actions: [{ id: 'forwarding_url', value: { url: 'https://www.example.com.au/$1', status_code: 301 } }],
      },
    ]);
  });

  it('cloudflare_list_redirect_rules reads the entrypoint, and an empty zone is not an error', async () => {
    fetchMock.mockResolvedValueOnce(
      ok({
        rules: [
          {
            id: 'x',
            description: 'apex to www',
            enabled: true,
            action: 'redirect',
            expression: '(http.host eq "example.com.au")',
            action_parameters: { from_value: { target_url: { value: 'https://www.example.com.au' }, status_code: 301, preserve_query_string: true } },
          },
        ],
      })
    );
    const out = jsonOf(await call('cloudflare_list_redirect_rules', { zone: ZONE_ID }));
    expect(sent(0).url.pathname).toBe(`/client/v4/zones/${ZONE_ID}/rulesets/phases/http_request_dynamic_redirect/entrypoint`);
    expect(out.rules).toEqual([
      {
        id: 'x',
        description: 'apex to www',
        enabled: true,
        expression: '(http.host eq "example.com.au")',
        action: 'redirect',
        target: 'https://www.example.com.au',
        status_code: 301,
        preserve_query_string: true,
      },
    ]);
    fetchMock.mockResolvedValueOnce(fail(404, [{ code: 10003, message: 'could not find entrypoint ruleset' }]));
    const none = jsonOf(await call('cloudflare_list_redirect_rules', { zone: ZONE_ID }));
    expect(none).toMatchObject({ count: 0, rules: [] });
  });

  it('cloudflare_list_access_apps never returns secrets or policy members', async () => {
    fetchMock.mockResolvedValueOnce(
      ok([
        {
          id: 'app1',
          name: 'Portal',
          type: 'saas',
          domain: 'portal.example.com.au',
          aud: 'aud-tag',
          saas_app: { auth_type: 'oidc', client_id: 'cid', client_secret: 'TOP-SECRET', public_key: 'pk' },
          policies: [{ id: 'p', name: 'Staff', decision: 'allow', precedence: 1, include: [{ email: { email: 'a@b.c' } }] }],
          session_duration: '24h',
        },
      ])
    );
    const out = jsonOf(await call('cloudflare_list_access_apps', { account_id: ACCOUNT_ID, search: 'portal' }));
    const text = JSON.stringify(out);
    expect(text).not.toContain('TOP-SECRET');
    expect(text).not.toContain('a@b.c');
    expect(text).not.toContain('cid');
    expect((out.apps as Record<string, unknown>[])[0]).toEqual({
      id: 'app1',
      name: 'Portal',
      type: 'saas',
      domain: 'portal.example.com.au',
      session_duration: '24h',
      policies: [{ id: 'p', name: 'Staff', decision: 'allow', precedence: 1 }],
      saas_app: { auth_type: 'oidc' },
    });
    expect(sent(0).url.pathname).toBe(`/client/v4/accounts/${ACCOUNT_ID}/access/apps`);
  });

  it('cloudflare_get_zone_analytics sends one GraphQL query and totals the days', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            viewer: {
              zones: [
                {
                  httpRequests1dGroups: [
                    { dimensions: { date: '2026-11-18' }, sum: { requests: 10, cachedRequests: 4, bytes: 100, cachedBytes: 40, threats: 1, pageViews: 5 }, uniq: { uniques: 3 } },
                    { dimensions: { date: '2026-11-19' }, sum: { requests: 20, cachedRequests: 6, bytes: 200, cachedBytes: 60, threats: 0, pageViews: 7 }, uniq: { uniques: 4 } },
                  ],
                },
              ],
            },
          },
          errors: null,
        }),
        { status: 200 }
      )
    );
    const out = jsonOf(await call('cloudflare_get_zone_analytics', { zone: ZONE_ID, days: 2 }));
    const s = sent(0);
    expect(s.method).toBe('POST');
    expect(s.url.pathname).toBe('/client/v4/graphql');
    expect((s.body as { variables: Record<string, unknown> }).variables.zoneTag).toBe(ZONE_ID);
    expect(out.total).toEqual({ requests: 30, cachedRequests: 10, bytes: 300, cachedBytes: 100, threats: 1, pageViews: 12 });
    expect((out.per_day as unknown[]).length).toBe(2);
  });

  it('a GraphQL error is an error', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: null, errors: [{ message: 'not authorized for that account' }] }), { status: 200 }));
    const res = await call('cloudflare_get_zone_analytics', { zone: ZONE_ID });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not authorized/);
  });
});

describe('write tools', () => {
  it('create checks the zone first, then sends one POST', async () => {
    fetchMock.mockResolvedValueOnce(ok(ZONE)).mockResolvedValueOnce(ok({ ...RECORD, name: 'app.example.com.au', proxied: false }));
    const out = jsonOf(await call('cloudflare_create_dns_record', { ...W, type: 'A', name: 'app', content: ' 192.0.2.10 ', ttl: 300 }));
    expect(methods()).toEqual([`GET /client/v4/zones/${ZONE_ID}`, `POST /client/v4/zones/${ZONE_ID}/dns_records`]);
    expect(sent(1).body).toEqual({ type: 'A', name: 'app.example.com.au', content: '192.0.2.10', ttl: 300, proxied: false });
    expect(out).toMatchObject({ created: true, zone: 'example.com.au' });
  });

  it('create sends MX priority and keeps TXT content as given', async () => {
    fetchMock.mockResolvedValueOnce(ok(ZONE)).mockResolvedValueOnce(ok(RECORD));
    await call('cloudflare_create_dns_record', { ...W, type: 'MX', name: '@', content: 'mail.example.net', priority: 10 });
    expect(sent(1).body).toEqual({ type: 'MX', name: 'example.com.au', content: 'mail.example.net', ttl: 1, priority: 10 });
    fetchMock.mockResolvedValueOnce(ok(ZONE)).mockResolvedValueOnce(ok(RECORD));
    await call('cloudflare_create_dns_record', { ...W, type: 'TXT', name: '_dmarc', content: 'v=DMARC1; p=none', comment: 'ticket 123' });
    expect(sent(3).body).toEqual({ type: 'TXT', name: '_dmarc.example.com.au', content: 'v=DMARC1; p=none', ttl: 1, comment: 'ticket 123' });
  });

  it('create refuses bad input before calling Cloudflare', async () => {
    const bad: Record<string, unknown>[] = [
      { type: 'A', name: 'x', content: '999.1.1.1' },
      { type: 'AAAA', name: 'x', content: '192.0.2.1' },
      { type: 'MX', name: '@', content: 'mail.example.net' },
      { type: 'TXT', name: 'x', content: 'hi', proxied: true },
      { type: 'A', name: 'x', content: '192.0.2.1', proxied: true, ttl: 300 },
      { type: 'A', name: 'x', content: '192.0.2.1', ttl: 30 },
      { type: 'CNAME', name: 'x', content: 'not a host' },
      { type: 'A', name: 'bad label!', content: '192.0.2.1' },
      { type: 'SRV', name: 'x', content: 'y' },
    ];
    for (const b of bad) {
      const res = await call('cloudflare_create_dns_record', { ...W, ...b });
      expect(res.structuredContent, JSON.stringify(b)).toMatchObject({ error: 'invalid_input' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a zone ID that is not the named zone stops the write', async () => {
    fetchMock.mockResolvedValueOnce(ok({ ...ZONE, name: 'other-client.com.au' }));
    const res = await call('cloudflare_create_dns_record', { ...W, type: 'A', name: 'x', content: '192.0.2.1' });
    expect(textOf(res)).toMatch(/is other-client.com.au, not example.com.au\. Nothing was changed/);
    expect(methods()).toEqual([`GET /client/v4/zones/${ZONE_ID}`]);
  });

  it('update checks the record name, then PATCHes only the changed fields', async () => {
    fetchMock
      .mockResolvedValueOnce(ok(ZONE))
      .mockResolvedValueOnce(ok(RECORD))
      .mockResolvedValueOnce(ok({ ...RECORD, content: '192.0.2.20' }));
    const out = jsonOf(
      await call('cloudflare_update_dns_record', { ...W, record_id: RECORD_ID, current_name: 'www', content: '192.0.2.20' })
    );
    expect(methods()).toEqual([
      `GET /client/v4/zones/${ZONE_ID}`,
      `GET /client/v4/zones/${ZONE_ID}/dns_records/${RECORD_ID}`,
      `PATCH /client/v4/zones/${ZONE_ID}/dns_records/${RECORD_ID}`,
    ]);
    expect(sent(2).body).toEqual({ content: '192.0.2.20' });
    expect(out).toMatchObject({ before: { content: '192.0.2.10' }, after: { content: '192.0.2.20' } });
  });

  it('update with comment "" clears the comment, alone or with another change', async () => {
    fetchMock
      .mockResolvedValueOnce(ok(ZONE))
      .mockResolvedValueOnce(ok({ ...RECORD, comment: 'old note' }))
      .mockResolvedValueOnce(ok({ ...RECORD, comment: null }));
    jsonOf(await call('cloudflare_update_dns_record', { ...W, record_id: RECORD_ID, current_name: 'www', comment: '' }));
    expect(sent(2).body).toEqual({ comment: '' });

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(ok(ZONE))
      .mockResolvedValueOnce(ok({ ...RECORD, comment: 'old note' }))
      .mockResolvedValueOnce(ok({ ...RECORD, ttl: 300, comment: null }));
    jsonOf(await call('cloudflare_update_dns_record', { ...W, record_id: RECORD_ID, current_name: 'www', ttl: 300, comment: '  ' }));
    expect(sent(2).body).toEqual({ ttl: 300, comment: '' });
  });

  it('create treats an empty comment as no comment', async () => {
    fetchMock.mockResolvedValueOnce(ok(ZONE)).mockResolvedValueOnce(ok(RECORD));
    jsonOf(await call('cloudflare_create_dns_record', { ...W, type: 'A', name: 'www', content: '192.0.2.1', comment: '' }));
    expect(sent(1).body).not.toHaveProperty('comment');
  });

  it('update refuses a wrong current name, content for the record type, or no change', async () => {
    fetchMock.mockResolvedValueOnce(ok(ZONE)).mockResolvedValueOnce(ok(RECORD));
    const res = await call('cloudflare_update_dns_record', { ...W, record_id: RECORD_ID, current_name: 'mail', content: '192.0.2.20' });
    expect(textOf(res)).toMatch(/is www.example.com.au, not mail.example.com.au/);
    fetchMock.mockResolvedValueOnce(ok(ZONE)).mockResolvedValueOnce(ok(RECORD));
    const res2 = await call('cloudflare_update_dns_record', { ...W, record_id: RECORD_ID, current_name: 'www', content: 'host.example.net' });
    expect(textOf(res2)).toMatch(/IPv4/);
    const res3 = await call('cloudflare_update_dns_record', { ...W, record_id: RECORD_ID, current_name: 'www' });
    expect(textOf(res3)).toMatch(/at least one/);
    expect(methods().filter((m) => m.startsWith('PATCH'))).toEqual([]);
  });

  it('delete checks name and type, then DELETEs and returns the old record', async () => {
    fetchMock.mockResolvedValueOnce(ok(ZONE)).mockResolvedValueOnce(ok(RECORD)).mockResolvedValueOnce(ok({ id: RECORD_ID }));
    const out = jsonOf(await call('cloudflare_delete_dns_record', { ...W, record_id: RECORD_ID, name: 'www.example.com.au', type: 'A' }));
    expect(methods().at(-1)).toBe(`DELETE /client/v4/zones/${ZONE_ID}/dns_records/${RECORD_ID}`);
    expect(out).toMatchObject({ deleted: true, record: { content: '192.0.2.10' } });

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(ok(ZONE)).mockResolvedValueOnce(ok(RECORD));
    const res = await call('cloudflare_delete_dns_record', { ...W, record_id: RECORD_ID, name: 'www', type: 'CNAME' });
    expect(textOf(res)).toMatch(/is A www.example.com.au, not CNAME www.example.com.au/);
    expect(methods().some((m) => m.startsWith('DELETE'))).toBe(false);
  });

  it('purge by URL only accepts URLs on the zone', async () => {
    const res = await call('cloudflare_purge_cache_urls', { ...W, urls: ['https://example.com.au/a', 'https://evil.example.net/b'] });
    expect(textOf(res)).toMatch(/urls\[1\] is not on example.com.au/);
    expect((await call('cloudflare_purge_cache_urls', { ...W, urls: ['ftp://example.com.au/a'] })).isError).toBe(true);
    expect((await call('cloudflare_purge_cache_urls', { ...W, urls: Array.from({ length: 31 }, (_, i) => `https://example.com.au/${i}`) })).isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(ok(ZONE)).mockResolvedValueOnce(ok({ id: 'purge' }));
    jsonOf(await call('cloudflare_purge_cache_urls', { ...W, urls: ['https://www.example.com.au/a.css'] }));
    expect(sent(1).body).toEqual({ files: ['https://www.example.com.au/a.css'] });
  });

  it('purge everything sends purge_everything', async () => {
    fetchMock.mockResolvedValueOnce(ok(ZONE)).mockResolvedValueOnce(ok({ id: 'purge' }));
    expect(jsonOf(await call('cloudflare_purge_cache_everything', W))).toEqual({ purged: 'everything', zone: 'example.com.au' });
    expect(sent(1).body).toEqual({ purge_everything: true });
  });

  it('settings writes PATCH one setting each', async () => {
    const cases: [string, Record<string, unknown>, string, string][] = [
      ['cloudflare_set_ssl_mode', { mode: 'strict' }, 'ssl', 'strict'],
      ['cloudflare_set_always_use_https', { enabled: true }, 'always_use_https', 'on'],
      ['cloudflare_set_development_mode', { enabled: false }, 'development_mode', 'off'],
    ];
    for (const [tool, args, setting, value] of cases) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(ok(ZONE)).mockResolvedValueOnce(ok({ id: setting, value, modified_on: 'now' }));
      const out = jsonOf(await call(tool, { ...W, ...args }));
      expect(methods()[1]).toBe(`PATCH /client/v4/zones/${ZONE_ID}/settings/${setting}`);
      expect(sent(1).body).toEqual({ value });
      expect(out).toMatchObject({ setting, value });
    }
    expect((await call('cloudflare_set_ssl_mode', { ...W, mode: 'none' })).isError).toBe(true);
  });

  it('a failed write is reported with Cloudflare\'s error', async () => {
    fetchMock.mockResolvedValueOnce(ok(ZONE)).mockResolvedValueOnce(fail(400, [{ code: 81057, message: 'Record already exists.' }]));
    const res = await call('cloudflare_create_dns_record', { ...W, type: 'A', name: 'www', content: '192.0.2.1' });
    expect(textOf(res)).toMatch(/HTTP 400 - 81057: Record already exists/);
  });
});

describe('helpers', () => {
  it('toRecordName', () => {
    expect(toRecordName('@', 'example.com.au', 'n')).toBe('example.com.au');
    expect(toRecordName('WWW', 'example.com.au', 'n')).toBe('www.example.com.au');
    expect(toRecordName('www.example.com.au.', 'example.com.au', 'n')).toBe('www.example.com.au');
    expect(toRecordName('*.dev', 'example.com.au', 'n')).toBe('*.dev.example.com.au');
    expect(toRecordName('selector1._domainkey', 'example.com.au', 'n')).toBe('selector1._domainkey.example.com.au');
    expect(() => toRecordName('a.*', 'example.com.au', 'n')).toThrow();
  });

  it('redactSecrets hides secret-looking fields at any depth', () => {
    expect(
      redactSecrets({ a: { client_secret: 's', tunnel_token: 't', private_key: 'k', token_type: 'Bearer', enabled: true }, list: [{ password: 'p' }] })
    ).toEqual({ a: { client_secret: '[hidden]', tunnel_token: '[hidden]', private_key: '[hidden]', token_type: 'Bearer', enabled: true }, list: [{ password: '[hidden]' }] });
  });
});
