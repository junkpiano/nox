import { finalizeEvent } from 'nostr-tools';
import type { NostrEvent, PubkeyHex } from '../../types/nostr';

const UPLOAD_URL = 'https://nostrcheck.me/api/v2/media';

export interface ImageUploadResult {
  url: string;
}

async function buildNip98AuthToken(
  url: string,
  method: string,
  pubkey: PubkeyHex,
  getPrivateKey: () => Uint8Array | null,
): Promise<string> {
  const unsignedEvent = {
    kind: 27235,
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['u', url],
      ['method', method],
    ],
    content: '',
  };

  let signedEvent: NostrEvent;
  const hasExtension: boolean = Boolean(
    (window as unknown as { nostr?: { signEvent?: unknown } }).nostr?.signEvent,
  );

  if (hasExtension) {
    signedEvent = await (window as unknown as { nostr: { signEvent: (e: unknown) => Promise<NostrEvent> } }).nostr.signEvent(unsignedEvent);
  } else {
    const privateKey: Uint8Array | null = getPrivateKey();
    if (!privateKey) {
      throw new Error('No signing method available');
    }
    signedEvent = finalizeEvent(unsignedEvent, privateKey) as NostrEvent;
  }

  return btoa(JSON.stringify(signedEvent));
}

export async function uploadImage(
  file: File,
  pubkey: PubkeyHex,
  getPrivateKey: () => Uint8Array | null,
): Promise<ImageUploadResult> {
  const authToken: string = await buildNip98AuthToken(
    UPLOAD_URL,
    'POST',
    pubkey,
    getPrivateKey,
  );

  const formData: FormData = new FormData();
  formData.append('uploadtype', 'media');
  formData.append('file', file);

  const response: Response = await fetch(UPLOAD_URL, {
    method: 'POST',
    headers: {
      Authorization: `Nostr ${authToken}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText: string = await response.text();
    throw new Error(`Upload failed: ${response.status} ${errorText}`);
  }

  const result: unknown = await response.json();

  // NIP-96 response: { status: 'success', nip94_event: { tags: [['url', '...']] } }
  if (
    result !== null &&
    typeof result === 'object' &&
    'nip94_event' in result
  ) {
    const nip94 = (result as { nip94_event: { tags?: string[][] } }).nip94_event;
    if (Array.isArray(nip94.tags)) {
      const urlTag: string[] | undefined = nip94.tags.find(
        (t: string[]) => t[0] === 'url',
      );
      if (urlTag?.[1]) {
        return { url: urlTag[1] };
      }
    }
  }

  // Fallback: direct url field
  if (result !== null && typeof result === 'object' && 'url' in result) {
    const url = (result as { url: unknown }).url;
    if (typeof url === 'string') {
      return { url };
    }
  }

  throw new Error('Upload succeeded but no URL in response');
}
