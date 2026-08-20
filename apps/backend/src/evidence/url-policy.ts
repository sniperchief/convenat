/**
 * URL normalisation and the address policy that stops retrieval becoming an
 * SSRF primitive.
 *
 * ## The threat, stated honestly
 *
 * A URL reaching this layer is **not** attacker-controlled at retrieval time. It
 * came from `ConditionSpec.approvedSources`, which a user reviewed and whose
 * bytes are inside `rulesHash`. So an attack requires first getting a hostile
 * URL through compilation and approval, and then waiting for resolution.
 *
 * That makes this defence-in-depth rather than the primary control — and it is
 * still necessary, because "the specification is the allowlist" only holds if
 * nobody ever approves a careless specification, and because a redirect can
 * take a perfectly innocent URL somewhere else entirely.
 *
 * ## Two layers
 *
 * 1. **Name-level** (`normalizeSourceUrl`): scheme, userinfo, port, fragment.
 *    Cheap, total, and it runs again on every redirect hop.
 * 2. **Address-level** (`assertAddressAllowed`, wired in through the adapter's
 *    DNS `lookup` hook): the actual IP the socket will connect to.
 *
 * The second layer is what closes DNS rebinding. Resolving a hostname, checking
 * the answer, and *then* handing the hostname to an HTTP client is a
 * time-of-check/time-of-use hole — the client resolves again, and a hostile
 * authoritative server can answer differently the second time. Supplying the
 * `lookup` function that `net.connect` itself calls removes the second
 * resolution entirely: the socket connects to an address this file returned.
 *
 * The policy **fails closed**. If a hostname resolves to several addresses and
 * any one of them is disallowed, the whole host is refused rather than the
 * allowed addresses being used — a split-horizon answer is exactly what an
 * attacker would arrange.
 */

import { isIP } from 'node:net';

import { SourceRetrievalError } from './types.js';

/** Ports a source may be read from. 443 only, unless an operator widens it. */
export const DEFAULT_ALLOWED_PORTS: readonly number[] = [443];

export interface UrlPolicy {
  readonly allowedPorts: readonly number[];
  /**
   * Optional operator allowlist of registrable hostnames. Empty means "no
   * host allowlist" — the ConditionSpec's approved sources are then the only
   * name-level control, which is the design (§1), with the address policy below
   * as the backstop. A non-empty list is matched on the exact host or on a
   * `.suffix` of it.
   */
  readonly allowedHosts: readonly string[];
}

export const DEFAULT_URL_POLICY: UrlPolicy = {
  allowedPorts: DEFAULT_ALLOWED_PORTS,
  allowedHosts: [],
};

/** A URL that has passed name-level policy. */
export interface NormalizedUrl {
  /** The canonical form. This is what is requested and what identifies a source. */
  readonly href: string;
  readonly hostname: string;
  readonly port: number;
  /** True when normalisation removed a fragment, which is never sent to a server. */
  readonly fragmentStripped: boolean;
}

/**
 * Normalise a source URL, or refuse it.
 *
 * The rules, in order — all of them documented in docs/ai-resolution.md §14:
 *
 * 1. Must parse as an absolute URL. Otherwise `SOURCE_UNSUPPORTED`.
 * 2. Scheme must be `https:`. Plain `http:` is refused rather than upgraded:
 *    silently promoting a scheme changes what the user approved. `file:`,
 *    `data:`, `ftp:`, `gopher:` and everything else are refused outright.
 * 3. Userinfo (`https://user:pass@host`) is refused. It is a credential, and an
 *    evidence package is published — the same rule `publicUrlSchema` applies in
 *    `@covenant/shared`, enforced here too because a redirect can introduce one.
 * 4. The port must be in the allowlist. This is the cheapest defence against
 *    using a source URL to reach an internal service on 22, 6379 or 11211.
 * 5. The fragment is stripped. A fragment is never transmitted, so two URLs
 *    differing only in one are the same request; keeping it would let two
 *    "different" approved sources be the same fetch.
 * 6. An empty query (`?`) is normalised to no query, for the same reason.
 * 7. Host case and IDN punycode are handled by `URL`. **Query parameter order is
 *    preserved** — sorting it would be a semantic change, not a normalisation.
 *
 * @throws {SourceRetrievalError} `SOURCE_UNSUPPORTED` or `SOURCE_FORBIDDEN`.
 */
