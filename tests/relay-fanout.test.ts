import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fanOut, type RelayReport } from '../src/common/relay-fanout.js';

/** A relay whose behaviour the test scripts by hand. */
interface ScriptedRelay {
  report: RelayReport;
  stopped: number;
}

function scripted(): {
  relays: Map<string, ScriptedRelay>;
  open: (relayUrl: string, report: RelayReport) => Promise<() => void>;
} {
  const relays: Map<string, ScriptedRelay> = new Map();
  const open = (relayUrl: string, report: RelayReport): Promise<() => void> => {
    const relay: ScriptedRelay = { report, stopped: 0 };
    relays.set(relayUrl, relay);
    return Promise.resolve((): void => {
      relay.stopped += 1;
    });
  };
  return { relays, open };
}

function tick(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isResolved(promise: Promise<unknown>): Promise<boolean> {
  let resolved: boolean = false;
  void promise.then((): void => {
    resolved = true;
  });
  await tick(0);
  return resolved;
}

// --- one relay answering starts the clock for the rest ----------------------

test('fanOut: after one relay answers, the others get the grace period, not forever', async () => {
  const { relays, open } = scripted();
  const started: number = Date.now();
  const query = fanOut(['wss://a', 'wss://dead'], open, {
    stragglerGraceMs: 40,
  });
  await tick(0);
  relays.get('wss://a')?.report.answered();
  // wss://dead never says anything.
  const result = await query;
  const elapsed: number = Date.now() - started;
  assert.deepEqual(result.answered, ['wss://a']);
  assert.ok(elapsed >= 35, `returned after ${elapsed}ms`);
  assert.ok(elapsed < 500, `waited ${elapsed}ms for a relay that never spoke`);
  assert.equal(relays.get('wss://dead')?.stopped, 1);
});

test('fanOut: a slow relay that answers inside the grace is counted', async () => {
  const { relays, open } = scripted();
  const query = fanOut(['wss://a', 'wss://b'], open, {
    stragglerGraceMs: 60,
  });
  await tick(0);
  relays.get('wss://a')?.report.answered();
  await tick(10);
  relays.get('wss://b')?.report.answered();
  const result = await query;
  assert.deepEqual(result.answered, ['wss://a', 'wss://b']);
});

test('fanOut: a relay that fails does not start the clock', async () => {
  // Failure says nothing about how long a real answer takes; the relay that
  // can answer must still get its full time.
  const { relays, open } = scripted();
  const query = fanOut(['wss://broken', 'wss://slow'], open, {
    stragglerGraceMs: 10,
  });
  await tick(0);
  relays.get('wss://broken')?.report.gaveUp();
  await tick(50);
  assert.equal(
    await isResolved(query),
    false,
    'returned before the working relay answered',
  );
  relays.get('wss://slow')?.report.answered();
  const result = await query;
  assert.deepEqual(result.answered, ['wss://slow']);
});

// --- without a grace, every relay gets its say --------------------------------

test('fanOut: with no grace the query waits for every relay', async () => {
  const { relays, open } = scripted();
  const query = fanOut(['wss://a', 'wss://b'], open);
  await tick(0);
  relays.get('wss://a')?.report.answered();
  await tick(30);
  assert.equal(await isResolved(query), false);
  relays.get('wss://b')?.report.gaveUp();
  const result = await query;
  assert.deepEqual(result.answered, ['wss://a']);
});

// --- each relay counts once ---------------------------------------------------

test('fanOut: EOSE followed by CLOSED from one relay is one relay finishing', async () => {
  const { relays, open } = scripted();
  const query = fanOut(['wss://a', 'wss://b'], open);
  await tick(0);
  const a: RelayReport | undefined = relays.get('wss://a')?.report;
  a?.answered();
  a?.gaveUp();
  a?.answered();
  await tick(10);
  assert.equal(
    await isResolved(query),
    false,
    'one relay reporting three times ended the query',
  );
  relays.get('wss://b')?.report.answered();
  const result = await query;
  assert.deepEqual(result.answered, ['wss://a', 'wss://b']);
});

test('fanOut: a relay listed twice is waited for once', async () => {
  const { relays, open } = scripted();
  const query = fanOut(['wss://a', 'wss://a'], open);
  await tick(0);
  relays.get('wss://a')?.report.answered();
  const result = await query;
  assert.deepEqual(result.answered, ['wss://a']);
});

// --- nothing is left open -----------------------------------------------------

test('fanOut: a relay is stopped as soon as it has reported', async () => {
  const { relays, open } = scripted();
  const query = fanOut(['wss://a', 'wss://b'], open);
  await tick(0);
  relays.get('wss://a')?.report.answered();
  await tick(0);
  assert.equal(relays.get('wss://a')?.stopped, 1);
  assert.equal(relays.get('wss://b')?.stopped, 0);
  relays.get('wss://b')?.report.gaveUp();
  await query;
  assert.equal(relays.get('wss://a')?.stopped, 1, 'stopped twice');
  assert.equal(relays.get('wss://b')?.stopped, 1);
});

test('fanOut: a relay that connects after the query returned is stopped on the spot', async () => {
  let lateStopped: number = 0;
  const late: { connect: (() => void) | null } = { connect: null };
  const open = (relayUrl: string, report: RelayReport): Promise<() => void> => {
    if (relayUrl === 'wss://late') {
      return new Promise((resolve) => {
        late.connect = (): void =>
          resolve((): void => {
            lateStopped += 1;
          });
      });
    }
    report.answered();
    return Promise.resolve((): void => {});
  };
  const query = fanOut(['wss://quick', 'wss://late'], open, {
    stragglerGraceMs: 10,
  });
  await query;
  assert.equal(lateStopped, 0);
  assert.notEqual(late.connect, null);
  late.connect?.();
  await tick(0);
  assert.equal(lateStopped, 1, 'late subscription left open');
});

test('fanOut: a relay whose open rejects or throws counts as giving up', async () => {
  const open = (relayUrl: string): Promise<() => void> => {
    if (relayUrl === 'wss://throws') throw new Error('no');
    return Promise.reject(new Error('refused'));
  };
  const result = await fanOut(['wss://throws', 'wss://rejects'], open);
  assert.deepEqual(result.answered, []);
});

test('fanOut: no relays resolves at once', async () => {
  const result = await fanOut([], async () => (): void => {});
  assert.deepEqual(result.answered, []);
});
