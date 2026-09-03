/**
 * What nox says about itself.
 *
 * The web's About page and the phone's read from here, so the list of NIPs
 * the app honours is written once and is the same on every screen it is
 * shown on. When a NIP is implemented it is added here, and both pages say
 * so.
 */

export interface SupportedNip {
  /** The number alone: 1, 17, 65. */
  nip: number;
  /** What it is for, in this app's terms. */
  title: string;
  /** Anything a reader should know - read-only, native-only. */
  note?: string;
}

/** Where a thank-you can be sent. */
export const ZAP_ADDRESS: string = 'zap@nox.garden';

export const SUPPORTED_NIPS: readonly SupportedNip[] = [
  { nip: 1, title: 'Events, relays and subscriptions' },
  { nip: 2, title: 'Follow lists' },
  { nip: 5, title: 'Names like user@domain.com on profiles' },
  { nip: 7, title: 'Signing with a browser extension', note: 'web only' },
  { nip: 9, title: 'Deleting your own posts, and honouring deletions' },
  { nip: 10, title: 'Reply threading' },
  { nip: 17, title: 'Private messages' },
  { nip: 18, title: 'Reposts' },
  { nip: 19, title: 'npub, note, nevent and nprofile links' },
  { nip: 25, title: 'Reactions' },
  { nip: 30, title: 'Custom emoji', note: 'web only' },
  { nip: 36, title: 'Content warnings, reading and writing' },
  { nip: 38, title: 'User statuses', note: 'web only, read only' },
  { nip: 42, title: 'Relay authentication' },
  { nip: 44, title: 'Encryption' },
  { nip: 47, title: 'Lightning wallet connect' },
  { nip: 51, title: 'Mute lists' },
  { nip: 56, title: 'Reports' },
  { nip: 57, title: 'Zaps' },
  { nip: 59, title: 'Gift wrap, for private messages' },
  { nip: 65, title: 'Relay lists' },
  { nip: 89, title: 'Which client a post came from', note: 'web only' },
  { nip: 92, title: 'Media tags', note: 'read only' },
];

/** `NIP-05`, zero-padded the way the specifications are named. */
export function nipLabel(nip: number): string {
  return `NIP-${String(nip).padStart(2, '0')}`;
}

/** The link to the specification itself. */
export function nipUrl(nip: number): string {
  return `https://github.com/nostr-protocol/nips/blob/master/${String(nip).padStart(2, '0')}.md`;
}
