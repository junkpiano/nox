/**
 * IndexedDB's shape, answered out of SQLite.
 *
 * React Native has no IndexedDB. The stores above this file - events,
 * profiles, timelines, metadata - do not treat it as a key/value box either:
 * they open cursors with a direction, walk compound indexes and bound them by
 * key range. Rewriting them for the phone would mean two implementations of
 * the cache, and the one that drifts is always the one nobody is looking at.
 *
 * So the stores are left alone and this answers the calls they already make.
 * The web keeps real IndexedDB; only the native bundle resolves to this.
 *
 * **Cursors are materialised.** A real IDB cursor streams; this runs the query,
 * holds the rows and walks the array. That is a deliberate trade: the streaming
 * protocol is the fiddly part to emulate, the stores only ever iterate and
 * collect, and the events table is capped at ten thousand rows. Anything that
 * has to stream more than that wants a different design, not a cleverer shim.
 */

/** The slice of a SQLite driver this needs. expo-sqlite and node:sqlite both fit. */
export interface SqliteLike {
  exec(sql: string): void;
  run(sql: string, params: unknown[]): void;
  all<T>(sql: string, params: unknown[]): T[];
}

/** A column kept beside the JSON so an index can sort and filter on it. */
interface IndexedColumn {
  name: string;
  /** SQLite type; the values come out of the record being written. */
  type: 'TEXT' | 'INTEGER';
}

interface StoreSchema {
  /** The IndexedDB keyPath: which field holds the primary key. */
  keyPath: string;
  columns: IndexedColumn[];
  /** IndexedDB index name -> the record fields it orders by. */
  indexes: Record<string, string[]>;
}

/**
 * Mirrors the schema in `indexeddb.ts`. It is duplicated rather than derived
 * because the original expresses itself in `createObjectStore` calls that only
 * a real IndexedDB can run; if a store or index is added there, it has to be
 * added here, and the tests are what will say so.
 */
const SCHEMA: Record<string, StoreSchema> = {
  events: {
    keyPath: 'id',
    columns: [
      { name: 'pubkey', type: 'TEXT' },
      { name: 'kind', type: 'INTEGER' },
      { name: 'created_at', type: 'INTEGER' },
      { name: 'storedAt', type: 'INTEGER' },
      { name: 'isHomeTimeline', type: 'INTEGER' },
    ],
    indexes: {
      pubkey: ['pubkey'],
      kind: ['kind'],
      created_at: ['created_at'],
      storedAt: ['storedAt'],
      pubkey_created_at: ['pubkey', 'created_at'],
      isHomeTimeline: ['isHomeTimeline'],
    },
  },
  profiles: {
    keyPath: 'pubkey',
    columns: [
      { name: 'storedAt', type: 'INTEGER' },
      { name: 'accessedAt', type: 'INTEGER' },
    ],
    indexes: { storedAt: ['storedAt'], accessedAt: ['accessedAt'] },
  },
  timelines: {
    keyPath: 'key',
    columns: [
      { name: 'type', type: 'TEXT' },
      { name: 'updatedAt', type: 'INTEGER' },
    ],
    indexes: { type: ['type'], updatedAt: ['updatedAt'] },
  },
  metadata: {
    keyPath: 'key',
    columns: [],
    indexes: {},
  },
};

/** SQLite has no identifier quoting we can rely on, so names are checked. */
function safeName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`[sqlite-idb] unsafe identifier: ${name}`);
  }
  return name;
}

let backend: SqliteLike | null = null;
let opened: boolean = false;

export function setSqliteBackend(next: SqliteLike | null): void {
  backend = next;
  opened = false;
}

export function isIndexedDBAvailable(): boolean {
  return backend !== null;
}

function db(): SqliteLike {
  if (!backend) {
    throw new Error('[sqlite-idb] no SQLite backend installed');
  }
  return backend;
}

// --- key ranges ----------------------------------------------------------

export type IdbKey = string | number | Array<string | number>;

export interface IdbRange {
  lower: IdbKey;
  upper: IdbKey;
}

/**
 * Only `bound` is provided, because only `bound` is used.
 *
 * IndexedDB's bounds are inclusive unless told otherwise, and the call sites
 * rely on that for `since` and `until`. `lowerOpen`/`upperOpen` are absent
 * rather than ignored: a silently discarded argument is worse than a missing
 * feature, and the tests would not catch what was never asked for.
 */
export const IdbKeyRange = {
  bound(lower: IdbKey, upper: IdbKey): IdbRange {
    return { lower, upper };
  },
};

/**
 * Turns a key range into SQL over the index's columns.
 *
 * A compound key compares lexicographically in IndexedDB - `[a, 5]` is below
 * `[b, 1]` because the first element decides - which is not the same as each
 * column being between its own pair of bounds. The only call site uses the
 * same author at both ends, where the two agree, but the general form is
 * written out so that a future caller with different first keys gets the
 * right answer rather than a plausible one.
 */
