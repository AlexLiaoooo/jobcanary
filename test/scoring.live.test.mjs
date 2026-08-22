import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProvider } from '../src/scoring/index.mjs';
import { assertScoreContract, unwrapScoreResult } from '../src/scoring/contract.mjs';

/**
 * The one test that talks to a real model.
 *
 * Skipped unless JOBCANARY_LIVE=1, so `npm test` stays hermetic and CI never
 * runs it: CI sets no such variable, spends no money, and needs no secret.
 *
 *   JOBCANARY_LIVE=1 npm test
 *   JOBCANARY_LIVE=1 JOBCANARY_LIVE_PROVIDER=claude-cli npm test
 *
 * It exists because every other test in this repo runs against a fake shaped
 * like the implementation — which is exactly how a provider that piped its
 * prompt nowhere passed 229 green tests. A fake cannot tell you the request
 * you build is a request the model will accept.
 */
const LIVE = process.env.JOBCANARY_LIVE === '1';
const PROVIDER_ID = process.env.JOBCANARY_LIVE_PROVIDER || 'anthropic';
const skip = LIVE ? false : 'set JOBCANARY_LIVE=1 to run (spends money, or spawns claude)';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Three postings a real model should be able to tell apart: one squarely in
 * the example profile's field, one adjacent, one unrelated. Deliberately
 * plain text — this is about the request being accepted and the response
 * being usable, not about the model's taste.
 */
const POSTINGS = [
  {
    id: 'live:1',
    title: 'Graduate Thermal Systems Engineer',
    company: 'Vantor Propulsion',
    location: 'Bicester, UK',
    url: 'https://example.test/live/1',
    postedAt: '2026-08-18',
    source: 'live',
    notes: [],
    description:
      'Graduate role in a motorsport powertrain group. Cooling system design and '
      + 'CFD (ANSYS Fluent), rig and track testing, Python for post-processing. '
      + 'MEng in mechanical or aerospace engineering.',
  },
  {
    id: 'live:2',
    title: 'Manufacturing Process Engineer',
    company: 'Northgate Components',
    location: 'Coventry, UK',
    url: 'https://example.test/live/2',
    postedAt: '2026-08-17',
    source: 'live',
    notes: ['Mentions a sponsorship restriction — verify eligibility'],
    description:
      'Own the injection-moulding line: cycle-time reduction, tooling changes, '
      + 'SPC and yield. Some CAD. Five years of shop-floor experience preferred.',
  },
  {
    id: 'live:3',
    title: 'Senior Backend Engineer, Payments',
    company: 'Larkfield Financial',
    location: 'London, UK',
    url: 'https://example.test/live/3',
    postedAt: '2026-08-16',
    source: 'live',
    notes: [],
    description: 'Go and Kafka on a payments ledger. Seven years of production experience.',
  },
];

function liveOpts() {
  // The repo's own example profile and built-in rubric, so the run exercises
  // the prefix that ships rather than a two-line stand-in — prefix length is
  // what decides whether prompt caching engages at all.
  const profile = resolve(here, '..', 'examples', 'profile.md');
  return { profile, rubric: null, model: 'claude-opus-5', effort: 'high', concurrency: 3 };
}

test(`live: ${PROVIDER_ID} scores real postings`, { skip }, async () => {
  const provider = getProvider(PROVIDER_ID);
  const opts = liveOpts();

  // Fail with the provider's own clear message rather than deep inside a call.
  await provider.checkPrecondition?.(opts);

  const { scored, usage } = unwrapScoreResult(await provider.score(POSTINGS, opts));

  // The contract the pipeline enforces, enforced here against a real model.
  assertScoreContract(POSTINGS, scored);

  for (const p of scored) {
    assert.equal(p.verdict, 'keep', `${p.id} came back with verdict ${p.verdict}`);
    assert.ok(
      p.score !== null,
      `${p.id} came back unscored: ${p.rationale}`
    );
    assert.ok(
      Number.isInteger(p.score) && p.score >= 1 && p.score <= 10,
      `${p.id} scored ${JSON.stringify(p.score)}`
    );
    assert.ok(p.rationale.trim().length > 0, `${p.id} came back with an empty rationale`);
  }

  // Not an assertion about the model's judgement — just that the run reported
  // what it cost, which is the only way a silently-disabled cache is visible.
  assert.ok(usage.requests > 0, 'the provider should report the requests it made');
  console.log(`live run: ${JSON.stringify(usage)}`);
  console.log(scored.map((p) => `  [${p.score}/10] ${p.title} — ${p.rationale}`).join('\n'));
});

test('live: an unreadable profile is refused before any request', { skip }, async () => {
  // The precondition is what stands between a typo and a paid-for crawl, so
  // it is worth proving against the real provider too.
  const provider = getProvider(PROVIDER_ID);
  await assert.rejects(
    () => provider.checkPrecondition({ ...liveOpts(), profile: join(tmpdir(), 'jc-live-missing', 'profile.md') }),
    /could not read profile at/
  );
});
