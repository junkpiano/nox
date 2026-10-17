/**
 * A WebSocket that never leaves the process.
 *
 * Installed on `globalThis` in place of the real one. Every socket opens on
 * the next turn and hands what the client sends to `respond`, which plays
 * the relay (or the wallet) and answers through `reply`. Both the `on*`
 * handlers and `addEventListener` see every event, because the code under
 * test uses both styles.
 */

export type Responder = (
  socket: FakeWebSocket,
  frame: unknown[],
  reply: (frame: unknown[]) => void,
) => void;

export class FakeWebSocket extends EventTarget {
  static readonly CONNECTING: number = 0;
  static readonly OPEN: number = 1;
  static readonly CLOSING: number = 2;
  static readonly CLOSED: number = 3;

  /** What the next socket does: answer, fail to connect, or throw on construction. */
  static mode: 'open' | 'error' | 'throw' = 'open';
  static respond: Responder = (): void => {};
  static opened: FakeWebSocket[] = [];

  readonly url: string;
  readyState: number = FakeWebSocket.CONNECTING;
  sent: unknown[][] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;

  constructor(url: string) {
    super();
    if (FakeWebSocket.mode === 'throw') {
      throw new SyntaxError(`bad url ${url}`);
    }
    this.url = url;
    FakeWebSocket.opened.push(this);
    setTimeout((): void => {
      if (FakeWebSocket.mode === 'error') {
        this.fire('error', new Event('error'));
        this.readyState = FakeWebSocket.CLOSED;
        this.fire('close', new Event('close'));
        return;
      }
      this.readyState = FakeWebSocket.OPEN;
      this.fire('open', new Event('open'));
    }, 0);
  }

  send(data: string): void {
    const frame: unknown[] = JSON.parse(data) as unknown[];
    this.sent.push(frame);
    FakeWebSocket.respond(this, frame, (answer: unknown[]): void => {
      setTimeout((): void => this.receive(JSON.stringify(answer)), 0);
    });
  }

  /** Delivers a raw string as if the server had sent it. */
  receive(data: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) return;
    this.fire('message', new MessageEvent('message', { data }));
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.fire('close', new Event('close'));
  }

  private fire(
    type: 'open' | 'message' | 'error' | 'close',
    event: Event,
  ): void {
    const handler = this[`on${type}`] as ((event: Event) => void) | null;
    handler?.call(this, event);
    this.dispatchEvent(event);
  }
}

export function installFakeWebSocket(): void {
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
  FakeWebSocket.mode = 'open';
  FakeWebSocket.respond = (): void => {};
  FakeWebSocket.opened = [];
}
