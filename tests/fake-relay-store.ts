/**
 * A WebSocket that is a relay, in memory.
 *
 * Installed as the global `WebSocket`, it lets the real socket code run: a
 * relay is a function from what the client sent to what it sends back.
 * Unknown URLs refuse the connection.
 */

import type { NostrEvent } from '../types/nostr';

export type RelayScript = (socket: FakeSocket, message: unknown[]) => void;

export interface FakeRelay {
  /** Fail the connection instead of opening it. */
  refuse?: boolean;
  onMessage?: RelayScript;
}

export const fakeRelays: Map<string, FakeRelay> = new Map();
export const sockets: FakeSocket[] = [];

export class FakeSocket extends EventTarget {
  static readonly CONNECTING: number = 0;
  static readonly OPEN: number = 1;
  static readonly CLOSING: number = 2;
  static readonly CLOSED: number = 3;

  readyState: number = FakeSocket.CONNECTING;
  sent: unknown[][] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    super();
    sockets.push(this);
    queueMicrotask((): void => {
      if (this.readyState !== FakeSocket.CONNECTING) return;
      if (fakeRelays.get(url)?.refuse ?? !fakeRelays.has(url)) {
        this.emit('error', new Event('error'));
        this.close();
        return;
      }
      this.readyState = FakeSocket.OPEN;
      this.emit('open', new Event('open'));
    });
  }

  send(data: string): void {
    const message: unknown[] = JSON.parse(data) as unknown[];
    this.sent.push(message);
    fakeRelays.get(this.url)?.onMessage?.(this, message);
  }

  close(): void {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.emit('close', new Event('close'));
  }

  /** The relay speaking. */
  receive(message: unknown[]): void {
    this.emit(
      'message',
      new MessageEvent('message', { data: JSON.stringify(message) }),
    );
  }

  /** Something that is not JSON at all. */
  emitRaw(data: string): void {
    this.emit('message', new MessageEvent('message', { data }));
  }

  private emit(
    type: 'open' | 'message' | 'error' | 'close',
    event: Event,
  ): void {
    this.dispatchEvent(event);
    const handler = this[`on${type}`] as ((event: Event) => void) | null;
    handler?.(event);
  }
}

export function installFakeWebSocket(): void {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
}

/**
 * A relay holding `events`: every REQ gets all of them (the client's filter
 * check does the narrowing) and EOSE; every EVENT gets `OK` with `accept`,
 * and is kept when accepted.
 */
export function storeRelay(
  events: NostrEvent[],
  accept: boolean = true,
): FakeRelay {
  return {
    onMessage: (socket: FakeSocket, message: unknown[]): void => {
      if (message[0] === 'REQ') {
        for (const event of events)
          socket.receive(['EVENT', message[1], event]);
        socket.receive(['EOSE', message[1]]);
      } else if (message[0] === 'EVENT') {
        const event = message[1] as NostrEvent;
        if (accept) events.push(event);
        socket.receive(['OK', event.id, accept, '']);
      }
    },
  };
}

/** Lets queued deliveries and timers of 0 ms run. */
export async function settle(rounds: number = 5): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

export function last<T>(items: T[]): T | undefined {
  return items[items.length - 1];
}
