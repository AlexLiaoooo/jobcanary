import { test } from 'node:test';
import assert from 'node:assert/strict';
import none from '../src/scoring/none.mjs';
import { getProvider } from '../src/scoring/index.mjs';

const posting = (over = {}) => ({
  id: 'a:1', title: 'Graduate Design Engineer', company: 'Acme Dynamics',
  location: 'Oxford', url: 'https://example.test/1', postedAt: '2026-08-18',
  description: 'CFD and CAD work.', source: 'a', notes: [], ...over,
});

test('registry resolves the none provider', () => {
  assert.equal(getProvider('none').id, 'none');
});

test('registry throws for an unknown provider', () => {
  assert.throws(() => getProvider('wishful'), /unknown scoring provider 'wishful'/);
});

test('with no keywords every posting scores 1', async () => {
  const out = await none.score([posting()], { keywords: [] });
  assert.equal(out[0].score, 1);
  assert.equal(out[0].verdict, 'keep');
});

test('each distinct keyword match adds 2', async () => {
  const out = await none.score([posting()], { keywords: ['cfd', 'graduate'] });
  assert.equal(out[0].score, 5);
});

test('the score is capped at 10', async () => {
  const out = await none.score(
    [posting({ description: 'cfd cad gt-suite matlab python motorsport' })],
    { keywords: ['cfd', 'cad', 'gt-suite', 'matlab', 'python', 'motorsport'] }
  );
  assert.equal(out[0].score, 10);
});

test('a repeated keyword counts once', async () => {
  const out = await none.score([posting({ description: 'CFD CFD CFD' })], { keywords: ['cfd'] });
  assert.equal(out[0].score, 3);
});

test('keyword matching is case-insensitive and searches all text fields', async () => {
  const out = await none.score([posting({ title: 'CFD Engineer' })], { keywords: ['cfd'] });
  assert.equal(out[0].score, 3);
});

test('the rationale names the matched keywords', async () => {
  const out = await none.score([posting()], { keywords: ['cfd', 'nothing'] });
  assert.match(out[0].rationale, /cfd/);
  assert.doesNotMatch(out[0].rationale, /nothing/);
});

test('the rationale is explicit when nothing matched', async () => {
  const out = await none.score([posting()], { keywords: ['nothing'] });
  assert.match(out[0].rationale, /No configured keywords matched/);
});

test('the provider never omits a posting', async () => {
  const out = await none.score([posting(), posting({ id: 'a:2' })], { keywords: [] });
  assert.deepEqual(out.map((p) => p.verdict), ['keep', 'keep']);
});

test('input postings are not mutated', async () => {
  const p = posting();
  await none.score([p], { keywords: ['cfd'] });
  assert.equal(p.score, undefined);
});
