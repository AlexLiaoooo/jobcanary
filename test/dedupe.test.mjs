import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
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
