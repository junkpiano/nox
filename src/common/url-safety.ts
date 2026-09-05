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

function isPrivateV6(host: string): boolean {
  const text: string = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (text === '::' || text === '::1') return true;
  // Unique local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{2}:/.test(text)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(text)) return true;
  // An IPv4 address wearing an IPv6 coat - dotted, or as the URL parser
  // normalises it, two hex groups.
  const dotted: RegExpMatchArray | null = text.match(
    /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/,
  );
  if (dotted?.[1]) return isPrivateV4(dotted[1]);
  const hex: RegExpMatchArray | null = text.match(
    /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/,
  );
  if (hex?.[1] && hex[2]) {
    const high: number = Number.parseInt(hex[1], 16);
    const low: number = Number.parseInt(hex[2], 16);
    return isPrivateV4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }
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
