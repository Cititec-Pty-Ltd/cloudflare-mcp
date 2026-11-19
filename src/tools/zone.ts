import { CloudflareApiError } from '../types.js';
import type { Api, ParamSpec } from './spec.js';
import { ID32, MismatchError, asList, pick } from './shared.js';

export interface ZoneRef {
  id: string;
  name: string;
  /** The zone object, when it was fetched. */
  zone?: Record<string, unknown>;
}

export const ZONE: ParamSpec = {
  type: 'zone',
  required: true,
  description: 'The zone: its name (example.com.au) or its 32-character zone ID.',
};

export const ZONE_ID: ParamSpec = {
  type: 'id',
  required: true,
  description: 'The zone ID (32 hex characters, from cloudflare_get_zone or cloudflare_list_zones).',
};

export const ZONE_NAME: ParamSpec = {
  type: 'domain',
  required: true,
  description:
    'The zone name (example.com.au). Checked against zone_id before anything is changed, so the approver sees which domain this is.',
};

function notFound(ref: string): CloudflareApiError {
  return new CloudflareApiError(
    `No Cloudflare zone named ${ref} in any account this token can see. Its DNS may be hosted elsewhere ` +
      '(for a domain registered through Cititec, synergy_get_domain shows its name servers), or the zone is in an ' +
      'account the token does not include.',
    404
  );
}

/** Finds a zone by ID or name. One request. */
export async function resolveZone(api: Api, ref: string): Promise<ZoneRef> {
  if (ID32.test(ref)) {
    const { result } = await api.get(`/zones/${ref}`);
    const z = (result ?? {}) as Record<string, unknown>;
    return { id: ref, name: String(z.name ?? ''), zone: z };
  }
  const { result } = await api.get('/zones', { name: ref, per_page: 5 });
  const match = asList(result).find((z) => String(z.name).toLowerCase() === ref);
  if (!match || typeof match.id !== 'string') throw notFound(ref);
  return { id: match.id, name: ref, zone: match };
}

/** The zone ID without a request when an ID was given; looks it up by name otherwise. */
export async function zoneIdOf(api: Api, ref: string): Promise<string> {
  return ID32.test(ref) ? ref : (await resolveZone(api, ref)).id;
}

/**
 * Before a write: checks that zone_id is the zone the proposal named. A
 * mismatch stops the write (MismatchError), so a wrong ID cannot change
 * another client's zone.
 */
export async function verifyZone(api: Api, zoneId: string, zoneName: string): Promise<ZoneRef> {
  const z = await resolveZone(api, zoneId);
  if (z.name.toLowerCase() !== zoneName) {
    throw new MismatchError(`Zone ${zoneId} is ${z.name || '(unknown)'}, not ${zoneName}.`);
  }
  return z;
}

export function zoneSummary(z: Record<string, unknown>): Record<string, unknown> {
  const account = z.account as Record<string, unknown> | undefined;
  const plan = z.plan as Record<string, unknown> | undefined;
  return {
    ...pick(z, ['id', 'name', 'status', 'paused', 'type', 'development_mode', 'name_servers', 'original_name_servers']),
    ...(account ? { account: pick(account, ['id', 'name']) } : {}),
    ...(plan?.name ? { plan: plan.name } : {}),
    ...pick(z, ['activated_on', 'modified_on']),
  };
}
