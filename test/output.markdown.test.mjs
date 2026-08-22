import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDigest } from '../src/output/markdown.mjs';

const scored = (over = {}) => ({
  id: 'a:1', title: 'Graduate Design Engineer', company: 'Acme Dynamics',
  location: 'Oxford, UK', url: 'https://example.test/1', postedAt: '2026-08-18',
  description: 'CFD work.', source: 'acme', notes: [],
  score: 7, rationale: 'Matched CFD.', verdict: 'keep', ...over,
});

const meta = { date: '2026-08-19', scanned: 42, siteErrors: [] };

test('the digest opens with a dated heading and run line', () => {
  const md = renderDigest([scored()], meta);
  assert.match(md, /^# Job Picks — 2026-08-19\n/);
  assert.match(md, /\*\*Scanned:\*\* 42/);
  assert.match(md, /\*\*New:\*\* 1/);
});

test('each posting renders score, title and company in its heading', () => {
  const md = renderDigest([scored()], meta);
  assert.match(md, /### \[7\/10\] Graduate Design Engineer · Acme Dynamics/);
});

test('postings sort by score descending', () => {
  const md = renderDigest([scored({ id: 'a:1', score: 4 }), scored({ id: 'a:2', score: 9 })], meta);
  assert.ok(md.indexOf('[9/10]') < md.indexOf('[4/10]'));
});

test('ties sort newest first', () => {
  const md = renderDigest([
    scored({ id: 'a:1', company: 'Acme Dynamics', postedAt: '2026-08-10' }),
    scored({ id: 'a:2', company: 'Zenith Motors', postedAt: '2026-08-18' }),
  ], meta);
  assert.ok(
    md.indexOf('Zenith Motors') < md.indexOf('Acme Dynamics'),
    'the fresher posting of two equally-scored ones is the one worth acting on'
  );
});

test('a tie on score and date falls back to company', () => {
  const md = renderDigest(
    [scored({ id: 'a:1', company: 'Zenith Motors' }), scored({ id: 'a:2', company: 'Acme Dynamics' })],
    meta
  );
  assert.ok(md.indexOf('Acme Dynamics') < md.indexOf('Zenith Motors'));
});

test('a posting with no date sorts after an equally-scored one that has a date', () => {
  const md = renderDigest([
    scored({ id: 'a:1', company: 'Acme Dynamics', postedAt: null }),
    scored({ id: 'a:2', company: 'Zenith Motors', postedAt: '2026-08-01' }),
  ], meta);
  assert.ok(md.indexOf('Zenith Motors') < md.indexOf('Acme Dynamics'));
});

test('two undated postings still tie-break by company', () => {
  const md = renderDigest([
    scored({ id: 'a:1', company: 'Zenith Motors', postedAt: null }),
    scored({ id: 'a:2', company: 'Acme Dynamics', postedAt: null }),
  ], meta);
  assert.ok(md.indexOf('Acme Dynamics') < md.indexOf('Zenith Motors'));
});

test('the comparator and the heading agree about what counts as unscored', () => {
  // They disagreed: `?? -1` in the comparator tolerated undefined, `=== null`
  // in the heading did not, so an undefined score sorted last and then
  // rendered as [undefined/10].
  const md = renderDigest([
    scored({ id: 'a:1', score: undefined, company: 'Acme Dynamics' }),
    scored({ id: 'a:2', score: 2, company: 'Zenith Motors' }),
  ], meta);
  assert.doesNotMatch(md, /undefined/);
  assert.match(md, /### \[—\] Graduate Design Engineer · Acme Dynamics/);
  assert.ok(md.indexOf('[2/10]') < md.indexOf('[—]'));
});

test('notes render as their own bullet when present', () => {
  const md = renderDigest([scored({ notes: ['Check eligibility'] })], meta);
  assert.match(md, /\*\*Notes:\*\* Check eligibility/);
});

test('the notes bullet is omitted entirely when there are none', () => {
  assert.doesNotMatch(renderDigest([scored()], meta), /\*\*Notes:\*\*/);
});

test('omitted postings are excluded from the digest', () => {
  const md = renderDigest([scored({ id: 'a:1', verdict: 'omit' }), scored({ id: 'a:2' })], meta);
  assert.equal((md.match(/### /g) ?? []).length, 1);
});

test('an empty result set produces an explicit no-results body', () => {
  const md = renderDigest([], meta);
  assert.match(md, /No new postings today\. Scanned 42\./);
  assert.doesNotMatch(md, /### /);
});

test('site errors are listed in a footer', () => {
  const md = renderDigest([scored()], { ...meta, siteErrors: [{ site: 'zenith', error: 'HTTP 503' }] });
  assert.match(md, /## Site errors/);
  assert.match(md, /zenith — HTTP 503/);
});

test('no site-error footer appears when every site succeeded', () => {
  assert.doesNotMatch(renderDigest([scored()], meta), /## Site errors/);
});

test('an unscored posting renders an em dash instead of a number', () => {
  const md = renderDigest([scored({ score: null, rationale: 'not scored: refused' })], meta);
  assert.match(md, /### \[—\] Graduate Design Engineer · Acme Dynamics/);
  assert.doesNotMatch(md, /null/);
});

test('unscored postings sort below every scored one', () => {
  const md = renderDigest([
    scored({ id: 'a:1', score: null, company: 'Acme Dynamics' }),
    scored({ id: 'a:2', score: 1, company: 'Zenith Motors' }),
  ], meta);
  assert.ok(md.indexOf('[1/10]') < md.indexOf('[—]'));
});

test('unscored postings tie-break alphabetically by company like any other', () => {
  const md = renderDigest([
    scored({ id: 'a:1', score: null, company: 'Zenith Motors' }),
    scored({ id: 'a:2', score: null, company: 'Acme Dynamics' }),
  ], meta);
  assert.ok(md.indexOf('Acme Dynamics') < md.indexOf('Zenith Motors'));
});

test('an unscored posting still counts toward New', () => {
  const md = renderDigest([scored({ score: null })], meta);
  assert.match(md, /\*\*New:\*\* 1/);
});