function rangeSql(
  columns: string[],
  range: IdbRange | undefined,
): { where: string; params: unknown[] } {
  if (!range) {
    return { where: '', params: [] };
  }

  const lower: Array<string | number> = Array.isArray(range.lower)
    ? range.lower
    : [range.lower];
  const upper: Array<string | number> = Array.isArray(range.upper)
    ? range.upper
    : [range.upper];

  const clauses: string[] = [];
  const params: unknown[] = [];

  // (c0 > l0) OR (c0 = l0 AND (c1 > l1 OR (c1 = l1 AND ...)))
  const sideSql = (
    bounds: Array<string | number>,
    strict: '>' | '<',
    index: number,
  ): string => {
    const column = safeName(columns[index] as string);
    if (index === bounds.length - 1 || index === columns.length - 1) {
      params.push(bounds[index]);
      return `${column} ${strict}= ?`;
    }
    params.push(bounds[index]);
    const head = `${column} ${strict} ?`;
    params.push(bounds[index]);
    const tail = `${column} = ? AND (${sideSql(bounds, strict, index + 1)})`;
    return `(${head} OR (${tail}))`;
  };

  clauses.push(sideSql(lower, '>', 0));
  clauses.push(sideSql(upper, '<', 0));

  return { where: `WHERE ${clauses.join(' AND ')}`, params };
}

// --- requests ------------------------------------------------------------

/**
 * A request whose value is already known.
 *
 * SQLite answers synchronously, but IndexedDB callers attach `onsuccess`
 * *after* making the call, so firing immediately would fire into nothing.
 * Assigning the handler is what schedules it, which works whichever order the
 * caller happens to use.
 */
class ReadyRequest<T> {
  result: T;
  error: unknown = null;
  private handler: (() => void) | null = null;

  constructor(result: T) {
    this.result = result;
  }

  set onsuccess(handler: (() => void) | null) {
    this.handler = handler;
    if (handler) {
      queueMicrotask((): void => {
        this.handler?.();
      });
    }
  }

  get onsuccess(): (() => void) | null {
    return this.handler;
  }

  set onerror(_handler: (() => void) | null) {
    // Nothing here fails asynchronously; a throw happens at the call itself.
  }
}

export interface IdbCursor<T> {
  value: T;
  continue(): void;
}

/**
 * Walks rows already fetched.
 *
 * `continue()` re-fires `onsuccess` with the next row, and with a null result
 * once they run out - the signal every call site uses to resolve. A caller
 * that stops early simply never calls `continue()` again, and nothing is left
 * waiting.
 */
class CursorRequest<T> {
  result: IdbCursor<T> | null = null;
  private rows: T[];
  private position: number = 0;
  private handler: (() => void) | null = null;

  constructor(rows: T[]) {
    this.rows = rows;
  }

  private step(): void {
    if (this.position >= this.rows.length) {
      this.result = null;
    } else {
      const value: T = this.rows[this.position] as T;
      this.position += 1;
      this.result = {
        value,
        continue: (): void => {
          queueMicrotask((): void => {
            this.step();
            this.handler?.();
          });
        },
      };
    }
  }

  set onsuccess(handler: (() => void) | null) {
    this.handler = handler;
    if (handler) {
      queueMicrotask((): void => {
        this.step();
        this.handler?.();
      });
    }
  }

  get onsuccess(): (() => void) | null {
    return this.handler;
  }

  set onerror(_handler: (() => void) | null) {
    // As above.
  }
}

export function requestToPromise<T>(request: { result: T }): Promise<T> {
  return Promise.resolve(request.result);
}

export function transactionToPromise(_tx: unknown): Promise<void> {
  // Every write here has already been executed by the time the caller asks;
  // there is no deferred commit to wait for.
  return Promise.resolve();
}

// --- stores --------------------------------------------------------------

class Index {
  constructor(
    private readonly table: string,
    private readonly columns: string[],
  ) {}

  openCursor<T = unknown>(
    range?: IdbRange,
    direction?: 'next' | 'prev',
  ): CursorRequest<T> {
    const order: string = this.columns
      .map(
        (column: string): string =>
          `${safeName(column)} ${direction === 'prev' ? 'DESC' : 'ASC'}`,
      )
      .join(', ');
    const { where, params } = rangeSql(this.columns, range);
    const rows = db().all<{ value: string }>(
      `SELECT value FROM ${safeName(this.table)} ${where} ORDER BY ${order}`,
      params,
    );
    return new CursorRequest<T>(
      rows.map((row: { value: string }): T => JSON.parse(row.value) as T),
    );
  }
}