export function normalizeSourceUrl(
  raw: string,
  policy: UrlPolicy = DEFAULT_URL_POLICY,
): NormalizedUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SourceRetrievalError('SOURCE_UNSUPPORTED', 'not an absolute URL');
  }

  if (url.protocol !== 'https:') {
    throw new SourceRetrievalError(
      'SOURCE_UNSUPPORTED',
      `scheme ${url.protocol.replace(':', '')} is not retrievable; approved sources must use https`,
    );
  }

  if (url.username !== '' || url.password !== '') {
    throw new SourceRetrievalError(
      'SOURCE_FORBIDDEN',
      'URL carries credentials in its userinfo, which an evidence package must never publish',
    );
  }

  const port = url.port === '' ? 443 : Number.parseInt(url.port, 10);
  if (!policy.allowedPorts.includes(port)) {
    throw new SourceRetrievalError(
      'SOURCE_FORBIDDEN',
      `port ${port} is not in the allowed set (${policy.allowedPorts.join(', ')})`,
    );
  }

  if (url.hostname === '') {
    throw new SourceRetrievalError('SOURCE_UNSUPPORTED', 'URL has no host');
  }

  // `URL` brackets an IPv6 literal host. Strip them so the address policy and
  // the DNS hook both see a plain address.
  const hostname =
    url.hostname.startsWith('[') && url.hostname.endsWith(']')
      ? url.hostname.slice(1, -1)
      : url.hostname;

  // A host written as a bare IP address needs no DNS, so the address policy is
  // a *name-level* fact here and is applied now. Leaving it to the transport
  // would mean a specification pointing at 169.254.169.254 reached a socket
  // before anything refused it — and would make the refusal untestable without
  // one.
  if (isIP(hostname) !== 0) {
    const reason = addressBlockedReason(hostname);
    if (reason !== null) {
      throw new SourceRetrievalError(
        'SOURCE_FORBIDDEN',
        `address ${hostname} is not a permitted evidence source (${reason})`,
      );
    }
  }

  if (policy.allowedHosts.length > 0 && !hostIsAllowed(hostname, policy.allowedHosts)) {
    throw new SourceRetrievalError(
      'SOURCE_FORBIDDEN',
      `host ${hostname} is not in the operator allowlist`,
    );
  }

  const fragmentStripped = url.hash !== '';
  url.hash = '';
  if (url.search === '?' || url.search === '') url.search = '';

  return {
    href: url.toString(),
    hostname,
    port,
    fragmentStripped,
  };
}

function hostIsAllowed(hostname: string, allowed: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return allowed.some((entry) => {
    const candidate = entry.toLowerCase().replace(/^\./, '');
    return host === candidate || host.endsWith(`.${candidate}`);
  });
}

// ---------------------------------------------------------------------------
// Address policy
// ---------------------------------------------------------------------------

/**
 * IPv4 ranges no evidence source may live in.
 *
 * The list is written out with its reasons because "private ranges" is not one
 * thing, and the interesting entries are the ones people forget:
 * `169.254.169.254` is the cloud instance-metadata endpoint and is the single
 * most valuable SSRF target in existence, and `100.64/10` is carrier-grade NAT,
 * which is routable-looking but internal.
 */
const BLOCKED_IPV4: ReadonlyArray<readonly [string, number, string]> = [
  ['0.0.0.0', 8, 'this network'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'carrier-grade NAT'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local, including the cloud metadata endpoint'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'IETF protocol assignments'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, '6to4 relay anycast'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved, including the broadcast address'],
];

function ipv4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number.parseInt(part, 10);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function ipv4Blocked(address: string): string | null {
  const value = ipv4ToInt(address);
  if (value === null) return 'not a well-formed IPv4 address';

  for (const [base, bits, reason] of BLOCKED_IPV4) {
    const baseValue = ipv4ToInt(base);
    if (baseValue === null) continue;
    // `>>> 0` keeps the mask unsigned; a /0 would shift by 32, which is a no-op
    // in JavaScript, but no entry above uses one.
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if (((value ^ baseValue) & mask) >>> 0) continue;
    return reason;
  }
  return null;
}

