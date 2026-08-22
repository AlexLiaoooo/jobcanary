import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/pipeline.mjs';
import { registerAdapter } from '../src/adapters/index.mjs';
import { compileMatcher } from '../src/config.mjs';
import { registerProvider } from '../src/scoring/index.mjs';
import { unscored } from '../src/scoring/prompt.mjs';

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

test('a provider that tries to omit a posting is caught, not obeyed', async () => {
  // renderDigest filters verdict 'omit' out of the digest and the CLI records
  // every returned posting in seen.json, so obeying one would make the posting
  // vanish for ever, unseen and unreported. No provider may omit — that is the
  // design, and this is where it is enforced rather than trusted.
  fakeAdapter('fake-two', [{ n: 1, title: 'A' }, { n: 2, title: 'B' }]);
  fakeProvider('fake-omitter', async (ps) => ps.map((p, i) => ({
    ...p, score: 5, rationale: 'r', verdict: i === 0 ? 'omit' : 'keep',
  })));
  const cfg = baseConfig({ sites: [{ id: 's1', company: 'Acme Dynamics', type: 'fake-two', enabled: true }] });
  cfg.scoring.provider = 'fake-omitter';

  const { postings, stats } = await run(cfg, { seen: {}, logger: quietLogger });
  assert.match(stats.scoringError, /returned verdict 'omit'/);
  assert.equal(postings.length, 2, 'both postings survive as unscored rather than one vanishing');
  assert.ok(postings.every((p) => p.verdict === 'keep'));
});

test('every posting scoring null is a total failure, and each keeps its own reason', async () => {
  // Per-posting degradation is deliberate and tolerated (see the mixed-result
  // test below), but a provider that comes back with *nothing* scored is a
  // systemic break (missing binary, revoked key, no network) masquerading as
  // a clean run. That must be loud, the same way "every site returned zero
  // postings" is loud rather than a silent empty digest.
  fakeAdapter('fake-two', [{ n: 1, title: 'A' }, { n: 2, title: 'B' }]);
  fakeProvider('fake-all-null', async (ps) => ps.map((p, i) => ({
    ...p, score: null, rationale: `reason ${i}`, verdict: 'keep',
  })));
  const cfg = baseConfig({ sites: [{ id: 's1', company: 'Acme Dynamics', type: 'fake-two', enabled: true }] });
  cfg.scoring.provider = 'fake-all-null';

  const { postings, stats } = await run(cfg, { seen: {}, logger: quietLogger });
  assert.match(stats.scoringError, /no posting could be scored/);
  assert.match(stats.scoringError, /reason 0/, 'the flag names the first reason, for a clue in the summary line');
  // The postings themselves are not touched: each keeps the specific reason
  // the provider gave it, rather than every one being overwritten with the
  // same generic message.
  assert.deepEqual(postings.map((p) => p.rationale), ['reason 0', 'reason 1']);
});

test('stats.unscored counts the postings the provider could not judge', async () => {
  fakeAdapter('fake-three', [{ n: 1, title: 'A' }, { n: 2, title: 'B' }, { n: 3, title: 'C' }]);
  fakeProvider('fake-two-of-three', async (ps) => ps.map((p, i) => (i === 0
    ? { ...p, score: 5, rationale: 'scored', verdict: 'keep' }
    : { ...p, score: null, rationale: 'not scored: rate limited', verdict: 'keep' })));
  const cfg = baseConfig({ sites: [{ id: 's1', company: 'Acme Dynamics', type: 'fake-three', enabled: true }] });
  cfg.scoring.provider = 'fake-two-of-three';

  const { stats } = await run(cfg, { seen: {}, logger: quietLogger });
  assert.equal(stats.kept, 3);
  assert.equal(stats.unscored, 2);
  assert.equal(stats.scoringError, null, 'a partial failure is still not a run failure');
});

test('a provider that reports usage has it carried into stats', async () => {
  fakeAdapter('fake-ok', [{ n: 1, title: 'Graduate Engineer' }]);
  fakeProvider('fake-with-usage', async (ps) => ({
    scored: ps.map((p) => ({ ...p, score: 5, rationale: 'r', verdict: 'keep' })),
    usage: { requests: 4, cacheReadTokens: 2800, cacheCreationTokens: 700 },
  }));
  const cfg = baseConfig();
  cfg.scoring.provider = 'fake-with-usage';

  const { stats } = await run(cfg, { seen: {}, logger: quietLogger });
  assert.equal(stats.scoringRequests, 4);
  assert.equal(stats.cacheReadTokens, 2800);
  assert.equal(stats.cacheCreationTokens, 700);
});

test('a provider that cannot observe caching reports null, not zero', async () => {
  // "No caching happened" and "nobody counted" are different facts, and only
  // the first one is worth acting on.
  fakeAdapter('fake-ok', [{ n: 1, title: 'Graduate Engineer' }]);
  fakeProvider('fake-requests-only', async (ps) => ({
    scored: ps.map((p) => ({ ...p, score: 5, rationale: 'r', verdict: 'keep' })),
    usage: { requests: 1 },
  }));
  const cfg = baseConfig();
  cfg.scoring.provider = 'fake-requests-only';

  const { stats } = await run(cfg, { seen: {}, logger: quietLogger });
  assert.equal(stats.scoringRequests, 1);
  assert.equal(stats.cacheReadTokens, null);
  assert.equal(stats.cacheCreationTokens, null);
});