class ObjectStore {
  constructor(
    private readonly name: string,
    private readonly schema: StoreSchema,
  ) {}

  put(value: object): ReadyRequest<void> {
    const record = value as Record<string, unknown>;
    const key: unknown = record[this.schema.keyPath];
    const columns: string[] = [this.schema.keyPath, 'value'];
    const params: unknown[] = [key, JSON.stringify(record)];
    for (const column of this.schema.columns) {
      columns.push(column.name);
      const raw: unknown = record[column.name];
      // Booleans have no SQLite type; isHomeTimeline is stored as 0 or 1 so it
      // can still be indexed and compared.
      params.push(typeof raw === 'boolean' ? (raw ? 1 : 0) : (raw ?? null));
    }
    const placeholders: string = columns.map((): string => '?').join(', ');
    db().run(
      `INSERT OR REPLACE INTO ${safeName(this.name)} (${columns
        .map(safeName)
        .join(', ')}) VALUES (${placeholders})`,
      params,
    );
    return new ReadyRequest<void>(undefined);
  }

  get<T = unknown>(key: unknown): ReadyRequest<T | undefined> {
    const rows = db().all<{ value: string }>(
      `SELECT value FROM ${safeName(this.name)} WHERE ${safeName(
        this.schema.keyPath,
      )} = ? LIMIT 1`,
      [key],
    );
    const first = rows[0];
    // Absent reads as undefined, which is what IndexedDB gives and what every
    // caller checks for.
    return new ReadyRequest<T | undefined>(
      first ? (JSON.parse(first.value) as T) : undefined,
    );
  }

  delete(key: unknown): ReadyRequest<void> {
    db().run(
      `DELETE FROM ${safeName(this.name)} WHERE ${safeName(
        this.schema.keyPath,
      )} = ?`,
      [key],
    );
    return new ReadyRequest<void>(undefined);
  }

  clear(): ReadyRequest<void> {
    db().run(`DELETE FROM ${safeName(this.name)}`, []);
    return new ReadyRequest<void>(undefined);
  }

  count(): ReadyRequest<number> {
    const rows = db().all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${safeName(this.name)}`,
      [],
    );
    return new ReadyRequest<number>(rows[0]?.n ?? 0);
  }

  openCursor<T = unknown>(
    range?: IdbRange,
    direction?: 'next' | 'prev',
  ): CursorRequest<T> {
    return new Index(this.name, [this.schema.keyPath]).openCursor<T>(
      range,
      direction,
    );
  }

  index(name: string): Index {
    const columns: string[] | undefined = this.schema.indexes[name];
    if (!columns) {
      throw new Error(`[sqlite-idb] no index "${name}" on ${this.name}`);
    }
    return new Index(this.name, columns);
  }
}

export interface IdbTransaction {
  objectStore(name: string): ObjectStore;
}

// --- lifecycle -----------------------------------------------------------

function createTables(): void {
  for (const [name, schema] of Object.entries(SCHEMA)) {
    const columns: string[] = [
      `${safeName(schema.keyPath)} TEXT PRIMARY KEY`,
      'value TEXT NOT NULL',
      ...schema.columns.map(
        (column: IndexedColumn): string =>
          `${safeName(column.name)} ${column.type}`,
      ),
    ];
    db().exec(
      `CREATE TABLE IF NOT EXISTS ${safeName(name)} (${columns.join(', ')})`,
    );

    for (const [indexName, indexColumns] of Object.entries(schema.indexes)) {
      db().exec(
        `CREATE INDEX IF NOT EXISTS idx_${safeName(name)}_${safeName(
          indexName,
        )} ON ${safeName(name)} (${indexColumns.map(safeName).join(', ')})`,
      );
    }
  }
}

export async function openDb(): Promise<{ close(): void }> {
  if (!opened) {
    createTables();
    opened = true;
  }
  return { close: (): void => undefined };
}

export function closeDb(): void {
  opened = false;
}

export async function createTransaction(
  _storeNames: string | string[],
  _mode: 'readonly' | 'readwrite',
): Promise<IdbTransaction> {
  await openDb();
  // A transaction object is not a real SQLite transaction. The stores use it
  // only to reach an object store, and every write here is committed as it is
  // made; wrapping them would change when failures surface without changing
  // what the callers do about them.
  return {
    objectStore(name: string): ObjectStore {
      const schema: StoreSchema | undefined = SCHEMA[name];
      if (!schema) {
        throw new Error(`[sqlite-idb] no store "${name}"`);
      }
      return new ObjectStore(name, schema);
    },
  };
}

export async function deleteDatabase(): Promise<void> {
  for (const name of Object.keys(SCHEMA)) {
    db().exec(`DROP TABLE IF EXISTS ${safeName(name)}`);
  }
  opened = false;
}
