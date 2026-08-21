import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertScoreContract, unwrapScoreResult } from '../src/scoring/contract.mjs';

const p = (id) => ({ id, title: 't', company: 'c' });
const s = (id) => ({ id, title: 't', company: 'c', score: 5, rationale: 'r', verdict: 'keep' });

test('a bare array is passed through with no usage', () => {
  const arr = [s('a')];
  assert.deepEqual(unwrapScoreResult(arr), { scored: arr, usage: null });
});

test('a {scored, usage} result is unwrapped', () => {
  const arr = [s('a')];
  const usage = { requests: 1, cacheReadTokens: 700, cacheCreationTokens: 0 };
  assert.deepEqual(unwrapScoreResult({ scored: arr, usage }), { scored: arr, usage });
});

test('a {scored} result with no usage reports null usage', () => {
  assert.deepEqual(unwrapScoreResult({ scored: [] }), { scored: [], usage: null });
});

test('anything else is passed through, so the contract check produces the error', () => {
  // Not this function's job to explain a malformed return — that message
  // belongs to assertScoreContract, which names the actual problem.
  assert.deepEqual(unwrapScoreResult(undefined), { scored: undefined, usage: null });
  assert.throws(
    () => assertScoreContract([p('a')], unwrapScoreResult({ nonsense: true }).scored),
    /did not return an array/
  );
});

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

test('an unscored result passes: null is what "could not be scored" looks like', () => {
  assert.doesNotThrow(() => assertScoreContract([p('a')], [{ ...s('a'), score: null }]));
});

test('a verdict other than keep throws rather than disappearing a posting', () => {
  // renderDigest filters verdict 'omit' out of the digest and the CLI records
  // it in seen.json, so a provider that returned one would make the posting
  // vanish for ever with nothing reported anywhere.
  assert.throws(
    () => assertScoreContract([p('a')], [{ ...s('a'), verdict: 'omit' }]),
    /returned verdict 'omit' for posting id 'a'/
  );
});

test('a missing verdict throws too', () => {
  const { verdict, ...noVerdict } = s('a');
  assert.throws(() => assertScoreContract([p('a')], [noVerdict]), /returned verdict/);
});

for (const [label, score] of [
  ['undefined', undefined],
  ['out of range high', 11],
  ['out of range low', 0],
  ['fractional', 4.5],
  ['a string', '7'],
  ['NaN', Number.NaN],
]) {
  test(`a score that is ${label} throws`, () => {
    assert.throws(
      () => assertScoreContract([p('a')], [{ ...s('a'), score }]),
      /invalid score .* for posting id 'a'/
    );
  });
}

test('a duplicated posting throws rather than passing on count alone', () => {
  // Same length as the input, so a naive length check would let this through
  // while posting 'b' was silently lost.
  assert.throws(() => assertScoreContract([p('a'), p('b')], [s('a'), s('a')]), /unknown posting id 'a'|dropped/);
});
