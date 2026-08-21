import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertScoreContract } from '../src/scoring/contract.mjs';

const p = (id) => ({ id, title: 't', company: 'c' });
const s = (id) => ({ id, title: 't', company: 'c', score: 5, rationale: 'r', verdict: 'keep' });

test('a matching set of results passes', () => {
  assert.doesNotThrow(() => assertScoreContract([p('a'), p('b')], [s('a'), s('b')]));
});

test('order does not matter, only the id set', () => {
  assert.doesNotThrow(() => assertScoreContract([p('a'), p('b')], [s('b'), s('a')]));
});

test('an empty input with an empty output passes', () => {
  assert.doesNotThrow(() => assertScoreContract([], []));
});

test('a non-array result throws', () => {
  assert.throws(() => assertScoreContract([p('a')], undefined), /did not return an array/);
});

test('a dropped posting throws and names it', () => {
  assert.throws(() => assertScoreContract([p('a'), p('b')], [s('a')]), /dropped posting id\(s\): b/);
});

test('an extra posting throws and names it', () => {
  assert.throws(() => assertScoreContract([p('a')], [s('a'), s('zz')]), /unknown posting id 'zz'/);
});

test('a duplicated posting throws rather than passing on count alone', () => {
  // Same length as the input, so a naive length check would let this through
  // while posting 'b' was silently lost.
  assert.throws(() => assertScoreContract([p('a'), p('b')], [s('a'), s('a')]), /unknown posting id 'a'|dropped/);
});
