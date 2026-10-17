/**
 * Relays in memory, behind a stand-in for the global `WebSocket`.
 *
 * Several shared modules open sockets themselves rather than taking an
 * opener, so the only way to answer them without a network is to replace
 * the constructor they call. Importing this module does that. Each relay is
 * scripted by URL: what it holds, whether it accepts what is published, and
 * whether it refuses the connection. Nothing reaches a real relay. Also a
 * memory key-value store, since Node has no localStorage.
 */

import { type Filter, finalizeEvent, matchFilter } from 'nostr-tools';
import { setKvStore } from '../src/common/kv.js';
import type { NostrEvent } from '../types/nostr';

export interface FakeRelay {
  /** What a REQ is answered from. */
  events: NostrEvent[];
  /** Whether a published EVENT gets `OK true` (and is then held). */
  accepts: boolean;
  /** Fail the connection instead of opening it. */
  refuses: boolean;
  /** Open, but never say anything. */
  silent: boolean;
  /** Answer this REQ with CLOSED instead of events. */
  closes?: (filter: Record<string, unknown>) => boolean;
  /** Every REQ filter received, in order. */
  requests: Array<Record<string, unknown>>;
  /** Every EVENT published to it. */
  published: NostrEvent[];
}

const relays: Map<string, FakeRelay> = new Map();

/** Scripts the relay at `url` (as written, no trailing slash). */
export function fakeRelay(
  url: string,
  over: Partial<FakeRelay> = {},
): FakeRelay {
  const relay: FakeRelay = {
    events: [],
    accepts: true,
    refuses: false,
    silent: false,
    requests: [],
    published: [],
    ...over,
  };
  relays.set(url.replace(/\/$/, ''), relay);
  return relay;
}

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING: number = 0;
  static readonly OPEN: number = 1;
  static readonly CLOSING: number = 2;
  static readonly CLOSED: number = 3;

  readyState: number = FakeWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  private readonly relay: FakeRelay | undefined;

  constructor(url: string) {
    super();
    this.relay = relays.get(url.replace(/\/$/, ''));
    setTimeout((): void => {
      if (!this.relay || this.relay.refuses) {
        this.readyState = FakeWebSocket.CLOSED;
        this.emit(new Event('error'));
        this.emit(new Event('close'));
        return;
      }
      this.readyState = FakeWebSocket.OPEN;
      this.emit(new Event('open'));
    }, 0);
  }

  send(data: string): void {
    const relay: FakeRelay | undefined = this.relay;
    if (!relay || relay.silent) return;
    const message: unknown[] = JSON.parse(data);
    if (message[0] === 'REQ') {
      const subId: string = String(message[1]);
      const filter = message[2] as Record<string, unknown>;
      relay.requests.push(filter);
      if (relay.closes?.(filter)) {
        this.reply(['CLOSED', subId, 'blocked: not here']);
        return;
      }
      // Newest first, up to the limit, as relays answer.
      const matched: NostrEvent[] = relay.events
        .filter((event) => matchFilter(filter as Filter, event as never))
        .sort((a, b) => b.created_at - a.created_at);
      const limit: unknown = filter.limit;
      const sent: NostrEvent[] =
        typeof limit === 'number' ? matched.slice(0, limit) : matched;
      for (const event of sent) this.reply(['EVENT', subId, event]);
      this.reply(['EOSE', subId]);
    } else if (message[0] === 'EVENT') {
      const event = message[1] as NostrEvent;
      relay.published.push(event);
      if (relay.accepts) relay.events.push(event);
      this.reply(['OK', event.id, relay.accepts, '']);
    }
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    setTimeout((): void => this.emit(new Event('close')), 0);
  }

  private reply(message: unknown[]): void {
    setTimeout((): void => {
      if (this.readyState !== FakeWebSocket.OPEN) return;
      this.emit(new MessageEvent('message', { data: JSON.stringify(message) }));
    }, 0);
  }

  private emit(event: Event): void {
    const handler = (this as unknown as Record<string, unknown>)[
      `on${event.type}`
    ];
    if (typeof handler === 'function') handler.call(this, event);
    this.dispatchEvent(event);
  }
}

(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;

/** A fresh in-memory store behind `kvGet`/`kvSet`, in place of localStorage. */
export function memoryKv(): Map<string, string> {
  const held: Map<string, string> = new Map();
  setKvStore({
    get: (key: string): string | null => held.get(key) ?? null,
    set: (key: string, value: string): void => {
      held.set(key, value);
    },
    remove: (key: string): void => {
      held.delete(key);
    },
  });
  return held;
}

/** A genuinely signed event, as plain JSON the way a relay would send it. */
export function signed(
  key: Uint8Array,
  event: {
    kind: number;
    content?: string;
    tags?: string[][];
    created_at?: number;
  },
): NostrEvent {
  return JSON.parse(
    JSON.stringify(
      finalizeEvent(
        {
          kind: event.kind,
          content: event.content ?? '',
          tags: event.tags ?? [],
          created_at: event.created_at ?? 1_700_000_000,
        },
        key,
      ),
    ),
  ) as NostrEvent;
}
