import { signWithSession } from '../../common/signer.js';
/**
 * NIP-56 kind:1984 reports.
 *
 * Reports are public: they exist so relay operators and moderators can act on
 * them, unlike the mute list, which is private to the viewer.
 */

import type { NostrEvent, PubkeyHex } from '../../../types/nostr';

export const REPORT_KIND: number = 1984;

/** Report types defined by NIP-56. */
export type ReportType =
  | 'nudity'
  | 'malware'
  | 'profanity'
  | 'illegal'
  | 'spam'
  | 'impersonation'
  | 'other';

export const REPORT_TYPE_LABELS: ReadonlyArray<{
  value: ReportType;
  label: string;
}> = [
  { value: 'spam', label: 'Spam' },
  { value: 'nudity', label: 'Nudity or sexual content' },
  { value: 'profanity', label: 'Profanity or hateful speech' },
  { value: 'illegal', label: 'Illegal content' },
  { value: 'impersonation', label: 'Impersonation' },
  { value: 'malware', label: 'Malware' },
  { value: 'other', label: 'Other' },
];

export async function signReportEvent(params: {
  pubkeyHex: PubkeyHex;
  targetPubkey: PubkeyHex;
  eventId?: string;
  reportType: ReportType;
  comment?: string;
}): Promise<NostrEvent> {
  // NIP-56 puts the report type on the `e` tag when reporting a note, and on
  // the `p` tag when reporting an account.
  const tags: string[][] = params.eventId
    ? [
        ['e', params.eventId, params.reportType],
        ['p', params.targetPubkey],
      ]
    : [['p', params.targetPubkey, params.reportType]];

  const unsignedEvent: Omit<NostrEvent, 'id' | 'sig'> = {
    kind: REPORT_KIND,
    pubkey: params.pubkeyHex,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: params.comment ?? '',
  };

  return signWithSession(unsignedEvent);
}
