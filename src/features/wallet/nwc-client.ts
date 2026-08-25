/**
 * NIP-47 Nostr Wallet Connect client.
 *
 * The wallet stays wherever the user already runs it. This app holds only a
 * connection secret that authorises requests to it, never the funds and never
 * the wallet's own keys.
 *
 * `nostr-tools` ships `nip47` with `pay_invoice` only, so the request and
 * response plumbing lives here to reach `get_info` and `get_balance` as well.
 */

import { finalizeEvent, getPublicKey, nip04 } from 'nostr-tools';
import type { NostrEvent } from '../../../types/nostr';

const REQUEST_KIND: number = 23194;
const RESPONSE_KIND: number = 23195;

/** Wallets are expected to answer well inside this; slow ones do exist. */
const DEFAULT_TIMEOUT_MS: number = 30_000;

export interface NwcConnection {
  walletPubkey: string;
  relay: string;
  secret: string;
  /** Lightning address advertised by the wallet, when it provides one. */
  lud16?: string;
}

export interface NwcInfo {
  alias?: string;
  methods: string[];
}

export interface NwcPayResult {
  preimage: string;
  feesPaid?: number;
}

export class NwcError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'NwcError';
    this.code = code;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.slice(i, i + 2), 16));
  }
  return new Uint8Array(bytes);
}

/**
 * Parses a `nostr+walletconnect://` URI.
 *
 * Hand-rolled rather than using `nip47.parseConnectionString` so the optional
 * `lud16` survives and the errors say what is actually wrong.
 */
export function parseNwcUri(uri: string): NwcConnection {
  const trimmed: string = uri.trim();
  if (!trimmed.startsWith('nostr+walletconnect://')) {
    throw new Error('Not a wallet connection string.');
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('Malformed wallet connection string.');
  }

  const walletPubkey: string = (url.host || url.pathname).replace(/^\/+/, '');
  const relay: string | null = url.searchParams.get('relay');
  const secret: string | null = url.searchParams.get('secret');

  if (!/^[0-9a-f]{64}$/i.test(walletPubkey)) {
    throw new Error('Connection string has no valid wallet key.');
  }
  if (!relay) {
    throw new Error('Connection string has no relay.');
  }
  if (!secret || !/^[0-9a-f]{64}$/i.test(secret)) {
    throw new Error('Connection string has no valid secret.');
  }

  const lud16: string | null = url.searchParams.get('lud16');
  return {
    walletPubkey: walletPubkey.toLowerCase(),
    relay,
    secret: secret.toLowerCase(),
    ...(lud16 ? { lud16 } : {}),
  };
}

/**
 * Sends one request and waits for the matching response.
 *
 * A socket per request keeps this simple and stateless. Wallet calls are rare
 * and user-initiated, so holding a connection open would cost more than it saves.
 */
async function request<T>(
  connection: NwcConnection,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const secretKey: Uint8Array = hexToBytes(connection.secret);
  const clientPubkey: string = getPublicKey(secretKey);

  const content: string = await nip04.encrypt(
    secretKey,
    connection.walletPubkey,
    JSON.stringify({ method, params }),
  );

  const event: NostrEvent = finalizeEvent(
    {
      kind: REQUEST_KIND,
      created_at: Math.floor(Date.now() / 1000),
      content,
      tags: [['p', connection.walletPubkey]],
    },
    secretKey,
  ) as NostrEvent;

  return new Promise<T>((resolve, reject) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(connection.relay);
    } catch {
      reject(new NwcError('RELAY_ERROR', 'Could not reach the wallet relay.'));
      return;
    }

    let settled: boolean = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Already closing; nothing to recover from.
      }
      fn();
    };

    const timer = setTimeout((): void => {
      finish((): void =>
        reject(new NwcError('TIMEOUT', 'The wallet did not respond.')),
      );
    }, timeoutMs);

    socket.onopen = (): void => {
      // Subscribe before publishing, or a fast wallet's reply is missed.
      socket.send(
        JSON.stringify([
          'REQ',
          `nwc-${event.id.slice(0, 12)}`,
          {
            kinds: [RESPONSE_KIND],
            authors: [connection.walletPubkey],
            '#p': [clientPubkey],
            '#e': [event.id],
            limit: 1,
          },
        ]),
      );
      socket.send(JSON.stringify(['EVENT', event]));
    };

    socket.onmessage = (message: MessageEvent): void => {
      void (async (): Promise<void> => {
        let frame: unknown[];
        try {
          frame = JSON.parse(message.data);
        } catch {
          return;
        }

        if (frame[0] === 'OK' && frame[2] === false) {
          finish((): void =>
            reject(
              new NwcError(
                'REJECTED',
                typeof frame[3] === 'string'
                  ? frame[3]
                  : 'The relay rejected the request.',
              ),
            ),
          );
          return;
        }

        if (frame[0] !== 'EVENT') {
          return;
        }

        const response = frame[2] as NostrEvent | undefined;
        if (!response || response.kind !== RESPONSE_KIND) {
          return;
        }

        try {
          const plaintext: string = await nip04.decrypt(
            secretKey,
            connection.walletPubkey,
            response.content,
          );
          const payload = JSON.parse(plaintext) as {
            result?: T;
            error?: { code?: string; message?: string };
          };

          if (payload.error) {
            finish((): void =>
              reject(
                new NwcError(
                  payload.error?.code ?? 'ERROR',
                  payload.error?.message ?? 'The wallet refused the request.',
                ),
              ),
            );
            return;
          }

          finish((): void => resolve(payload.result as T));
        } catch {
          finish((): void =>
            reject(
              new NwcError(
                'DECRYPT_FAILED',
                'Could not read the wallet reply.',
              ),
            ),
          );
        }
      })();
    };

    socket.onerror = (): void => {
      finish((): void =>
        reject(
          new NwcError('RELAY_ERROR', 'Could not reach the wallet relay.'),
        ),
      );
    };
  });
}

/** Confirms the connection works and reports what the wallet supports. */
export async function getInfo(connection: NwcConnection): Promise<NwcInfo> {
  const result = await request<{ alias?: string; methods?: string[] }>(
    connection,
    'get_info',
    {},
  );
  return {
    ...(result?.alias ? { alias: result.alias } : {}),
    methods: Array.isArray(result?.methods) ? result.methods : [],
  };
}

/** Returns the spendable balance in sats. NIP-47 reports millisats. */
export async function getBalance(connection: NwcConnection): Promise<number> {
  const result = await request<{ balance?: number }>(
    connection,
    'get_balance',
    {},
  );
  return Math.floor((result?.balance ?? 0) / 1000);
}

export async function payInvoice(
  connection: NwcConnection,
  invoice: string,
): Promise<NwcPayResult> {
  const result = await request<{ preimage?: string; fees_paid?: number }>(
    connection,
    'pay_invoice',
    { invoice },
    // Routing a payment can legitimately take longer than a query.
    60_000,
  );

  if (!result?.preimage) {
    throw new NwcError('NO_PREIMAGE', 'The wallet reported no payment proof.');
  }
  return {
    preimage: result.preimage,
    ...(typeof result.fees_paid === 'number'
      ? { feesPaid: Math.floor(result.fees_paid / 1000) }
      : {}),
  };
}
