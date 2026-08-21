import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/pipeline.mjs';
import { registerAdapter } from '../src/adapters/index.mjs';
import { compileMatcher } from '../src/config.mjs';
import { registerProvider } from '../src/scoring/index.mjs';

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
  output: { dir: 'out', format: 'markdown' },
  dedupe: { retentionDays: 30 },
  rules: { exclude: [], annotate: [] },
  sites: [{ id: 's1', company: 'Acme Dynamics', type: 'fake-ok', enabled: true }],
  ...over,
});

test('run returns scored postings and stats', async () => {
  fakeAdapter('fake-ok', [{ n: 1, title: 'Graduate Engineer' }]);
  const { postings, stats } = await run(baseConfig(), { seen: {}, logger: quietLogger });
  assert.equal(postings.length, 1);
  assert.equal(postings[0].score, 1);
  assert.equal(stats.scanned, 1);
  assert.equal(stats.kept, 1);
});

test('already-seen postings are dropped and counted', async () => {
  fakeAdapter('fake-ok', [{ n: 1, title: 'Graduate Engineer' }]);
  const { postings, stats } = await run(baseConfig(), {
    seen: { 's1:1': '2026-08-18' }, logger: quietLogger,
  });
  assert.equal(postings.length, 0);
  assert.equal(stats.alreadySeen, 1);
});

test('excluded postings are dropped and counted', async () => {
  fakeAdapter('fake-ok', [{ n: 1, title: 'Head of Aero' }, { n: 2, title: 'Graduate Engineer' }]);
  const cfg = baseConfig({
    rules: { exclude: [{ id: 'senior', field: 'title', match: [compileMatcher('head of')] }], annotate: [] },
  });
  const { postings, stats } = await run(cfg, { seen: {}, logger: quietLogger });
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
  const { postings } = await run(cfg, { seen: {}, logger: quietLogger });
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
  const { postings, stats } = await run(cfg, { seen: {}, logger: quietLogger });
  assert.equal(postings.length, 1);
  assert.deepEqual(stats.siteErrors, [{ site: 's2', error: 'HTTP 503' }]);
});

