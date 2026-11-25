import { InputError } from './shared.js';

// A small BIND zone file reader for cloudflare_import_dns_records. It does not
// resolve every corner of RFC 1035; it checks that the text IS a zone file
// (so a CSV, a JSON export or a provider's table is refused before anything
// is sent), works out each record's owner and type, and finds the lines of the
// records Cloudflare manages itself (SOA, and NS at the apex) so they can be
// left out. The other lines are sent to Cloudflare as written, except that a record which
// inherits the previous owner (its line starts with a space) gets the owner written out.

/** Record types a zone file can hold that Cloudflare imports (plus SOA, which is dropped). */
export const BIND_TYPES = new Set([
  'A', 'AAAA', 'CAA', 'CERT', 'CNAME', 'DNSKEY', 'DS', 'HTTPS', 'LOC', 'MX', 'NAPTR', 'NS', 'OPENPGPKEY', 'PTR',
  'SMIMEA', 'SOA', 'SPF', 'SRV', 'SSHFP', 'SVCB', 'TLSA', 'TXT', 'URI',
]);

const CLASSES = new Set(['IN', 'CH', 'HS', 'CS']);
const TTL = /^\d+[smhdw]?(?:\d+[smhdw])*$/i;
const BAD_FORMAT =
  'zone_file is not a BIND zone file. Convert it to BIND format first: one record per line as ' +
  '"name TTL IN TYPE value", e.g. "www 3600 IN A 192.0.2.10"';

export interface BindRecord {
  /** Full owner name, lower case, without the trailing dot. */
  name: string;
  type: string;
  /** 1-based line numbers the record spans. */
  firstLine: number;
  lastLine: number;
}

export interface BindSkipped {
  name: string;
  type: string;
  line: number;
  reason: string;
}

export interface BindParse {
  records: BindRecord[];
  /** Records kept, by type. */
  counts: Record<string, number>;
  skipped: BindSkipped[];
  /** The text to send: the original lines without the skipped records. */
  text: string;
}

interface Token {
  text: string;
  quoted: boolean;
}

/** Splits one logical entry into tokens; quotes kept together, comments dropped. */
function tokenize(s: string, line: number): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ';') {
      // A comment runs to the end of its physical line (entries in parentheses span several).
      const nl = s.indexOf('\n', i);
      if (nl < 0) break;
      i = nl + 1;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '(' || c === ')') {
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let text = '';
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\' && j + 1 < s.length) {
          text += s[j] + s[j + 1];
          j += 2;
        } else {
          text += s[j++];
        }
      }
      if (j >= s.length) throw new InputError(`zone_file line ${line}: a quoted string is not closed. ${BAD_FORMAT}`);
      out.push({ text, quoted: true });
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < s.length && !' \t\n();"'.includes(s[j])) j += s[j] === '\\' && j + 1 < s.length ? 2 : 1;
    out.push({ text: s.slice(i, j), quoted: false });
    i = j;
  }
  return out;
}

/** Parentheses outside quotes and comments: the change in depth over the line. */
function parenDepth(s: string): number {
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '\\') i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ';') break;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
  }
  return depth;
}

function absolute(name: string, origin: string): string {
  const n = name.toLowerCase();
  if (n === '@') return origin;
  if (n.endsWith('.')) return n.slice(0, -1);
  return origin ? `${n}.${origin}` : n;
}

/**
 * Reads a BIND zone file for `zone` (lower case, no trailing dot). Throws
 * InputError when the text is not a zone file or has a record outside the zone.
 */
