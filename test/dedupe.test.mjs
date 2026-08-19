import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSeen, saveSeen, isSeen, recordSeen, pruneSeen } from '../src/dedupe.mjs';

test('loadSeen returns an empty object when the file does not exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jc-'));
  assert.deepEqual(loadSeen(join(dir, 'nope.json')), {});
});

test('loadSeen throws a clear error on malformed JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jc-'));
  const p = join(dir, 'seen.json');
  writeFileSync(p, '{not json', 'utf8');
  assert.throws(() => loadSeen(p), /Failed to parse/);
});

test('saveSeen then loadSeen round-trips', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jc-'));
  const p = join(dir, 'seen.json');
  saveSeen(p, { 'a:1': '2026-08-19' });
  assert.deepEqual(loadSeen(p), { 'a:1': '2026-08-19' });
});

test('isSeen distinguishes present from absent ids', () => {
  const seen = { 'a:1': '2026-08-19' };
  assert.equal(isSeen(seen, 'a:1'), true);
  assert.equal(isSeen(seen, 'a:2'), false);
});

test('isSeen is not fooled by inherited object properties', () => {
  assert.equal(isSeen({}, 'constructor'), false);
});

test('recordSeen returns a new object and leaves the original untouched', () => {
  const before = { 'a:1': '2026-08-01' };
  const after = recordSeen(before, 'a:2', '2026-08-19');
  assert.deepEqual(before, { 'a:1': '2026-08-01' });
  assert.deepEqual(after, { 'a:1': '2026-08-01', 'a:2': '2026-08-19' });
});

test('pruneSeen drops entries older than the retention window', () => {
  const seen = { old: '2026-07-01', fresh: '2026-08-18' };
  assert.deepEqual(pruneSeen(seen, '2026-08-19', 30), { fresh: '2026-08-18' });
});

test('pruneSeen keeps an entry exactly on the cutoff', () => {
  const seen = { edge: '2026-07-20' };
  assert.deepEqual(pruneSeen(seen, '2026-08-19', 30), { edge: '2026-07-20' });
});

test('pruneSeen drops entries with unparseable dates', () => {
  assert.deepEqual(pruneSeen({ bad: 'not-a-date' }, '2026-08-19', 30), {});
});

test('loadSeen rejects a file containing null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jc-'));
  const p = join(dir, 'seen.json');
  writeFileSync(p, 'null', 'utf8');
  assert.throws(() => loadSeen(p), /Invalid dedup state.*got a null/s);
});

test('loadSeen rejects a file containing an array or a scalar', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jc-'));
  for (const [name, body, expected] of [
    ['array.json', '["a:1"]', /got an array/],
    ['string.json', '"a:1"', /got a string/],
    ['number.json', '7', /got a number/],
  ]) {
    const p = join(dir, name);
    writeFileSync(p, body, 'utf8');
    assert.throws(() => loadSeen(p), expected);
  }
});

test('saveSeen replaces existing state and leaves no temp file behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jc-'));
  const p = join(dir, 'seen.json');
  saveSeen(p, { 'a:1': '2026-08-18' });
  saveSeen(p, { 'a:2': '2026-08-19' });
  assert.deepEqual(loadSeen(p), { 'a:2': '2026-08-19' });
  assert.deepEqual(readdirSync(dir), ['seen.json']);
});

test('saveSeen swaps the target in rather than rewriting it in place', () => {
  // The atomicity is the point: a plain writeFileSync truncates the target
  // first, so an interrupted scheduled run leaves a fragment and the next run
  // re-reports every posting as new. A rename over the target replaces the
  // file, so its identity changes between saves — that identity change is the
  // observable evidence the write was not done in place.
  const dir = mkdtempSync(join(tmpdir(), 'jc-'));
  const p = join(dir, 'seen.json');
  saveSeen(p, { 'a:1': '2026-08-18' });
  const first = statSync(p);
  saveSeen(p, { 'a:1': '2026-08-18', 'a:2': '2026-08-19' });
  const second = statSync(p);
  if (first.ino !== 0 && second.ino !== 0) {
    assert.notEqual(second.ino, first.ino, 'the target should have been replaced, not truncated and rewritten');
  }
  assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { 'a:1': '2026-08-18', 'a:2': '2026-08-19' });
});
