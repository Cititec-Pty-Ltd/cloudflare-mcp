# Cloudflare MCP server

An MCP server for the [Cloudflare API](https://developers.cloudflare.com/api/). Claude can use it to look up accounts, zones, DNS records, zone settings, SSL/TLS and certificates, page rules, redirect rules, Zero Trust Access applications and traffic analytics. Separately named write tools can add a domain as a new zone, create, change and delete DNS records, import records from a BIND zone file, purge the cache, set the SSL mode, and turn Always Use HTTPS and development mode on or off.

There is **one named tool per action** and no generic "call any API path" tool: every tool calls fixed Cloudflare paths with validated arguments (IDs must be 32 hex characters, names must be domain names), so a tool can only do what its name says.

It uses the same framework as Cititec's other MCP servers: TypeScript, `@modelcontextprotocol/sdk`, a stdio transport, vitest tests, tsup and a Docker image. It is built to run on the Cititec MCP host, which runs one container per connection and turns every write into a proposal that a person approves before it runs.

## Configuration

| Variable | |
|----------|---|
| `CLOUDFLARE_API_TOKEN` | An API token (never a Global API Key). See "API token permissions". |
| `LOG_LEVEL` | `debug`, `info` (default), `warn`, `error`. Logs go to stderr; tool arguments and the token are never logged. |

The token is sent only to `https://api.cloudflare.com/client/v4`, as a `Bearer` header, and is removed from any error text.

## Tools

Results keep the useful fields only, and every result is capped at 60,000 characters. Where a tool takes `zone`, it accepts the zone name (`example.com.au`) or its ID; by name it costs one extra request to look the ID up.

### Read tools

| Tool | Cloudflare API | Notes |
|------|----------------|-------|
| `cloudflare_list_accounts` | `GET /accounts` | ID, name, type. Filter by name |
| `cloudflare_list_zones` | `GET /zones` | Filter by exact name, text in the name (`contains:`), account ID or name, status |
| `cloudflare_get_zone` | `GET /zones/{id}` (or by name) | Status, name servers (and the ones before Cloudflare), account, plan, page rule quota, the token's permissions on it |
| `cloudflare_list_dns_records` | `GET /zones/{id}/dns_records` | Filter by type, exact name (`@`, `www` or the full name), text in the name, text in the content, proxied |
| `cloudflare_get_dns_record` | `GET /zones/{id}/dns_records/{id}` | |
| `cloudflare_get_zone_settings` | `GET /zones/{id}/settings` | The main settings (SSL, HTTPS, TLS, HSTS, cache, security level, HTTP/3, ...); `full` for all |
| `cloudflare_get_ssl_status` | `GET /zones/{id}/settings`, `GET /zones/{id}/ssl/certificate_packs?status=all` | SSL mode, Always Use HTTPS, minimum TLS, HSTS; certificate packs with authority, status and expiry |
| `cloudflare_list_page_rules` | `GET /zones/{id}/pagerules` | |
| `cloudflare_list_redirect_rules` | `GET /zones/{id}/rulesets/phases/http_request_dynamic_redirect/entrypoint` | Single Redirects. A zone without any returns an empty list |
| `cloudflare_list_access_apps` | `GET /accounts/{id}/access/apps` | Name, type, domains, session duration, identity providers, policy names. **Client secrets, keys and policy members (emails) are never returned** |
| `cloudflare_get_zone_analytics` | `POST /graphql` (`httpRequests1dGroups`, read only) | Requests, cached requests, bandwidth, threats, page views, unique visitors per day for 1 to 30 days |

### Write tools

Every write tool on an existing zone takes **`zone_id` and `zone_name`** (the import takes `zone`, see below). Before changing anything it reads the zone and stops if the ID is not that zone, so a wrong ID cannot change another client's zone, and an approver sees the domain name in the proposal. Record changes also read the record first and stop if it is not the one named (`current_name`, or `name` and `type` for a delete). Then the tool sends **exactly one change**, which is never retried.

| Tool | Cloudflare API | Notes |
|------|----------------|-------|
| `cloudflare_create_zone` | `POST /zones` (`type: full`) | Adds a domain (`zone_name`) to an account (`account_id`; optional only when the token sees a single account, otherwise the error lists them). Returns the zone ID, status (`pending` until the name servers change), the **assigned `name_servers`**, the `original_name_servers` and the next step: recreate the records, then set the name servers at the registrar (Synergy Wholesale: `synergy_update_nameservers`). No records are imported unless `jump_start` is true (default false; Cloudflare's current API reference no longer lists this option). A name that already exists (Cloudflare error 1061) returns an error naming the existing zone when the token can see it |
| `cloudflare_import_dns_records` | `POST /zones/{id}/dns_records/import` (multipart `file`, `proxied`) | Takes `zone` (name or ID), `zone_file` (BIND text, up to 256 KB) and `proxied` (default false). The text is checked first: anything that is not a BIND zone file is refused ("convert it to BIND format first"), every record must be in the zone, and SOA and apex NS records are left out (Cloudflare manages them) and listed under `skipped`. One change for all the records. Returns `recs_added`, `total_records_parsed`, the records sent by type, and any messages Cloudflare returned for records it did not add. It only adds: importing the same records twice can create duplicates, so list the zone's records first |
| `cloudflare_create_dns_record` | `POST /zones/{id}/dns_records` | A, AAAA, CNAME, MX, TXT, NS. Content is checked for the type (an IP address, a host name). TTL 1 (automatic) by default; proxied only for A/AAAA/CNAME |
| `cloudflare_update_dns_record` | `PATCH /zones/{id}/dns_records/{id}` | Content, name, TTL, proxied, MX priority, comment (`""` removes it); not the type. Returns the record before and after |
| `cloudflare_delete_dns_record` | `DELETE /zones/{id}/dns_records/{id}` | **Destructive.** Returns the deleted record so it can be recreated |
| `cloudflare_purge_cache_urls` | `POST /zones/{id}/purge_cache` (`files`) | Up to 30 URLs, each on the zone or a subdomain of it |
| `cloudflare_purge_cache_everything` | `POST /zones/{id}/purge_cache` (`purge_everything`) | **Destructive**: every visitor's next requests go to the origin |
| `cloudflare_set_ssl_mode` | `PATCH /zones/{id}/settings/ssl` | `off`, `flexible`, `full`, `strict` |
| `cloudflare_set_always_use_https` | `PATCH /zones/{id}/settings/always_use_https` | |
| `cloudflare_set_development_mode` | `PATCH /zones/{id}/settings/development_mode` | Turns itself off after 3 hours |

Destructive tools have the MCP annotation `destructiveHint: true` (all others `false`), and the package exports their names (`DESTRUCTIVE_TOOL_NAMES`) so a host can gate them separately. SRV, CAA and other structured record types can be read but not written by these tools.

## API token permissions

Create a **custom user API token** (dash.cloudflare.com > My Profile > API Tokens > Create Token > Create Custom Token). Not a Global API Key, and not an account-owned token: an account-owned token works in one account only, and Cititec manages each client in its own account. Create the token on a user that is a member of every client account, preferably a dedicated service user (Cloudflare's 1,200 requests per 5 minutes is counted per user, including that user's dashboard use).

**Read-only token** (the host's `-ro.env`):

| Scope | Permission | Level | Used by |
|-------|-----------|-------|---------|
| Account | Account Settings | Read | `cloudflare_list_accounts` |
| Account | Access: Apps and Policies | Read | `cloudflare_list_access_apps` |
| Zone | Zone | Read | zone lookups, `cloudflare_list_zones`, `cloudflare_get_zone` |
| Zone | DNS | Read | `cloudflare_list_dns_records`, `cloudflare_get_dns_record` |
| Zone | Zone Settings | Read | `cloudflare_get_zone_settings`, `cloudflare_get_ssl_status` |
| Zone | SSL and Certificates | Read | `cloudflare_get_ssl_status` (certificate packs) |
| Zone | Page Rules | Read | `cloudflare_list_page_rules` |
| Zone | Single Redirect (listed as Dynamic Redirect on older dashboards) | Read | `cloudflare_list_redirect_rules` |
| Zone | Analytics | Read | `cloudflare_get_zone_analytics` |

**Write token** (the host's `-rw.env`, used for everyone granted `rw`, so it needs the read permissions too): everything above, with these levels instead:

| Scope | Permission | Level | Used by |
|-------|-----------|-------|---------|
| Zone | Zone | **Edit** | `cloudflare_create_zone` |
| Zone | DNS | **Edit** | create, update and delete DNS records, `cloudflare_import_dns_records` |
| Zone | Zone Settings | **Edit** | SSL mode, Always Use HTTPS, development mode |
| Zone | Cache Purge | **Purge** | both purge tools |

Creating a zone: Cloudflare's [Create Zone](https://developers.cloudflare.com/api/resources/zones/methods/create/) reference accepts either **Zone > Zone > Edit** or **Zone > DNS > Edit** for `POST /zones`, so the write token above (which already has DNS Edit) can create zones; Zone > Zone > Edit is listed because it is the permission meant for zone management. The token's **Zone Resources** must be "All zones from an account" or "All zones" (a token limited to named zones cannot cover a zone that does not exist yet), and its **Account Resources** must include the account. Zone > Zone > Edit also lets the token delete and pause zones through the API; no tool here does that. [Import DNS Records](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/import/) needs DNS Write (DNS Edit).

For both tokens:
- **Account Resources:** Include > All accounts. **Zone Resources:** Include > All zones from all accounts (or All zones). New client accounts and zones are then covered without editing the token.
- **Client IP Address Filtering:** Is in > the MCP host's public IP address, so a leaked token is useless elsewhere.
- **TTL:** an end date, and a reminder to rotate it.

A tool whose permission is missing returns an `auth` error (HTTP 403, code 9109 "Unauthorized to access requested resource"); the other tools keep working. Nothing here needs Workers, Tunnels, Access edit, Billing, Members or API Tokens permissions.

## Errors and rate limits

A failed call returns `isError: true` with a first line for people and a JSON line for programs, also in `structuredContent`:

```
Error: Cloudflare rate-limited the request (HTTP 429): GET /zones. Try again in 300 s.
{"error":"rate_limited","message":"...","retry_after_seconds":300}
```

`error` is one of `rate_limited`, `auth`, `invalid_input`, `not_found`, `api_error`, `config`.

Cloudflare allows **1,200 requests per 5 minutes per user** (dashboard and API tokens together) and 200 per second per IP; going over blocks every call for 5 minutes ([limits](https://developers.cloudflare.com/fundamentals/api/reference/limits/)). Following the Cititec fleet policy:
- a **read** that gets HTTP 429 (or 503 with `Retry-After`) is retried **once**, and only when `Retry-After` is at most 10 s;
- a **write** is **never** retried; the error says it was not retried;
- otherwise the tool returns `rate_limited` with `retry_after_seconds` (`Retry-After`, or 300 when Cloudflare gives none).

Most tools make one request; a zone given by name adds one; `cloudflare_get_ssl_status` makes two; writes make two (zone check, change) and record updates and deletes three (zone check, record check, change). `cloudflare_create_zone` makes one (two without `account_id`: the account lookup), plus one read after a "zone already exists" error; `cloudflare_import_dns_records` makes two (zone lookup, import). The Cititec MCP host also limits calls for everyone together, from these figures.

## Development

```bash
npm ci
npm run lint    # tsc --noEmit
npm test        # vitest
npm run build   # tsup -> dist/index.js
```

Run it over stdio with `CLOUDFLARE_API_TOKEN=... node dist/index.js`.

Releases: commits to `main` with Conventional Commit messages are released by the **Cititec release** workflow (semantic-release), which tags the version and pushes `ghcr.io/cititec-pty-ltd/cloudflare-mcp:v<version>` and `:latest`.

## Licence

Apache 2.0. See `LICENSE` and `NOTICE`.