export function parseBindZone(text: string, zone: string): BindParse {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let origin = zone;
  let previousOwner: string | undefined;
  const records: BindRecord[] = [];
  const skipped: BindSkipped[] = [];
  const drop = new Set<number>();
  // Records that inherit the owner (the line starts with a space) get it written out: a dropped
  // record before them would otherwise change the owner Cloudflare gives them.
  const named = new Map<number, string>();
  const outside: string[] = [];
  let dollarTtl = false;
  /** The last TTL stated on any record, and on a record that is sent. */
  let lastTtl: string | undefined;
  let lastKeptTtl: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const first = i + 1;
    let entry = lines[i];
    let depth = parenDepth(entry);
    while (depth > 0 && i + 1 < lines.length) {
      i++;
      entry += `\n${lines[i]}`;
      depth += parenDepth(lines[i]);
    }
    if (depth !== 0) throw new InputError(`zone_file line ${first}: parentheses do not match. ${BAD_FORMAT}`);
    const last = i + 1;
    const startsBlank = /^[ \t]/.test(entry);
    const tokens = tokenize(entry, first);
    if (tokens.length === 0) continue;

    const head = tokens[0].text.toUpperCase();
    if (!tokens[0].quoted && head.startsWith('$')) {
      if (head === '$ORIGIN' && tokens[1]) {
        origin = absolute(tokens[1].text, origin);
        continue;
      }
      if (head === '$TTL' && tokens[1] && TTL.test(tokens[1].text)) {
        dollarTtl = true;
        continue;
      }
      throw new InputError(`zone_file line ${first}: ${tokens[0].text} is not supported here. ${BAD_FORMAT}`);
    }

    let k = 0;
    let owner: string | undefined;
    if (startsBlank) {
      owner = previousOwner;
    } else {
      owner = absolute(tokens[0].text, origin);
      k = 1;
    }
    // Optional TTL and class, in either order.
    let ttl: string | undefined;
    for (let n = 0; n < 2 && k < tokens.length; n++) {
      const t = tokens[k].text.toUpperCase();
      if (tokens[k].quoted) break;
      if (TTL.test(t)) ttl = tokens[k].text;
      if (TTL.test(t) || CLASSES.has(t)) k++;
    }
    const type = k < tokens.length && !tokens[k].quoted ? tokens[k].text.toUpperCase() : '';
    if (!owner || !BIND_TYPES.has(type) || k + 1 >= tokens.length) {
      throw new InputError(`zone_file line ${first}: "${lines[first - 1].trim().slice(0, 80)}" is not a zone file record. ${BAD_FORMAT}`);
    }
    previousOwner = owner;

    if (owner !== zone && !owner.endsWith(`.${zone}`)) {
      outside.push(`${owner} (line ${first})`);
      continue;
    }
    const reason =
      type === 'SOA'
        ? 'SOA: Cloudflare manages the zone\'s SOA record'
        : type === 'NS' && owner === zone
          ? 'NS at the apex: Cloudflare assigns the zone\'s name servers'
          : undefined;
    if (ttl !== undefined) lastTtl = ttl;
    if (reason) {
      skipped.push({ name: owner, type, line: first, reason });
      for (let l = first; l <= last; l++) drop.add(l);
      continue;
    }
    // Without $TTL, a record with no TTL takes the last one stated (RFC 1035 5.1). If that came
    // from a record left out, write it on this record so its TTL does not change.
    const addTtl = ttl === undefined && !dollarTtl && lastTtl !== undefined && lastTtl !== lastKeptTtl;
    if (startsBlank || addTtl) {
      const line = lines[first - 1];
      named.set(
        first,
        startsBlank
          ? `${owner}.${addTtl ? ` ${lastTtl}` : ''}${line}`
          : line.replace(/^(\S+)/, `$1 ${lastTtl}`)
      );
    }
    lastKeptTtl = ttl ?? (addTtl ? lastTtl : lastKeptTtl);
    records.push({ name: owner, type, firstLine: first, lastLine: last });
  }

  if (outside.length) {
    throw new InputError(
      `zone_file has records that are not in ${zone}: ${outside.slice(0, 5).join(', ')}${outside.length > 5 ? ` and ${outside.length - 5} more` : ''}. ` +
        'Check $ORIGIN, or that this is the export for this domain.'
    );
  }
  if (records.length === 0) {
    throw new InputError(
      skipped.length
        ? 'zone_file has no records to import once SOA and the apex NS records (which Cloudflare manages) are left out.'
        : `zone_file has no records. ${BAD_FORMAT}`
    );
  }
  const counts: Record<string, number> = {};
  for (const r of records) counts[r.type] = (counts[r.type] ?? 0) + 1;
  const kept = lines
    .map((l, idx) => named.get(idx + 1) ?? l)
    .filter((_, idx) => !drop.has(idx + 1))
    .join('\n');
  return { records, counts, skipped, text: kept.endsWith('\n') ? kept : `${kept}\n` };
}
