/**
 * NIP-89: saying which client an event came from.
 *
 * Only where a person will see it. A post, a repost and a reaction are read by
 * others, and "via nox" is information there. A mute list or a relay list is
 * settings - nobody renders those, so a client name on them is a fact about the
 * author that buys nothing.
 *
 * The rule is an allow-list, and deliberately so. The events that must not
 * carry an extra tag are the ones easiest to forget: a relay checks a kind
 * 22242 AUTH against the challenge it issued, a media server checks a kind
 * 27235, and anything reaching a gift wrap has to stay bare or the sealing was
 * pointless. A deny-list protects those only until someone adds a kind nobody
 * thought to list; an allow-list protects them by default.
 *
 * The short form of the tag, not the handler reference NIP-89 also allows. That
 * form points at a kind 31990 published by the client's own identity, and nox
 * has no identity of its own to publish one from. Clients render "via nox" from
 * this either way.
 */

const CLIENT_NAME: string = 'nox';

/** Kinds a person actually reads. */
const TAGGED_KINDS: ReadonlySet<number> = new Set([
  1, // notes and replies
  6, // reposts
  7, // reactions
]);

/**
 * The parts of an event this needs to see.
 *
 * Narrower than an unsigned event on purpose: replies are built without a
 * pubkey and let the signer fill it in, and asking for fields that go unread
 * would have excluded them for no reason.
 */
interface Taggable {
  kind: number;
  tags: string[][];
}

/**
 * Returns the event with a client tag, where one belongs.
 *
 * A copy, never a mutation: callers build an event once and some of them sign
 * it more than once. The caller's own type comes back out, so wrapping a
 * literal does not widen what it was.
 */
export function withClientTag<T extends Taggable>(event: T): T {
  if (!TAGGED_KINDS.has(event.kind)) {
    return event;
  }
  if (event.tags.some((tag: string[]): boolean => tag[0] === 'client')) {
    return event;
  }

  return { ...event, tags: [...event.tags, ['client', CLIENT_NAME]] };
}

/**
 * The longest client name worth showing.
 *
 * The string belongs to whoever published the event, so its length is their
 * choice until it is ours. A name beside a timestamp has room for a word.
 */
const MAX_NAME_LENGTH: number = 24;

/**
 * Reads the client name off an event, for showing beside its timestamp.
 *
 * Returns null when there is nothing worth showing, which callers render as
 * nothing at all rather than as an empty separator.
 *
 * NIP-89 also allows a longer form - ["client", name, "31990:<pubkey>:<d>",
 * relay] - that points at the publisher's app handler. Only the name is for
 * reading; the rest addresses an event this client does not fetch.
 */
export function readClientName(tags: string[][]): string | null {
  const tag: string[] | undefined = tags.find(
    (candidate: string[]): boolean => candidate[0] === 'client',
  );
  const raw: unknown = tag?.[1];
  if (typeof raw !== 'string') {
    return null;
  }

  // Whitespace and control characters are stripped rather than escaped: this
  // name sits inside one line beside a timestamp, and a newline or a tab in it
  // is either a mistake or an attempt to break out of that line.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  const name: string = raw.replace(/[\s\u0000-\u001f\u007f]/g, '');
  if (!name) {
    return null;
  }

  return name.slice(0, MAX_NAME_LENGTH);
}