test('a provider that returns a bare array still works and reports no requests', async () => {
  // `none` returns an array and always will; the usage-carrying shape is
  // optional, not a new obligation on every provider.
  fakeAdapter('fake-ok', [{ n: 1, title: 'Graduate Engineer' }]);
  const { postings, stats } = await run(baseConfig(), { seen: {}, logger: quietLogger });
  assert.equal(postings.length, 1);
  assert.equal(stats.scoringRequests, 0);
  assert.equal(stats.cacheReadTokens, null);
});

test('stats.unscored is 0 when everything scored', async () => {
  fakeAdapter('fake-ok', [{ n: 1, title: 'Graduate Engineer' }]);
  const { stats } = await run(baseConfig(), { seen: {}, logger: quietLogger });
  assert.equal(stats.unscored, 0);
});

test('the total-failure message does not double the "not scored" prefix', async () => {
  fakeAdapter('fake-ok', [{ n: 1, title: 'Graduate Engineer' }]);
  fakeProvider('fake-prefixed', async (ps) => ps.map((p) => unscored(p, 'the binary is missing')));
  const cfg = baseConfig();
  cfg.scoring.provider = 'fake-prefixed';

  const { stats } = await run(cfg, { seen: {}, logger: quietLogger });
  assert.equal(stats.scoringError, 'no posting could be scored — first reason: the binary is missing');
});

test('the first reason is found rather than assumed to be at index 0', async () => {
  // The contract promises one result per posting; it does not promise input
  // order, and it does not promise a rationale on every one.
  fakeAdapter('fake-two', [{ n: 1, title: 'A' }, { n: 2, title: 'B' }]);
  fakeProvider('fake-no-rationale-first', async (ps) => [
    { ...ps[0], score: null, rationale: '', verdict: 'keep' },
    { ...ps[1], score: null, rationale: 'not scored: the model refused', verdict: 'keep' },
  ]);
  const cfg = baseConfig({ sites: [{ id: 's1', company: 'Acme Dynamics', type: 'fake-two', enabled: true }] });
  cfg.scoring.provider = 'fake-no-rationale-first';

  const { stats } = await run(cfg, { seen: {}, logger: quietLogger });
  assert.equal(stats.scoringError, 'no posting could be scored — first reason: the model refused');
});

test('a mix of one scored and one unscored posting is tolerated, not a total failure', async () => {
  fakeAdapter('fake-two', [{ n: 1, title: 'A' }, { n: 2, title: 'B' }]);
  fakeProvider('fake-mixed', async (ps) => [
    { ...ps[0], score: 5, rationale: 'scored fine', verdict: 'keep' },
    { ...ps[1], score: null, rationale: 'not scored: one bad batch', verdict: 'keep' },
  ]);
  const cfg = baseConfig({ sites: [{ id: 's1', company: 'Acme Dynamics', type: 'fake-two', enabled: true }] });
  cfg.scoring.provider = 'fake-mixed';

  const { stats } = await run(cfg, { seen: {}, logger: quietLogger });
  assert.equal(stats.scoringError, null, 'partial failure must stay tolerated');
});

test('an empty posting list does not set scoringError', async () => {
  // `[].every(...)` is vacuously true, so without the enriched.length guard
  // this would misfire: a run with nothing left to score (everything already
  // seen) is not a scoring failure.
  fakeAdapter('fake-ok', [{ n: 1, title: 'Graduate Engineer' }]);
  const { postings, stats } = await run(baseConfig(), {
    seen: { 's1:1': '2026-08-18' }, logger: quietLogger,
  });
  assert.equal(postings.length, 0);
  assert.equal(stats.scoringError, null);
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

test('an async precondition is awaited, not fired and forgotten', async () => {
  // Un-awaited, a rejected promise here would be an unhandled rejection and
  // the crawl would carry on regardless — which is exactly why a missing SDK
  // and a missing binary could not be checked before this was awaited.
  let fetched = false;
  const adapter = fakeAdapter('fake-counted-async', [{ n: 1, title: 'A' }]);
  const realFetch = adapter.fetch.bind(adapter);
  adapter.fetch = async (...args) => { fetched = true; return realFetch(...args); };
  fakeProvider('fake-async-precondition', async (ps) => ps, {
    async checkPrecondition() {
      await new Promise((r) => setTimeout(r, 1));
      throw new Error('the dependency is not installed');
    },
  });
  const cfg = baseConfig({ sites: [{ id: 's1', company: 'Acme Dynamics', type: 'fake-counted-async', enabled: true }] });
  cfg.scoring.provider = 'fake-async-precondition';

  await assert.rejects(() => run(cfg, { seen: {}, logger: quietLogger }), /not installed/);
  assert.equal(fetched, false, 'the precondition must fail before the crawl is paid for');
});

test('the precondition sees the same options score() does, profile included', async () => {
  // They used to differ: score() got the profile path, the precondition did
  // not, so a provider could not check at load time the file it would read at
  // scoring time.
  fakeAdapter('fake-ok', [{ n: 1, title: 'Graduate Engineer' }]);
  let seenByPrecondition = null;
  let seenByScore = null;
  fakeProvider('fake-records-opts', async (ps, o) => {
    seenByScore = o;
    return ps.map((p) => ({ ...p, score: 5, rationale: 'r', verdict: 'keep' }));
  }, {
    checkPrecondition(o) { seenByPrecondition = o; },
  });
  const cfg = baseConfig({ profile: '/somewhere/profile.md' });
  cfg.scoring.provider = 'fake-records-opts';

  await run(cfg, { seen: {}, logger: quietLogger });
  assert.equal(seenByPrecondition.profile, '/somewhere/profile.md');
  assert.deepEqual(seenByPrecondition, seenByScore);
});
