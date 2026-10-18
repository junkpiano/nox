/**
 * `localStorage` and `sessionStorage` as the browser shapes them, in memory.
 *
 * `failing` makes every call throw, the way a private window or a full quota
 * does in a real browser.
 */

export class FakeStorage {
  readonly items: Map<string, string> = new Map();
  failing: boolean = false;

  getItem(key: string): string | null {
    if (this.failing) throw new Error('storage disabled');
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failing) throw new Error('storage disabled');
    this.items.set(key, value);
  }

  removeItem(key: string): void {
    if (this.failing) throw new Error('storage disabled');
    this.items.delete(key);
  }
}

export function installFakeStorage(): {
  local: FakeStorage;
  session: FakeStorage;
} {
  const local: FakeStorage = new FakeStorage();
  const session: FakeStorage = new FakeStorage();
  const scope = globalThis as {
    localStorage?: unknown;
    sessionStorage?: unknown;
  };
  scope.localStorage = local;
  scope.sessionStorage = session;
  return { local, session };
}
