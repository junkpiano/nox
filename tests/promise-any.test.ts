/**
 * The stand-in for Promise.any on engines without it: first success wins,
 * and only when every promise fails does it reject, with all the reasons.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

type AnyFn = <T>(values: Iterable<PromiseLike<T> | T>) => Promise<T>;

// Removed before the module is loaded, so it picks its own implementation.
const original: unknown = (Promise as unknown as { any?: unknown }).any;
delete (Promise as unknown as { any?: unknown }).any;
const utils = await import('../src/common/promise-utils.js');
(Promise as unknown as { any?: unknown }).any = original;
const promiseAny: AnyFn = utils.promiseAny;

test('the first promise to succeed wins, even after others failed', async () => {
  const value: number = await promiseAny<number>([
    Promise.reject(new Error('no')),
    new Promise<number>((resolve) => setTimeout(() => resolve(2), 5)),
    new Promise<number>((resolve) => setTimeout(() => resolve(3), 20)),
  ]);
  assert.equal(value, 2);
});

test('plain values count as successes', async () => {
  assert.equal(await promiseAny<number>([7]), 7);
});

test('when every promise fails it rejects with every reason', async () => {
  await assert.rejects(
    promiseAny<number>([Promise.reject('a'), Promise.reject('b')]),
    (errors: unknown): boolean => {
      assert.deepEqual([...(errors as unknown[])].sort(), ['a', 'b']);
      return true;
    },
  );
});

test('nothing to wait for rejects at once with no reasons', async () => {
  await assert.rejects(promiseAny<number>([]), (errors: unknown): boolean => {
    assert.deepEqual(errors, []);
    return true;
  });
});

test('a relay miss is an error with its own name', () => {
  const error: Error = new utils.RelayMissError();
  assert.equal(error.name, 'RelayMissError');
  assert.ok(error instanceof Error);
});
