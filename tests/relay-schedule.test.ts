/**
 * Relay traffic is worked through in slices, and a relay timer waits its turn.
 *
 * The first property is what keeps a tap from waiting behind a burst of
 * signature checks. The second is what keeps that from costing answers: a
 * timer that fires while events received before it are still queued must
 * not act until they have been delivered.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clearRelayTimeout,
  enqueueRelayWork,
  setRelayTimeout,
} from '../src/common/relay-schedule.js';

function tick(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Holds the thread, the way a signature check on a phone does. */
function busy(ms: number): void {
  const end: number = Date.now() + ms;
  while (Date.now() < end) {
    // Spinning on purpose.
  }
}

test('schedule: work runs in the order it was queued', async () => {
  const seen: number[] = [];
  for (let index = 0; index < 5; index += 1) {
    enqueueRelayWork((): void => {
      seen.push(index);
    });
  }
  await tick(10);
  assert.deepEqual(seen, [0, 1, 2, 3, 4]);
});

test('schedule: long work hands the thread back before the next piece', async () => {
  const seen: string[] = [];
  enqueueRelayWork((): void => {
    busy(20);
    seen.push('first');
  });
  enqueueRelayWork((): void => {
    seen.push('second');
  });
  // Outside the queue, and queued after both: a tap, as far as the thread
  // is concerned.
  setTimeout((): void => {
    seen.push('outside');
  }, 0);
  await tick(60);
  assert.deepEqual(seen, ['first', 'outside', 'second']);
});

test('schedule: a relay timer that fires behind waiting traffic waits for it', async () => {
  const seen: string[] = [];
  setRelayTimeout((): void => {
    seen.push('gave up');
  }, 5);
  // Traffic that arrived before the deadline and is still being worked
  // through when the deadline passes.
  enqueueRelayWork((): void => {
    busy(15);
    seen.push('event 1');
  });
  enqueueRelayWork((): void => {
    seen.push('event 2');
  });
  await tick(80);
  assert.deepEqual(seen, ['event 1', 'event 2', 'gave up']);
});

test('schedule: a cleared relay timer does not run, even once fired and waiting', async () => {
  const seen: string[] = [];
  const timer = setRelayTimeout((): void => {
    seen.push('gave up');
  }, 1);
  enqueueRelayWork((): void => {
    busy(10);
  });
  enqueueRelayWork((): void => {
    clearRelayTimeout(timer);
    seen.push('finished first');
  });
  await tick(60);
  assert.deepEqual(seen, ['finished first']);
});

test('schedule: one reader throwing does not stop delivery to the rest', async () => {
  const seen: string[] = [];
  const original = console.error;
  console.error = (): void => {};
  try {
    enqueueRelayWork((): void => {
      throw new Error('reader failed');
    });
    enqueueRelayWork((): void => {
      seen.push('still delivered');
    });
    await tick(10);
  } finally {
    console.error = original;
  }
  assert.deepEqual(seen, ['still delivered']);
});

test('schedule: a relay timer waits for answers the traffic before it settled through promises', async () => {
  // The shape of a deletion check: a relay's answer resolves a promise,
  // which reaches the result a few hops later, and an overall deadline
  // settles the same result with the opposite answer.
  let outcome: string | null = null;
  const settle = (value: string): void => {
    if (outcome === null) outcome = value;
  };
  setRelayTimeout((): void => settle('timed out'), 5);
  enqueueRelayWork((): void => {
    busy(15);
  });
  let answer: (value: string) => void = (): void => {};
  const answered: Promise<string> = (async (): Promise<string> =>
    await new Promise<string>((resolve) => {
      answer = resolve;
    }))();
  void answered.then(settle);
  // Arrived before the deadline, still queued when it passed.
  enqueueRelayWork((): void => {
    answer('found');
  });
  await tick(80);
  assert.equal(outcome, 'found');
});
