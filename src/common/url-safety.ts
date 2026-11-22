/**
 * Which addresses a link in somebody else's post may make this app fetch.
 *
 * A link card is fetched by the reader's device. That makes every reader's
 * phone a client anyone can point at a URL by posting it - and a phone is
 * on a home network, beside routers, printers and whatever else answers on
 * 192.168.x.x. A page from the public internet is fine to ask for; the
 * loopback, the private ranges, link-local, and bare names that only mean
 * something on the local network are not, and the same check is applied
 * to wherever the page redirects.
 *
 * Only the name is judged, never where it resolves: a public name pointing
 * at 192.168.1.1 passes. Link cards therefore go through the proxy worker on
 * every platform; what still uses this directly (LNURL, on a zap the user
 * started) accepts that limit.
 */

/** IPv4 blocks that never name a public site. */
const PRIVATE_V4: ReadonlyArray<[number, number]> = [
  [ip4('0.0.0.0'), 8],
  [ip4('10.0.0.0'), 8],
  [ip4('100.64.0.0'), 10],
  [ip4('127.0.0.0'), 8],
  [ip4('169.254.0.0'), 16],
  [ip4('172.16.0.0'), 12],
  [ip4('192.0.0.0'), 24],
  [ip4('192.168.0.0'), 16],
  [ip4('198.18.0.0'), 15],
  [ip4('224.0.0.0'), 4],
  [ip4('240.0.0.0'), 4],
];

function ip4(text: string): number {
  const parts: number[] = text.split('.').map(Number);
  return (
    (((parts[0] ?? 0) << 24) |
      ((parts[1] ?? 0) << 16) |
      ((parts[2] ?? 0) << 8) |
      (parts[3] ?? 0)) >>>
    0
  );
}

function isPrivateV4(host: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  const parts: number[] = host.split('.').map(Number);
  if (parts.some((part: number): boolean => part > 255)) return true;
  const address: number = ip4(host);
  return PRIVATE_V4.some(([network, bits]: [number, number]): boolean => {
    const mask: number = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (address & mask) >>> 0 === (network & mask) >>> 0;
  });
}

/** The eight 16-bit groups of an IPv6 address, or null if it is not one. */
function ip6Groups(text: string): number[] | null {
  let body: string = text;
  // A trailing dotted IPv4 is two groups.
  const tail: RegExpMatchArray | null = body.match(
    /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/,
  );
  if (tail?.[1] && tail[2]) {
    const v4: number[] = tail[2].split('.').map(Number);
    if (v4.some((part: number): boolean => part > 255)) return null;
    const [a = 0, b = 0, c = 0, d = 0] = v4;
    body = `${tail[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves: string[] = body.split('::');
  if (halves.length > 2) return null;
  const head: string[] = halves[0] ? halves[0].split(':') : [];
  const rest: string[] = halves[1] ? halves[1].split(':') : [];
  const missing: number = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const parts: string[] = [...head, ...Array(missing).fill('0'), ...rest];
  if (!parts.every((part: string): boolean => /^[0-9a-f]{1,4}$/.test(part))) {
    return null;
  }
  return parts.map((part: string): number => Number.parseInt(part, 16));
}

function v4From(high: number, low: number): string {
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function isPrivateV6(host: string): boolean {
  const text: string = host.replace(/^\[|\]$/g, '').toLowerCase();
  const g: number[] | null = ip6Groups(text);
  // Not an address the parser would accept: nothing to fetch.
  if (!g) return true;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const zeroTo = (n: number): boolean =>
    g.slice(0, n).every((x: number): boolean => x === 0);

  // Unspecified, loopback, and an IPv4 address in an IPv6 coat: mapped
  // (::ffff:0:0/96) or the old compatible form (::/96).
  if (zeroTo(5) && (g5 === 0xffff || g5 === 0)) {
    if (g5 === 0 && g6 === 0 && g7 <= 1) return true;
    return isPrivateV4(v4From(g6, g7));
  }
  // IPv4-translated (::ffff:0:0:0/96, SIIT).
  if (zeroTo(4) && g4 === 0xffff && g5 === 0) {
    return isPrivateV4(v4From(g6, g7));
  }
  // NAT64 (64:ff9b::/96) carries an IPv4 address; its local-use block
  // (64:ff9b:1::/48) is a private network by definition.
  if (g0 === 0x64 && g1 === 0xff9b) {
    if (g2 === 1) return true;
    if (g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
      return isPrivateV4(v4From(g6, g7));
    }
  }
  // 6to4 (2002::/16) names an IPv4 address in its next two groups.
  if (g0 === 0x2002) return isPrivateV4(v4From(g1, g2));
  // Teredo (2001::/32), benchmarking (2001:2::/48), ORCHID (2001:10::/28,
  // 2001:20::/28) and documentation (2001:db8::/32, 3fff::/20).
  if (g0 === 0x2001) {
    if (g1 === 0 || g1 === 0xdb8) return true;
    if (g1 === 2 && g2 === 0) return true;
    if ((g1 & 0xfff0) === 0x10 || (g1 & 0xfff0) === 0x20) return true;
  }
  if (g0 === 0x3fff && (g1 & 0xf000) === 0) return true;
  // SRv6 segment identifiers (5f00::/16) name routers, not sites.
  if (g0 === 0x5f00) return true;
  // Discard-only (100::/64).
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true;
  // Unique local (fc00::/7), link-local (fe80::/10), site-local
  // (fec0::/10, deprecated but still routed by some networks), multicast.
  if ((g0 & 0xfe00) === 0xfc00) return true;
  if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0) return true;
  if ((g0 & 0xff00) === 0xff00) return true;
  return false;
}

/**
 * Whether this is a public web address worth fetching on somebody's behalf.
 *
 * http(s) only; a host that is an IP in a private, loopback, link-local or
 * reserved range is refused, as is `localhost`, anything under `.local` or
 * `.internal`, and a bare name with no dot in it - the kind that resolves
 * only on the network the phone happens to be on.
 */
export function isPublicWebUrl(input: string): boolean {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;

  const host: string = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (host.startsWith('[') || host.includes(':')) return !isPrivateV6(host);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return !isPrivateV4(host);
  // Decimal or hex forms of an address (2130706433, 0x7f000001) are not
  // names either.
  if (/^(0x[0-9a-f]+|\d+)$/.test(host)) return false;
  return host.includes('.');
}
