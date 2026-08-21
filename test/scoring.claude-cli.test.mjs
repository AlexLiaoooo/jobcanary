import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import claudeCli from '../src/scoring/claude-cli.mjs';
import { getProvider } from '../src/scoring/index.mjs';

function profileFile() {
  const dir = mkdtempSync(join(tmpdir(), 'jc-prof-'));
  const p = join(dir, 'profile.md');
  writeFileSync(p, 'Graduate mechanical engineer.', 'utf8');
  return p;
}

const posting = (id, over = {}) => ({
  id, title: 'Graduate Design Engineer', company: 'Acme Dynamics',
  location: 'Oxford, UK', url: `https://example.test/${id}`, postedAt: null,
  description: 'CFD work.', source: 'acme', notes: [], ...over,
});

function fakeExec(handler) {
  const calls = [];
  const exec = async (prompt) => { calls.push(prompt); return handler(prompt, calls.length - 1); };
  exec.calls = calls;
  return exec;
}
const scoresFor = (ids, score = 6) =>
  JSON.stringify({ scores: ids.map((id) => ({ id, score, rationale: 'because' })) });
const opts = (exec, over = {}) => ({ exec, profile: profileFile(), rubric: null, ...over });

test('registry resolves the claude-cli provider', () => {
  assert.equal(getProvider('claude-cli').id, 'claude-cli');
});

test('scores are matched by echoed id, not by position', async () => {
  // Deliberately reversed relative to the input order.
  const exec = fakeExec(() => JSON.stringify({
    scores: [
      { id: 'a:2', score: 9, rationale: 'second posting' },
      { id: 'a:1', score: 3, rationale: 'first posting' },
    ],
  }));
  const out = await claudeCli.score([posting('a:1'), posting('a:2')], opts(exec));
  const byId = Object.fromEntries(out.map((p) => [p.id, p]));
  assert.equal(byId['a:1'].score, 3);
  assert.equal(byId['a:1'].rationale, 'first posting');
  assert.equal(byId['a:2'].score, 9);
});

test('a posting missing from the response comes back unscored, not dropped', async () => {
  const exec = fakeExec(() => scoresFor(['a:1']));
  const out = await claudeCli.score([posting('a:1'), posting('a:2')], opts(exec));
  assert.equal(out.length, 2);
  assert.equal(out.find((p) => p.id === 'a:2').score, null);
  assert.match(out.find((p) => p.id === 'a:2').rationale, /not scored/);
});

test('an unknown id in the response is ignored rather than added', async () => {
  const exec = fakeExec(() => JSON.stringify({
    scores: [{ id: 'a:1', score: 5, rationale: 'r' }, { id: 'ghost', score: 9, rationale: 'r' }],
  }));
  const out = await claudeCli.score([posting('a:1')], opts(exec));
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'a:1');
});

test('postings are batched ten to an invocation', async () => {
  const ids = Array.from({ length: 25 }, (_, i) => `a:${i}`);
  const exec = fakeExec((prompt) => {
    const inBatch = ids.filter((id) => prompt.includes(id));
    return scoresFor(inBatch);
  });
  const out = await claudeCli.score(ids.map((id) => posting(id)), opts(exec));
  assert.equal(exec.calls.length, 3, '25 postings should take 3 invocations of 10');
  assert.equal(out.length, 25);
});

test('unparseable output degrades that batch only', async () => {
  const exec = fakeExec((_p, i) => (i === 0 ? 'not json at all' : scoresFor(['a:10'])));
  const input = [...Array.from({ length: 10 }, (_, i) => posting(`a:${i}`)), posting('a:10')];
  const out = await claudeCli.score(input, opts(exec));
  assert.equal(out.length, 11);
  assert.equal(out.find((p) => p.id === 'a:0').score, null);
  assert.equal(out.find((p) => p.id === 'a:10').score, 6);
});

test('a thrown invocation degrades that batch only', async () => {
  const exec = fakeExec((_p, i) => { if (i === 0) throw new Error('claude not found'); return scoresFor(['a:10']); });
  const input = [...Array.from({ length: 10 }, (_, i) => posting(`a:${i}`)), posting('a:10')];
  const out = await claudeCli.score(input, opts(exec));
  assert.equal(out.length, 11);
  assert.match(out.find((p) => p.id === 'a:0').rationale, /claude not found/);
});

test('the prompt carries the rubric, the profile and each posting id', async () => {
  const exec = fakeExec(() => scoresFor(['a:1']));
  await claudeCli.score([posting('a:1')], opts(exec));
  assert.match(exec.calls[0], /Graduate mechanical engineer/);
  assert.match(exec.calls[0], /a:1/);
});

test('output wrapped in a fenced code block is still parsed', async () => {
  const exec = fakeExec(() => '```json\n' + scoresFor(['a:1'], 8) + '\n```');
  const out = await claudeCli.score([posting('a:1')], opts(exec));
  assert.equal(out[0].score, 8);
});

test('one result comes back per posting, in input order', async () => {
  const exec = fakeExec(() => scoresFor(['a:1', 'a:2', 'a:3']));
  const out = await claudeCli.score([posting('a:1'), posting('a:2'), posting('a:3')], opts(exec));
  assert.deepEqual(out.map((p) => p.id), ['a:1', 'a:2', 'a:3']);
});

test('an empty posting list makes no invocations', async () => {
  const exec = fakeExec(() => scoresFor([]));
  assert.deepEqual(await claudeCli.score([], opts(exec)), []);
  assert.equal(exec.calls.length, 0);
});