/** Expand an IPv6 address to its sixteen bytes, or null if unparseable. */
function ipv6ToBytes(address: string): Uint8Array | null {
  let text = address;
  // A zone index (`fe80::1%eth0`) is a local-interface selector; strip it before
  // parsing, and note that its presence alone implies link-local.
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);

  // A trailing dotted-quad (`::ffff:127.0.0.1`) is rewritten into the two hex
  // groups it stands for, so the rest of the parser only ever sees one form.
  // Rewriting rather than special-casing is what keeps the `::` expansion
  // arithmetic correct: the embedded address occupies two of the eight groups,
  // not zero of six.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const value = ipv4ToInt(tail);
    if (value === null) return null;
    const high = ((value >>> 16) & 0xffff).toString(16);
    const low = (value & 0xffff).toString(16);
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;

  const parseGroups = (segment: string): number[] | null => {
    if (segment === '') return [];
    const groups: number[] = [];
    for (const part of segment.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
      groups.push(Number.parseInt(part, 16));
    }
    return groups;
  };

  const head = parseGroups(halves[0] ?? '');
  const rest = halves.length === 2 ? parseGroups(halves[1] ?? '') : [];
  if (head === null || rest === null) return null;

  let groups: number[];
  if (halves.length === 2) {
    const gap = 8 - head.length - rest.length;
    if (gap < 0) return null;
    groups = [...head, ...Array<number>(gap).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = (group >> 8) & 0xff;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return bytes;
}

function ipv6Blocked(address: string): string | null {
  if (address.includes('%')) return 'link-local with a zone index';

  const bytes = ipv6ToBytes(address);
  if (bytes === null) return 'not a well-formed IPv6 address';

  const isZeroPrefix = (length: number): boolean =>
    bytes.slice(0, length).every((byte) => byte === 0);

  // An IPv4-mapped or NAT64-translated address is an IPv4 destination wearing an
  // IPv6 costume. Unwrap and apply the IPv4 policy, or the whole table above can
  // be walked around by writing ::ffff:127.0.0.1.
  const embedded = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
  if (isZeroPrefix(10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return ipv4Blocked(embedded) ?? null;
  }
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    return ipv4Blocked(embedded) ?? null;
  }

  if (isZeroPrefix(15) && bytes[15] === 0) return 'unspecified address';
  if (isZeroPrefix(15) && bytes[15] === 1) return 'loopback';
  if (((bytes[0] ?? 0) & 0xfe) === 0xfc) return 'unique local address';
  if ((bytes[0] ?? 0) === 0xfe && ((bytes[1] ?? 0) & 0xc0) === 0x80) return 'link-local';
  if ((bytes[0] ?? 0) === 0xff) return 'multicast';
  // 2002::/16 is 6to4, which tunnels to an embedded IPv4 address we cannot vet
  // from the outer address alone.
  if ((bytes[0] ?? 0) === 0x20 && (bytes[1] ?? 0) === 0x02) return '6to4 tunnel';
  // 100::/64 is the discard-only prefix: bytes 0-1 are 0x0100 and 2-7 are zero.
  if (
    (bytes[0] ?? 0) === 0x01 &&
    (bytes[1] ?? 0) === 0x00 &&
    bytes.slice(2, 8).every((byte) => byte === 0)
  ) {
    return 'discard-only prefix';
  }
  // Everything else in ::/8 is IETF-reserved and is not somewhere a public
  // evidence source lives.
  if (isZeroPrefix(8)) return 'reserved ::/8 prefix';

  return null;
}

/**
 * Why an address is refused, or null if it may be connected to.
 *
 * Returns a reason rather than throwing so the DNS hook can report every
 * offending address in one message.
 */
export function addressBlockedReason(address: string): string | null {
  const family = isIP(address);
  if (family === 4) return ipv4Blocked(address);
  if (family === 6) return ipv6Blocked(address);
  return 'not a recognisable IP address';
}

/**
 * Refuse an address that must not be connected to.
 *
 * @throws {SourceRetrievalError} `SOURCE_FORBIDDEN`.
 */
export function assertAddressAllowed(address: string): void {
  const reason = addressBlockedReason(address);
  if (reason !== null) {
    throw new SourceRetrievalError(
      'SOURCE_FORBIDDEN',
      `address ${address} is not a permitted evidence source (${reason})`,
    );
  }
}
