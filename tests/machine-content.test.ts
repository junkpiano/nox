/**
 * Which posts are data rather than words.
 *
 * The risk runs both ways. Too loose and the client eats real posts it does
 * not understand; too tight and the heartbeat bots stay on the timeline. The
 * cases below are mostly the "must not hide" side, because that is the
 * failure nobody notices - a post that is simply gone.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isMachineContent,
  withoutMachineContent,
} from '../src/common/machine-content.js';

test('machine: a JSON object is machine content', () => {
  assert.equal(
    isMachineContent(
      '{"type":"PresenceHeartbeat","senderKey":"e0752ba1","timestamp":1788306262777}',
    ),
    true,
  );
});

test('machine: a JSON array is machine content', () => {
  assert.equal(isMachineContent('[{"a":1},{"b":2}]'), true);
});

test('machine: surrounding whitespace does not change the answer', () => {
  assert.equal(isMachineContent('  \n{"a":1}\n  '), true);
});

test('machine: prose that mentions JSON is prose', () => {
  // Somebody writing about JSON puts words around it.
  assert.equal(
    isMachineContent('the payload was {"a":1} and it worked'),
    false,
  );
  assert.equal(isMachineContent('here: {"a":1}'), false);
});

test('machine: braces that are not JSON are prose', () => {
  assert.equal(isMachineContent('{not json}'), false);
  assert.equal(isMachineContent('[bracketed aside]'), false);
  assert.equal(isMachineContent('{"unterminated": '), false);
});

test('machine: a JSON scalar is not treated as machine content', () => {
  // "42" and "\"hi\"" parse, but they are not a structured payload and a
  // person can plausibly post them.
  assert.equal(isMachineContent('42'), false);
  assert.equal(isMachineContent('"hi"'), false);
  assert.equal(isMachineContent('null'), false);
});

test('machine: a bot roster line is not JSON and is left alone', () => {
  // Ugly, but not structured data. Hiding prose by heuristic is how a client
  // starts eating posts it does not understand.
  assert.equal(
    isMachineContent('channel:__roster 0dda7a929aa731609faca531de38beba'),
    false,
  );
});

test('machine: empty and near-empty content is not machine content', () => {
  assert.equal(isMachineContent(''), false);
  assert.equal(isMachineContent('{'), false);
  assert.equal(isMachineContent('{}'), true);
});

test('machine: filtering keeps order and the rest', () => {
  const events = [
    { id: 'a', content: 'hello' },
    { id: 'b', content: '{"type":"heartbeat"}' },
    { id: 'c', content: 'world' },
  ];
  assert.deepEqual(
    withoutMachineContent(events).map((e) => e.id),
    ['a', 'c'],
  );
});
