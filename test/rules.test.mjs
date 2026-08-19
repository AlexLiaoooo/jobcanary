import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRules } from '../src/rules.mjs';
import { compileMatcher } from '../src/config.mjs';

const rule = (id, field, ...m) => ({ id, field, match: m.map(compileMatcher) });
const note = (id, field, text, ...m) => ({ ...rule(id, field, ...m), note: text });

const posting = (over = {}) => ({
  id: 'x:1', title: 'Graduate Design Engineer', company: 'Acme Dynamics',
  location: 'Oxford, UK', url: 'https://example.test/1', postedAt: null,
  description: 'Looking for a graduate engineer.', source: 'x', notes: [], ...over,
});

test('a posting with no rules is kept', () => {
  const r = applyRules(posting(), { exclude: [], annotate: [] });
  assert.deepEqual(r, { keep: true, excludedBy: null, notes: [] });
});

test('an exclude rule matching the title drops the posting', () => {
  const r = applyRules(posting({ title: 'Head of Aerodynamics' }), {
    exclude: [rule('senior', 'title', 'head of')], annotate: [],
  });
  assert.equal(r.keep, false);
  assert.equal(r.excludedBy, 'senior');
});

test('an exclude rule scoped to title ignores a match in the description', () => {
  const r = applyRules(posting({ description: 'reports to the head of engineering' }), {
    exclude: [rule('senior', 'title', 'head of')], annotate: [],
  });
  assert.equal(r.keep, true);
});

test("field 'all' searches every text field", () => {
  const r = applyRules(posting({ description: 'no sponsorship available' }), {
    exclude: [rule('nosp', 'all', 'no sponsorship')], annotate: [],
  });
  assert.equal(r.keep, false);
});

test('an annotate rule adds a note but keeps the posting', () => {
  const r = applyRules(posting({ description: 'no sponsorship available' }), {
    exclude: [],
    annotate: [note('rtw', 'description', 'Check eligibility', 'no sponsorship')],
  });
  assert.equal(r.keep, true);
  assert.deepEqual(r.notes, ['Check eligibility']);
});

test('an excluded posting is not annotated', () => {
  const r = applyRules(posting({ title: 'Head of Aero', description: 'no sponsorship' }), {
    exclude: [rule('senior', 'title', 'head of')],
    annotate: [note('rtw', 'description', 'Check eligibility', 'no sponsorship')],
  });
  assert.equal(r.keep, false);
  assert.deepEqual(r.notes, []);
});

test('multiple annotate rules accumulate in declaration order', () => {
  const r = applyRules(posting({ description: 'no sponsorship, 5+ years required' }), {
    exclude: [],
    annotate: [
      note('rtw', 'all', 'Check eligibility', 'no sponsorship'),
      note('exp', 'all', 'Experience gap', '/\\d\\+ years/i'),
    ],
  });
  assert.deepEqual(r.notes, ['Check eligibility', 'Experience gap']);
});

test('a rule matches when any of its match entries hits', () => {
  const r = applyRules(posting({ title: 'Principal Engineer' }), {
    exclude: [rule('senior', 'title', 'head of', 'principal')], annotate: [],
  });
  assert.equal(r.keep, false);
});

test('a missing field is treated as empty, not an error', () => {
  const r = applyRules(posting({ description: undefined }), {
    exclude: [rule('x', 'description', 'anything')], annotate: [],
  });
  assert.equal(r.keep, true);
});

test('a rule compiled with a /g/ flag excludes three consecutive identical postings', () => {
  // A compiled rule outlives one posting: it is built at config load and reused
  // for every posting of every run. A global regex would advance lastIndex on
  // each .test() and drop every other match.
  const rules = { exclude: [rule('senior', 'title', '/senior/gi')], annotate: [] };
  const verdicts = [1, 2, 3].map(() => applyRules(posting({ title: 'Senior Design Engineer' }), rules));
  assert.deepEqual(verdicts.map((v) => v.keep), [false, false, false]);
});

test('an annotate rule compiled with a /g/ flag fires on three consecutive identical postings', () => {
  const rules = {
    exclude: [],
    annotate: [note('rtw', 'description', 'Check eligibility', '/no sponsorship/g')],
  };
  const p = () => posting({ description: 'We offer no sponsorship.' });
  const notes = [1, 2, 3].map(() => applyRules(p(), rules).notes);
  assert.deepEqual(notes, [['Check eligibility'], ['Check eligibility'], ['Check eligibility']]);
});
