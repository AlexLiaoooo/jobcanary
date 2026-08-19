import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/pipeline.mjs';
import { registerAdapter } from '../src/adapters/index.mjs';
import { compileMatcher } from '../src/config.mjs';

const quietLogger = { log() {}, warn() {}, error() {} };

function fakeAdapter(id, postings, { yieldsDescription = true, fails = false } = {}) {
  const adapter = {
    id, tier: 'http', yieldsDescription,
    async fetch(site) {
      if (fails) throw new Error('HTTP 503');
      return postings.map((p) => ({
        id: `${site.id}:${p.n}`, title: p.title, company: site.company,
        location: '', url: `https://example.test/${p.n}`, postedAt: null,
        description: p.description ?? '', source: site.id, notes: [],
      }));
    },
    async fetchDescription() { return 'fetched description'; },
  };
  registerAdapter(adapter);
  return adapter;
}

const baseConfig = (over = {}) => ({
  profile: null,
  scoring: { provider: 'none', model: 'claude-opus-5', effort: 'high', batch: true, keywords: [] },
  output: { dir: '/tmp/out', format: 'markdown' },
  dedupe: { retentionDays: 30 },
  rules: { exclude: [], annotate: [] },
  sites: [{ id: 's1', company: 'Acme Dynamics', type: 'fake-ok', enabled: true }],
  ...over,
});

test('run returns scored postings and stats', async () => {
  fakeAdapter('fake-ok', [{ n: 1, title: 'Graduate Engineer' }]);
  const { postings, stats } = await run(baseConfig(), { seen: {}, today: '2026-08-19', logger: quietLogger });
  assert.equal(postings.length, 1);
  assert.equal(postings[0].score, 1);
  assert.equal(stats.scanned, 1);
  assert.equal(stats.kept, 1);
});

test('already-seen postings are dropped and counted', async () => {
  fakeAdapter('fake-ok', [{ n: 1, title: 'Graduate Engineer' }]);
  const { postings, stats } = await run(baseConfig(), {
    seen: { 's1:1': '2026-08-18' }, today: '2026-08-19', logger: quietLogger,
  });
  assert.equal(postings.length, 0);
  assert.equal(stats.alreadySeen, 1);
});

test('excluded postings are dropped and counted', async () => {
  fakeAdapter('fake-ok', [{ n: 1, title: 'Head of Aero' }, { n: 2, title: 'Graduate Engineer' }]);
  const cfg = baseConfig({
    rules: { exclude: [{ id: 'senior', field: 'title', match: [compileMatcher('head of')] }], annotate: [] },
  });
  const { postings, stats } = await run(cfg, { seen: {}, today: '2026-08-19', logger: quietLogger });
  assert.equal(postings.length, 1);
  assert.equal(stats.excluded, 1);
});

test('annotations reach the scored output', async () => {
  fakeAdapter('fake-ok', [{ n: 1, title: 'Graduate Engineer', description: 'no sponsorship' }]);
  const cfg = baseConfig({
    rules: {
      exclude: [],
      annotate: [{ id: 'rtw', field: 'description', match: [compileMatcher('no sponsorship')], note: 'Check eligibility' }],
    },
  });
  const { postings } = await run(cfg, { seen: {}, today: '2026-08-19', logger: quietLogger });
  assert.deepEqual(postings[0].notes, ['Check eligibility']);
});

test('a failing site is recorded and the run continues', async () => {
  fakeAdapter('fake-ok', [{ n: 1, title: 'Graduate Engineer' }]);
  fakeAdapter('fake-bad', [], { fails: true });
  const cfg = baseConfig({
    sites: [
      { id: 's1', company: 'Acme Dynamics', type: 'fake-ok', enabled: true },
      { id: 's2', company: 'Zenith Motors', type: 'fake-bad', enabled: true },
    ],
  });
  const { postings, stats } = await run(cfg, { seen: {}, today: '2026-08-19', logger: quietLogger });
  assert.equal(postings.length, 1);
  assert.deepEqual(stats.siteErrors, [{ site: 's2', error: 'HTTP 503' }]);
});

test('run throws when every site fails', async () => {
  fakeAdapter('fake-bad', [], { fails: true });
  const cfg = baseConfig({ sites: [{ id: 's2', company: 'Z', type: 'fake-bad', enabled: true }] });
  await assert.rejects(
    () => run(cfg, { seen: {}, today: '2026-08-19', logger: quietLogger }),
    /all 1 site\(s\) failed/
  );
});

test('disabled sites are skipped entirely', async () => {
  fakeAdapter('fake-ok', [{ n: 1, title: 'Graduate Engineer' }]);
  fakeAdapter('fake-bad', [], { fails: true });
  const cfg = baseConfig({
    sites: [
      { id: 's1', company: 'Acme Dynamics', type: 'fake-ok', enabled: true },
      { id: 's2', company: 'Zenith Motors', type: 'fake-bad', enabled: false },
    ],
  });
  const { stats } = await run(cfg, { seen: {}, today: '2026-08-19', logger: quietLogger });
  assert.deepEqual(stats.siteErrors, []);
});

test('browser-tier sites are skipped unless browser mode is on', async () => {
  const adapter = fakeAdapter('fake-browser', [{ n: 1, title: 'Engineer' }]);
  adapter.tier = 'browser';
  const cfg = baseConfig({ sites: [
    { id: 's1', company: 'Acme Dynamics', type: 'fake-ok', enabled: true },
    { id: 's3', company: 'Vantor', type: 'fake-browser', enabled: true },
  ] });
  fakeAdapter('fake-ok', [{ n: 1, title: 'Graduate Engineer' }]);
  const { stats } = await run(cfg, { seen: {}, today: '2026-08-19', logger: quietLogger, browser: false });
  assert.equal(stats.scanned, 1);
});

test('enrichment runs only for adapters that do not yield descriptions', async () => {
  fakeAdapter('fake-thin', [{ n: 1, title: 'Graduate Engineer' }], { yieldsDescription: false });
  const cfg = baseConfig({ sites: [{ id: 's1', company: 'Acme Dynamics', type: 'fake-thin', enabled: true }] });
  const { postings } = await run(cfg, { seen: {}, today: '2026-08-19', logger: quietLogger });
  assert.equal(postings[0].description, 'fetched description');
});

test('duplicate ids within a run are collapsed', async () => {
  fakeAdapter('fake-dupe', [{ n: 1, title: 'A' }, { n: 1, title: 'A' }]);
  const cfg = baseConfig({ sites: [{ id: 's1', company: 'Acme Dynamics', type: 'fake-dupe', enabled: true }] });
  const { postings } = await run(cfg, { seen: {}, today: '2026-08-19', logger: quietLogger });
  assert.equal(postings.length, 1);
});