test('run throws when every site fails', async () => {
  fakeAdapter('fake-bad', [], { fails: true });
  const cfg = baseConfig({ sites: [{ id: 's2', company: 'Z', type: 'fake-bad', enabled: true }] });
  await assert.rejects(
    () => run(cfg, { seen: {}, logger: quietLogger }),
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
  const { stats } = await run(cfg, { seen: {}, logger: quietLogger });
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
  const { stats } = await run(cfg, { seen: {}, logger: quietLogger, browser: false });
  assert.equal(stats.scanned, 1);
});

test('enrichment runs only for adapters that do not yield descriptions', async () => {
  fakeAdapter('fake-thin', [{ n: 1, title: 'Graduate Engineer' }], { yieldsDescription: false });
  const cfg = baseConfig({ sites: [{ id: 's1', company: 'Acme Dynamics', type: 'fake-thin', enabled: true }] });
  const { postings } = await run(cfg, { seen: {}, logger: quietLogger });
  assert.equal(postings[0].description, 'fetched description');
});

test('duplicate ids within a run are collapsed', async () => {
  fakeAdapter('fake-dupe', [{ n: 1, title: 'A' }, { n: 1, title: 'A' }]);
  const cfg = baseConfig({ sites: [{ id: 's1', company: 'Acme Dynamics', type: 'fake-dupe', enabled: true }] });
  const { postings } = await run(cfg, { seen: {}, logger: quietLogger });
  assert.equal(postings.length, 1);
});

test('an unknown scoring provider throws before any site is fetched', async () => {
  // This test builds its config directly rather than through parseConfig, so
  // it is free to name a provider id that is not registered — the real-world
  // case: the whole crawl must not be paid for and discarded.
  let fetched = false;
  registerAdapter({
    id: 'fake-counting', tier: 'http', yieldsDescription: true,
    async fetch() { fetched = true; return []; },
  });
  const cfg = baseConfig({
    scoring: { provider: 'not-a-real-provider', model: 'claude-opus-5', effort: 'high', batch: true, keywords: [] },
    sites: [{ id: 's1', company: 'Acme Dynamics', type: 'fake-counting', enabled: true }],
  });
  await assert.rejects(
    () => run(cfg, { seen: {}, logger: quietLogger }),
    /unknown scoring provider 'not-a-real-provider'/
  );
  assert.equal(fetched, false, 'the adapter must not have been fetched');
});

test('run throws when every site returns zero postings', async () => {
  fakeAdapter('fake-empty', []);
  const cfg = baseConfig({ sites: [{ id: 's1', company: 'Acme Dynamics', type: 'fake-empty', enabled: true }] });
  await assert.rejects(
    () => run(cfg, { seen: {}, logger: quietLogger }),
    /all 1 site\(s\) returned zero postings/
  );
});

test('run throws when the only site that did not fail returned zero postings', async () => {
  fakeAdapter('fake-empty', []);
  fakeAdapter('fake-bad', [], { fails: true });
  const cfg = baseConfig({
    sites: [
      { id: 's1', company: 'Acme Dynamics', type: 'fake-empty', enabled: true },
      { id: 's2', company: 'Zenith Motors', type: 'fake-bad', enabled: true },
    ],
  });
  await assert.rejects(
    () => run(cfg, { seen: {}, logger: quietLogger }),
    /all 2 site\(s\) returned zero postings/
  );
});

test('a site returning zero postings is fine as long as another returned some', async () => {
  fakeAdapter('fake-empty', []);
  fakeAdapter('fake-ok', [{ n: 1, title: 'Graduate Engineer' }]);
  const cfg = baseConfig({
    sites: [
      { id: 's1', company: 'Acme Dynamics', type: 'fake-empty', enabled: true },
      { id: 's2', company: 'Zenith Motors', type: 'fake-ok', enabled: true },
    ],
  });
  const { stats } = await run(cfg, { seen: {}, logger: quietLogger });
  assert.equal(stats.scanned, 1);
});

test('no sites at all is not a zero-postings error', async () => {
  fakeAdapter('fake-ok', [{ n: 1, title: 'Graduate Engineer' }]);
  const cfg = baseConfig({ sites: [{ id: 's1', company: 'Acme Dynamics', type: 'fake-ok', enabled: false }] });
  const { stats } = await run(cfg, { seen: {}, logger: quietLogger });
  assert.equal(stats.scanned, 0);
});

test('stats report the ids excluded by rules this run', async () => {
  fakeAdapter('fake-ok', [{ n: 1, title: 'Head of Aero' }, { n: 2, title: 'Graduate Engineer' }]);
  const cfg = baseConfig({
    rules: { exclude: [{ id: 'senior', field: 'title', match: [compileMatcher('head of')] }], annotate: [] },
  });
  const { stats } = await run(cfg, { seen: {}, logger: quietLogger });
  assert.deepEqual(stats.excludedIds, ['s1:1']);
});

test('stats report ids excluded in the second, description-based pass', async () => {
  fakeAdapter('fake-thin', [{ n: 1, title: 'Graduate Engineer' }], { yieldsDescription: false });
  const cfg = baseConfig({
    sites: [{ id: 's1', company: 'Acme Dynamics', type: 'fake-thin', enabled: true }],
    // The fake adapter's fetchDescription returns 'fetched description', which
    // only the post-enrichment pass can see.
    rules: { exclude: [{ id: 'desc', field: 'description', match: [compileMatcher('fetched description')] }], annotate: [] },
  });
  const { postings, stats } = await run(cfg, { seen: {}, logger: quietLogger });
  assert.equal(postings.length, 0);
  assert.deepEqual(stats.excludedIds, ['s1:1']);
  assert.equal(stats.excluded, 1);
});

test('stats count one enrichment fetch per posting that needed one', async () => {
  fakeAdapter('fake-thin', [{ n: 1, title: 'A' }, { n: 2, title: 'B' }], { yieldsDescription: false });
  const cfg = baseConfig({ sites: [{ id: 's1', company: 'Acme Dynamics', type: 'fake-thin', enabled: true }] });
  const { stats } = await run(cfg, { seen: {}, logger: quietLogger });
  assert.equal(stats.enrichmentFetches, 2);
});

test('an adapter that ships descriptions costs no enrichment fetches', async () => {
  fakeAdapter('fake-ok', [{ n: 1, title: 'Graduate Engineer' }]);
  const { stats } = await run(baseConfig(), { seen: {}, logger: quietLogger });
  assert.equal(stats.enrichmentFetches, 0);
  assert.deepEqual(stats.excludedIds, []);
});

test('an already-seen posting costs no enrichment fetch', async () => {
  fakeAdapter('fake-thin', [{ n: 1, title: 'Graduate Engineer' }], { yieldsDescription: false });
  const cfg = baseConfig({ sites: [{ id: 's1', company: 'Acme Dynamics', type: 'fake-thin', enabled: true }] });
  const { stats } = await run(cfg, { seen: { 's1:1': '2026-08-18' }, logger: quietLogger });
  assert.equal(stats.enrichmentFetches, 0);
});

test('run works with no options object at all', async () => {
  // src/index.mjs exports run publicly, so run(config) must not blow up on a
  // destructuring TypeError. The site is disabled to keep the default logger
  // (console) quiet while still exercising the defaults.
  fakeAdapter('fake-ok', [{ n: 1, title: 'Graduate Engineer' }]);
  const cfg = baseConfig({ sites: [{ id: 's1', company: 'Acme Dynamics', type: 'fake-ok', enabled: false }] });
  const { postings, stats } = await run(cfg);
  assert.deepEqual(postings, []);
  assert.equal(stats.scanned, 0);
});

function fakeProvider(id, impl, { checkPrecondition } = {}) {
  const provider = { id, score: impl };
  if (checkPrecondition) provider.checkPrecondition = checkPrecondition;
  registerProvider(provider);
  return provider;
}

test('a scoring failure keeps the crawl and reports scoringError', async () => {
  fakeAdapter('fake-ok', [{ n: 1, title: 'Graduate Engineer' }]);
  fakeProvider('fake-boom', async () => { throw new Error('API exploded'); });
  const cfg = baseConfig();
  cfg.scoring.provider = 'fake-boom';

  const { postings, stats } = await run(cfg, { seen: {}, logger: quietLogger });
  assert.match(stats.scoringError, /API exploded/);
  // The crawl is not thrown away — the posting is still here, just unscored.
  assert.equal(postings.length, 1);
  assert.equal(postings[0].score, null);
  assert.match(postings[0].rationale, /not scored/);
  assert.equal(postings[0].verdict, 'keep');
});

test('scoringError is null on a clean run', async () => {
  fakeAdapter('fake-ok', [{ n: 1, title: 'Graduate Engineer' }]);
  const { stats } = await run(baseConfig(), { seen: {}, logger: quietLogger });
  assert.equal(stats.scoringError, null);
});

test('a provider that drops a posting is caught, not trusted', async () => {
  fakeAdapter('fake-two', [{ n: 1, title: 'A' }, { n: 2, title: 'B' }]);
  fakeProvider('fake-dropper', async (ps) => ps.slice(1).map((p) => ({ ...p, score: 5, rationale: 'r', verdict: 'keep' })));
  const cfg = baseConfig({ sites: [{ id: 's1', company: 'Acme Dynamics', type: 'fake-two', enabled: true }] });
  cfg.scoring.provider = 'fake-dropper';

  const { postings, stats } = await run(cfg, { seen: {}, logger: quietLogger });
  assert.match(stats.scoringError, /dropped posting id/);
  assert.equal(postings.length, 2, 'both postings survive as unscored rather than one vanishing');
});

test('a provider precondition is checked before any site is fetched', async () => {
  let fetched = false;
  const adapter = fakeAdapter('fake-counted', [{ n: 1, title: 'A' }]);
  const realFetch = adapter.fetch.bind(adapter);
  adapter.fetch = async (...args) => { fetched = true; return realFetch(...args); };
  fakeProvider('fake-needs-key', async (ps) => ps, {
    checkPrecondition() { throw new Error('SCORING_PRECONDITION: no key'); },
  });
  const cfg = baseConfig({ sites: [{ id: 's1', company: 'Acme Dynamics', type: 'fake-counted', enabled: true }] });
  cfg.scoring.provider = 'fake-needs-key';

  await assert.rejects(() => run(cfg, { seen: {}, logger: quietLogger }), /no key/);
  assert.equal(fetched, false, 'the precondition must fail before the crawl is paid for');
});
