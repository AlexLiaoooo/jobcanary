# jobcanary LLM Scoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Score each posting against the user's own profile with an LLM, via two providers (`anthropic`, `claude-cli`), and make a scoring failure degrade to an unscored digest instead of discarding the run's crawl.

**Architecture:** Two new providers behind the existing `score(postings, opts)` interface, plus a pure prompt module they share. `run()` gains contract enforcement over whatever a provider returns, and returns `stats.scoringError` rather than throwing. `renderDigest` learns to render and sort a null score.

**Tech Stack:** Node 20+, ESM, `node --test`. `@anthropic-ai/sdk` as an **optional peer dependency**, dynamically imported. No `zod` — structured output uses a raw JSON schema.

**Spec:** `docs/superpowers/specs/2026-08-20-llm-scoring-design.md`

## Global Constraints

- Node 20 or later. ESM only. No CommonJS.
- **The core keeps exactly one runtime `dependency`: `yaml`.** `@anthropic-ai/sdk` goes in `peerDependencies` + `peerDependenciesMeta.optional` and is loaded by dynamic `import()`. Never add `zod`.
- Never use `Date.now()` or `new Date()` in pure functions.
- No network in any test. Providers take an injectable client, exactly as adapters take `ctx.http`.
- Exit codes: `0` ok · `1` unexpected · `2` config invalid · `3` all sites failed · `4` scoring failed, digest still written. **Task 7 makes exit 4 reachable for the first time.**
- `Scored` = `Posting & { score: number|null, rationale: string, verdict: 'keep' }`. Providers never set `verdict` to anything else — the model has no power to omit.
- A provider returns **exactly one `Scored` per input posting**, matched by id.
- `none` stays the default provider. A fresh clone must not cost money.
- Model default is `claude-opus-5`. Do not substitute a cheaper model.
- Commit after every task.

---

### Task 1: Shared prompt module

**Files:**
- Create: `src/scoring/prompt.mjs`
- Test: `test/scoring.prompt.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `DEFAULT_RUBRIC: string`
  - `buildPrefix({ rubric, profile }) → string`
  - `buildPostingBlock(posting) → string`
  - `SCORE_SCHEMA: object`
  - `unscored(posting, reason) → Scored`

`buildPrefix` output is the cached prompt prefix. It must depend on nothing but its two arguments — no clock, no counter, no posting data — or prompt caching silently stops working.

- [ ] **Step 1: Write the failing test**

Create `test/scoring.prompt.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RUBRIC, buildPrefix, buildPostingBlock, SCORE_SCHEMA, unscored } from '../src/scoring/prompt.mjs';

const posting = (over = {}) => ({
  id: 'acme:1', title: 'Graduate Design Engineer', company: 'Acme Dynamics',
  location: 'Oxford, UK', url: 'https://example.test/1', postedAt: '2026-08-18',
  description: 'CFD and CAD work.', source: 'acme', notes: [], ...over,
});

test('the default rubric asks for a 1-10 score and a one-line rationale', () => {
  assert.match(DEFAULT_RUBRIC, /1\s*(–|-|to)\s*10/i);
  assert.match(DEFAULT_RUBRIC, /rationale|justif/i);
});

test('the default rubric never invites the model to omit a posting', () => {
  assert.doesNotMatch(DEFAULT_RUBRIC, /\bomit\b|\bdrop\b|\bexclude\b|\bdiscard\b/i);
});

test('buildPrefix contains both the rubric and the profile', () => {
  const out = buildPrefix({ rubric: 'RUBRIC TEXT', profile: 'PROFILE TEXT' });
  assert.match(out, /RUBRIC TEXT/);
  assert.match(out, /PROFILE TEXT/);
});

test('buildPrefix is byte-identical for identical inputs', () => {
  const a = buildPrefix({ rubric: 'R', profile: 'P' });
  const b = buildPrefix({ rubric: 'R', profile: 'P' });
  assert.equal(a, b);
});

test('buildPrefix depends on nothing but its arguments', () => {
  // A prefix that varies run to run silently defeats prompt caching, and the
  // only symptom is a larger bill. Assert the function is pure by calling it
  // with the same input either side of a changed global.
  const before = buildPrefix({ rubric: 'R', profile: 'P' });
  globalThis.__jobcanaryCanary = Math.min(1, 2);
  const after = buildPrefix({ rubric: 'R', profile: 'P' });
  delete globalThis.__jobcanaryCanary;
  assert.equal(before, after);
});

test('buildPostingBlock carries title, company, location and description', () => {
  const out = buildPostingBlock(posting());
  assert.match(out, /Graduate Design Engineer/);
  assert.match(out, /Acme Dynamics/);
  assert.match(out, /Oxford, UK/);
  assert.match(out, /CFD and CAD work\./);
});

test('buildPostingBlock surfaces annotation notes to the model', () => {
  const out = buildPostingBlock(posting({ notes: ['Mentions a sponsorship restriction'] }));
  assert.match(out, /Mentions a sponsorship restriction/);
});

test('buildPostingBlock omits the notes line entirely when there are none', () => {
  assert.doesNotMatch(buildPostingBlock(posting()), /flag/i);
});

test('buildPostingBlock says so explicitly when no description was captured', () => {
  assert.match(buildPostingBlock(posting({ description: '' })), /no description/i);
});

test('SCORE_SCHEMA constrains the score to an integer 1-10 and forbids extra keys', () => {
  assert.equal(SCORE_SCHEMA.properties.score.type, 'integer');
  assert.equal(SCORE_SCHEMA.properties.score.minimum, 1);
  assert.equal(SCORE_SCHEMA.properties.score.maximum, 10);
  assert.deepEqual(SCORE_SCHEMA.required.sort(), ['rationale', 'score']);
  assert.equal(SCORE_SCHEMA.additionalProperties, false);
});

test('SCORE_SCHEMA does not let the model decide the verdict', () => {
  assert.equal(SCORE_SCHEMA.properties.verdict, undefined);
});

test('unscored keeps the posting, nulls the score and states the reason', () => {
  const u = unscored(posting(), 'response did not match the schema');
  assert.equal(u.id, 'acme:1');
  assert.equal(u.score, null);
  assert.equal(u.verdict, 'keep');
  assert.match(u.rationale, /not scored: response did not match the schema/);
});

test('unscored does not mutate its input', () => {
  const p = posting();
  unscored(p, 'why');
  assert.equal(p.score, undefined);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/scoring.prompt.test.mjs`
Expected: FAIL — `Cannot find module '../src/scoring/prompt.mjs'`

- [ ] **Step 3: Write the implementation**

Create `src/scoring/prompt.mjs`:

```js
/**
 * Everything both LLM providers say to the model, in one place.
 *
 * Nothing here touches the network or the clock. `buildPrefix` in particular
 * must stay a pure function of its arguments: its output is the cached prompt
 * prefix, and a single varying byte silently disables prompt caching.
 */

export const DEFAULT_RUBRIC = `
You are scoring a job posting for one candidate, whose profile follows.

Give the posting a fit score from 1 to 10:

- 9-10  Direct hit: the role, the field and the required skills all match the
        profile closely.
- 7-8   Strong fit: clearly the right field and level, most skills match.
- 5-6   Plausible: adjacent field or partially matching skills.
- 3-4   Weak: the discipline or the level is wrong, but not absurd.
- 1-2   Poor: little relation to the profile.

Then give a one-sentence rationale that refers to something specific in the
profile. Say what actually drove the score, including when the reason is a
mismatch.

Judge only what the posting and the profile support. Do not invent
requirements the posting does not state. If the posting text is thin, say so
in the rationale and score conservatively.

Some postings arrive with flags raised by earlier keyword filters. A flag is a
prompt to look, not a verdict — weigh it against the rest of the posting and
explain your reading of it.

Score every posting you are given. It is not your decision whether a posting
reaches the reader.
`.trim();

/**
 * Build the cached prompt prefix: rubric first, then the candidate profile.
 * Pure — output depends only on the arguments.
 */
export function buildPrefix({ rubric, profile }) {
  return `${rubric.trim()}\n\n## Candidate profile\n\n${profile.trim()}`;
}

/**
 * Render one posting as the user-turn content.
 * Notes from `annotate` rules are included deliberately: the keyword layer
 * raises a concern it cannot adjudicate, and the model weighs it in context.
 */
export function buildPostingBlock(posting) {
  const lines = [`Title: ${posting.title}`, `Company: ${posting.company}`];
  if (posting.location) lines.push(`Location: ${posting.location}`);
  if (posting.notes?.length) {
    lines.push(`Flags raised by earlier filters: ${posting.notes.join(' · ')}`);
  }
  lines.push('', 'Description:', posting.description || '(no description captured)');
  return lines.join('\n');
}

/**
 * The structured-output schema. Deliberately has no `verdict` field: the
 * model scores and explains, it does not decide what the reader sees.
 */
export const SCORE_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer', minimum: 1, maximum: 10 },
    rationale: { type: 'string' },
  },
  required: ['score', 'rationale'],
  additionalProperties: false,
};

/**
 * A posting that could not be scored. Still reported, ranked last, with the
 * reason visible — never silently dropped.
 */
export function unscored(posting, reason) {
  return { ...posting, score: null, rationale: `not scored: ${reason}`, verdict: 'keep' };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/scoring.prompt.test.mjs`
Expected: PASS — 13 tests

- [ ] **Step 5: Commit**

```bash
git add src/scoring/prompt.mjs test/scoring.prompt.test.mjs
git commit -m "feat: shared prompt module for the LLM scoring providers"
```

---

### Task 2: Render and sort a null score

**Files:**
- Modify: `src/output/markdown.mjs`
- Test: `test/output.markdown.test.mjs` (add cases)

**Interfaces:**
- Consumes: `Scored` with `score: number|null`
- Produces: no signature change to `renderDigest(scored, meta)`

A posting that could not be scored still appears, ranked last, headed `[—]`.

- [ ] **Step 1: Write the failing tests**

Append to `test/output.markdown.test.mjs` (the file already defines a `scored` helper and a `meta` constant — reuse them):

```js
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/output.markdown.test.mjs`
Expected: FAIL — the heading renders `[null/10]` and the sort puts null first

- [ ] **Step 3: Change the implementation**

In `src/output/markdown.mjs`, replace the comparator and the heading line:

```js
// An unscored posting sorts below every scored one: -1 is lower than the
// schema's minimum of 1, so nulls fall to the bottom without a special case.
function byScoreThenCompany(a, b) {
  const left = a.score ?? -1;
  const right = b.score ?? -1;
  if (right !== left) return right - left;
  return a.company.localeCompare(b.company);
}
```

and in `renderPosting`:

```js
    `### [${p.score === null ? '—' : `${p.score}/10`}] ${p.title} · ${p.company}`,
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/output.markdown.test.mjs`
Expected: PASS — 14 tests

- [ ] **Step 5: Commit**

```bash
git add src/output/markdown.mjs test/output.markdown.test.mjs
git commit -m "feat: render and rank postings that could not be scored"
```

---

### Task 3: Contract enforcement, provider preconditions, and `run()`'s new return shape

**Files:**
- Create: `src/scoring/contract.mjs`
- Modify: `src/pipeline.mjs`
- Test: `test/scoring.contract.test.mjs`
- Test: `test/pipeline.test.mjs` (add cases)

**Interfaces:**
- Consumes: `unscored` from Task 1
- Produces:
  - `assertScoreContract(input, output) → void` — throws on any violation
  - `run(...)` gains `stats.scoringError` (string or `null`)
  - `run(...)` calls `provider.checkPrecondition?.(config.scoring)` immediately after `getProvider`, before any fetch

This is the task that makes exit 4 possible and stops a provider silently making a posting immortal.

- [ ] **Step 1: Write the failing contract test**

Create `test/scoring.contract.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertScoreContract } from '../src/scoring/contract.mjs';

const p = (id) => ({ id, title: 't', company: 'c' });
const s = (id) => ({ id, title: 't', company: 'c', score: 5, rationale: 'r', verdict: 'keep' });

test('a matching set of results passes', () => {
  assert.doesNotThrow(() => assertScoreContract([p('a'), p('b')], [s('a'), s('b')]));
});

test('order does not matter, only the id set', () => {
  assert.doesNotThrow(() => assertScoreContract([p('a'), p('b')], [s('b'), s('a')]));
});

test('an empty input with an empty output passes', () => {
  assert.doesNotThrow(() => assertScoreContract([], []));
});

test('a non-array result throws', () => {
  assert.throws(() => assertScoreContract([p('a')], undefined), /did not return an array/);
});

test('a dropped posting throws and names it', () => {
  assert.throws(() => assertScoreContract([p('a'), p('b')], [s('a')]), /dropped posting id\(s\): b/);
});

test('an extra posting throws and names it', () => {
  assert.throws(() => assertScoreContract([p('a')], [s('a'), s('zz')]), /unknown posting id 'zz'/);
});

test('a duplicated posting throws rather than passing on count alone', () => {
  // Same length as the input, so a naive length check would let this through
  // while posting 'b' was silently lost.
  assert.throws(() => assertScoreContract([p('a'), p('b')], [s('a'), s('a')]), /unknown posting id 'a'|dropped/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/scoring.contract.test.mjs`
Expected: FAIL — `Cannot find module '../src/scoring/contract.mjs'`

- [ ] **Step 3: Write the contract module**

Create `src/scoring/contract.mjs`:

```js
/**
 * Enforce the scoring provider contract: exactly one result per input
 * posting, matched by id.
 *
 * This is checked rather than trusted because the failure it catches is
 * silent and permanent. The CLI records `seen.json` from the provider's
 * returned array, so a posting the provider quietly drops is never marked
 * seen — it is re-fetched, re-enriched and re-offered on every future run,
 * for ever, with nothing anywhere reporting a problem.
 *
 * @throws {Error} on any mismatch
 */
export function assertScoreContract(input, output) {
  if (!Array.isArray(output)) {
    throw new Error('scoring provider did not return an array');
  }

  const expected = new Set(input.map((p) => p.id));
  for (const result of output) {
    // delete() returns false for an id that was never expected OR that a
    // previous result already claimed, which catches duplicates too.
    if (!expected.delete(result?.id)) {
      throw new Error(`scoring provider returned an unknown posting id '${result?.id}'`);
    }
  }
  if (expected.size > 0) {
    throw new Error(`scoring provider dropped posting id(s): ${[...expected].join(', ')}`);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/scoring.contract.test.mjs`
Expected: PASS — 7 tests

- [ ] **Step 5: Write the failing pipeline tests**

Append to `test/pipeline.test.mjs` (reuse its existing `fakeAdapter`, `baseConfig` and `quietLogger`):

```js
import { registerProvider } from '../src/scoring/index.mjs';

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
```

- [ ] **Step 6: Run to verify they fail**

Run: `node --test test/pipeline.test.mjs`
Expected: FAIL — `stats.scoringError` is undefined and the provider throw escapes `run`

- [ ] **Step 7: Change `src/pipeline.mjs`**

Add the imports:

```js
import { assertScoreContract } from './scoring/contract.mjs';
import { unscored } from './scoring/prompt.mjs';
```

Immediately after `const provider = getProvider(config.scoring.provider);`, add:

```js
  // A provider's precondition (an API key, a binary on PATH) is checked here,
  // before a single site is fetched — discovering a missing key after paying
  // for a full crawl is the failure this ordering exists to prevent.
  provider.checkPrecondition?.(config.scoring);
```

Replace the scoring line:

```js
  // A scoring failure must not discard the crawl. Fall back to unscored
  // postings and report the reason; the CLI still writes a digest and exits 4.
  let postings;
  let scoringError = null;
  try {
    postings = await provider.score(enriched, { ...config.scoring, profile: config.profile });
    assertScoreContract(enriched, postings);
  } catch (err) {
    scoringError = err.message;
    postings = enriched.map((p) => unscored(p, err.message));
  }
```

and add `scoringError` to the returned stats:

```js
    stats: { scanned, excluded, alreadySeen, kept: postings.length, siteErrors, excludedIds, enrichmentFetches, scoringError },
```

Keep every existing stats field exactly as it is — only add `scoringError`.

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS — all suites

- [ ] **Step 9: Commit**

```bash
git add src/scoring/contract.mjs src/pipeline.mjs test/scoring.contract.test.mjs test/pipeline.test.mjs
git commit -m "feat: enforce the scoring contract and degrade instead of losing the crawl"
```

---

### Task 4: Config — the rubric key and the profile requirement

**Files:**
- Modify: `src/config.mjs`
- Test: `test/config.test.mjs` (add cases)

**Interfaces:**
- Consumes: nothing new
- Produces: `config.scoring.rubric` — an absolute path or `null`

`profile` becomes required when the provider is not `none`, validated at load so it fails at exit 2 before anything is fetched.

- [ ] **Step 1: Write the failing tests**

Append to `test/config.test.mjs`:

```js
test('scoring.rubric resolves against the config directory', () => {
  const cfg = parseConfig('scoring: {rubric: ./r.md}\nprofile: ./p.md\nsites:\n  - {id: a, company: A, type: greenhouse, board: x}\n', '/base');
  assert.match(cfg.scoring.rubric, /r\.md$/);
});

test('scoring.rubric defaults to null', () => {
  const cfg = parseConfig('sites:\n  - {id: a, company: A, type: greenhouse, board: x}\n', '/base');
  assert.equal(cfg.scoring.rubric, null);
});

test('a non-string scoring.rubric is a ConfigError', () => {
  const yaml = 'scoring: {rubric: 7}\nprofile: ./p.md\nsites:\n  - {id: a, company: A, type: greenhouse, board: x}\n';
  assert.throws(() => parseConfig(yaml, '/base'), ConfigError);
});

test('an LLM provider without a profile is a ConfigError', () => {
  const yaml = 'scoring: {provider: anthropic}\nsites:\n  - {id: a, company: A, type: greenhouse, board: x}\n';
  assert.throws(() => parseConfig(yaml, '/base'), /needs 'profile'/);
});

test('claude-cli also requires a profile', () => {
  const yaml = 'scoring: {provider: claude-cli}\nsites:\n  - {id: a, company: A, type: greenhouse, board: x}\n';
  assert.throws(() => parseConfig(yaml, '/base'), /needs 'profile'/);
});

test('the none provider does not require a profile', () => {
  const yaml = 'scoring: {provider: none}\nsites:\n  - {id: a, company: A, type: greenhouse, board: x}\n';
  assert.doesNotThrow(() => parseConfig(yaml, '/base'));
});

test('scoring.batch true is rejected while the Batch API is unbuilt', () => {
  const yaml = 'scoring: {batch: true}\nsites:\n  - {id: a, company: A, type: greenhouse, board: x}\n';
  assert.throws(() => parseConfig(yaml, '/base'), /not implemented yet/);
});

test('scoring.concurrency defaults to 5 and must be a positive integer', () => {
  const cfg = parseConfig('sites:\n  - {id: a, company: A, type: greenhouse, board: x}\n', '/base');
  assert.equal(cfg.scoring.concurrency, 5);
  const bad = 'scoring: {concurrency: 0}\nsites:\n  - {id: a, company: A, type: greenhouse, board: x}\n';
  assert.throws(() => parseConfig(bad, '/base'), ConfigError);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/config.test.mjs`
Expected: FAIL — `cfg.scoring.rubric` is undefined and no profile check exists

- [ ] **Step 3: Change `src/config.mjs`**

Inside `parseConfig`, extend the `scoring` block. Add `rubric` and `concurrency` alongside the existing keys, then validate:

```js
  const scoring = {
    provider: raw.scoring?.provider ?? 'none',
    model: raw.scoring?.model ?? 'claude-opus-5',
    effort: raw.scoring?.effort ?? 'high',
    batch: raw.scoring?.batch ?? false,
    concurrency: raw.scoring?.concurrency ?? 5,
    keywords: raw.scoring?.keywords ?? [],
    rubric: null,
  };
```

Note the `batch` default changes from `true` to `false` — the Batch API's 24-hour SLA is incompatible with a daily digest, so it is opt-in.

Then, after the existing provider/keywords validation:

```js
  if (!Number.isInteger(scoring.concurrency) || scoring.concurrency < 1) {
    throw new ConfigError('scoring.concurrency must be a positive integer');
  }
  // The Batch API is specified but not built in this plan. Accepting the key
  // silently would leave a config option that does nothing — say so instead.
  if (scoring.batch === true) {
    throw new ConfigError(
      'scoring.batch is not implemented yet — the Batch API is planned but unbuilt, so leave it false'
    );
  }
  if (raw.scoring?.rubric !== undefined && raw.scoring?.rubric !== null) {
    if (typeof raw.scoring.rubric !== 'string') {
      throw new ConfigError('scoring.rubric must be a path string');
    }
    scoring.rubric = resolve(baseDir, raw.scoring.rubric);
  }
```

And after `profile` is resolved, add the requirement:

```js
  // An LLM provider scores against the profile, so a missing one is a config
  // error rather than a surprise at scoring time — after the crawl is paid for.
  if (scoring.provider !== 'none' && !profile) {
    throw new ConfigError(`scoring.provider '${scoring.provider}' needs 'profile' to be set`);
  }
```

`profile` must be computed before this check — hoist its `resolve` above the return if it is currently inline.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.mjs test/config.test.mjs
git commit -m "feat: rubric config key, concurrency, and require a profile for LLM providers"
```

---

### Task 5: The `anthropic` provider

**Files:**
- Create: `src/scoring/anthropic.mjs`
- Modify: `src/scoring/index.mjs` (register it)
- Test: `test/scoring.anthropic.test.mjs`

**Interfaces:**
- Consumes: `buildPrefix`, `buildPostingBlock`, `SCORE_SCHEMA`, `unscored`, `DEFAULT_RUBRIC` (Task 1); `ConfigError` from `src/config.mjs`
- Produces: default-exported provider `{ id: 'anthropic', checkPrecondition(scoring), score(postings, opts) }`
- `opts.client` injects a client for tests. When absent, the SDK is dynamically imported and a real client constructed.

- [ ] **Step 1: Write the failing test**

Create `test/scoring.anthropic.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import anthropic from '../src/scoring/anthropic.mjs';
import { getProvider } from '../src/scoring/index.mjs';

function profileFile(text = 'Graduate mechanical engineer, CFD and CAD.') {
  const dir = mkdtempSync(join(tmpdir(), 'jc-prof-'));
  const p = join(dir, 'profile.md');
  writeFileSync(p, text, 'utf8');
  return p;
}

const posting = (over = {}) => ({
  id: 'acme:1', title: 'Graduate Design Engineer', company: 'Acme Dynamics',
  location: 'Oxford, UK', url: 'https://example.test/1', postedAt: null,
  description: 'CFD work.', source: 'acme', notes: [], ...over,
});

// A fake client with the same surface the provider uses: messages.parse().
function fakeClient(handler) {
  const calls = [];
  return {
    calls,
    messages: {
      async parse(req) {
        calls.push(req);
        return handler(req, calls.length - 1);
      },
    },
  };
}
const ok = (score, rationale = 'because') => ({ parsed_output: { score, rationale }, stop_reason: 'end_turn' });
const opts = (client, over = {}) => ({
  client, model: 'claude-opus-5', effort: 'high', concurrency: 5,
  profile: profileFile(), rubric: null, ...over,
});

test('registry resolves the anthropic provider', () => {
  assert.equal(getProvider('anthropic').id, 'anthropic');
});

test('checkPrecondition throws when ANTHROPIC_API_KEY is absent', () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.throws(() => anthropic.checkPrecondition({}), /ANTHROPIC_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('checkPrecondition passes when the key is present', () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  try {
    assert.doesNotThrow(() => anthropic.checkPrecondition({}));
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('one request is made per posting', async () => {
  const client = fakeClient(() => ok(7));
  const out = await anthropic.score([posting({ id: 'a:1' }), posting({ id: 'a:2' })], opts(client));
  assert.equal(client.calls.length, 2);
  assert.equal(out.length, 2);
});

test('the score and rationale come back on the posting', async () => {
  const client = fakeClient(() => ok(9, 'strong CFD match'));
  const [out] = await anthropic.score([posting()], opts(client));
  assert.equal(out.id, 'acme:1');
  assert.equal(out.score, 9);
  assert.equal(out.rationale, 'strong CFD match');
  assert.equal(out.verdict, 'keep');
});

test('the cached prefix is byte-identical across every request', async () => {
  const client = fakeClient(() => ok(5));
  await anthropic.score([posting({ id: 'a:1' }), posting({ id: 'a:2' }), posting({ id: 'a:3' })], opts(client));
  const prefixes = client.calls.map((c) => c.system[0].text);
  assert.equal(new Set(prefixes).size, 1, 'a varying prefix silently defeats prompt caching');
});

test('the prefix is marked for caching', async () => {
  const client = fakeClient(() => ok(5));
  await anthropic.score([posting()], opts(client));
  assert.deepEqual(client.calls[0].system[0].cache_control, { type: 'ephemeral' });
});

test('the request asks for the score schema and carries the model and effort', async () => {
  const client = fakeClient(() => ok(5));
  await anthropic.score([posting()], opts(client, { model: 'claude-haiku-4-5', effort: 'low' }));
  const req = client.calls[0];
  assert.equal(req.model, 'claude-haiku-4-5');
  assert.equal(req.output_config.effort, 'low');
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.equal(req.output_config.format.schema.properties.score.maximum, 10);
  assert.deepEqual(req.thinking, { type: 'adaptive' });
});

test('the posting notes reach the prompt', async () => {
  const client = fakeClient(() => ok(5));
  await anthropic.score([posting({ notes: ['Mentions a sponsorship restriction'] })], opts(client));
  assert.match(client.calls[0].messages[0].content, /Mentions a sponsorship restriction/);
});

test('a null parsed_output degrades that posting only', async () => {
  const client = fakeClient((_req, i) => (i === 0 ? { parsed_output: null, stop_reason: 'end_turn' } : ok(8)));
  const out = await anthropic.score([posting({ id: 'a:1' }), posting({ id: 'a:2' })], opts(client));
  const byId = Object.fromEntries(out.map((p) => [p.id, p]));
  assert.equal(byId['a:1'].score, null);
  assert.match(byId['a:1'].rationale, /not scored/);
  assert.equal(byId['a:2'].score, 8);
});

test('a refusal degrades that posting only', async () => {
  const client = fakeClient((_req, i) => (i === 0
    ? { parsed_output: null, stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'other' } }
    : ok(6)));
  const out = await anthropic.score([posting({ id: 'a:1' }), posting({ id: 'a:2' })], opts(client));
  const byId = Object.fromEntries(out.map((p) => [p.id, p]));
  assert.equal(byId['a:1'].score, null);
  assert.match(byId['a:1'].rationale, /refus/i);
  assert.equal(byId['a:2'].score, 6);
});

test('a thrown request degrades that posting rather than failing the run', async () => {
  const client = fakeClient((_req, i) => { if (i === 0) throw new Error('rate limited'); return ok(4); });
  const out = await anthropic.score([posting({ id: 'a:1' }), posting({ id: 'a:2' })], opts(client));
  assert.equal(out.find((p) => p.id === 'a:1').score, null);
  assert.equal(out.find((p) => p.id === 'a:2').score, 4);
});

test('one result comes back per posting, in input order', async () => {
  const client = fakeClient(() => ok(5));
  const input = [posting({ id: 'a:1' }), posting({ id: 'a:2' }), posting({ id: 'a:3' })];
  const out = await anthropic.score(input, opts(client));
  assert.deepEqual(out.map((p) => p.id), ['a:1', 'a:2', 'a:3']);
});

test('the concurrency cap is respected', async () => {
  let live = 0;
  let peak = 0;
  const client = fakeClient(async () => {
    live += 1;
    peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 5));
    live -= 1;
    return ok(5);
  });
  const input = Array.from({ length: 8 }, (_, i) => posting({ id: `a:${i}` }));
  await anthropic.score(input, opts(client, { concurrency: 2 }));
  assert.ok(peak <= 2, `expected at most 2 in flight, saw ${peak}`);
});

test('a custom rubric file replaces the built-in', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jc-rub-'));
  const rubric = join(dir, 'rubric.md');
  writeFileSync(rubric, 'ONLY SCORE ODD NUMBERS', 'utf8');
  const client = fakeClient(() => ok(5));
  await anthropic.score([posting()], opts(client, { rubric }));
  assert.match(client.calls[0].system[0].text, /ONLY SCORE ODD NUMBERS/);
});

test('an empty posting list makes no requests', async () => {
  const client = fakeClient(() => ok(5));
  assert.deepEqual(await anthropic.score([], opts(client)), []);
  assert.equal(client.calls.length, 0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/scoring.anthropic.test.mjs`
Expected: FAIL — `Cannot find module '../src/scoring/anthropic.mjs'`

- [ ] **Step 3: Write the provider**

Create `src/scoring/anthropic.mjs`:

```js
import { readFileSync } from 'node:fs';
import { ConfigError } from '../config.mjs';
import { DEFAULT_RUBRIC, SCORE_SCHEMA, buildPostingBlock, buildPrefix, unscored } from './prompt.mjs';

const SDK = '@anthropic-ai/sdk';

/**
 * The SDK is an optional peer dependency: someone scoring by keyword should
 * not have to install it. Load it only when a real client is actually needed.
 */
async function createClient() {
  let Anthropic;
  try {
    ({ default: Anthropic } = await import(SDK));
  } catch {
    throw new ConfigError(
      `scoring.provider 'anthropic' needs the ${SDK} package — install it with: npm install ${SDK}`
    );
  }
  return new Anthropic();
}

function readOr(path, fallback, label) {
  if (!path) return fallback;
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigError(`could not read ${label} at ${path}: ${err.message}`);
  }
}

/** Run `jobs` with at most `limit` in flight, preserving input order. */
async function pool(jobs, limit) {
  const results = new Array(jobs.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next;
      next += 1;
      results[i] = await jobs[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

export default {
  id: 'anthropic',

  /**
   * Checked before any site is fetched. Discovering a missing key after
   * paying for a full crawl is the failure this exists to prevent.
   */
  checkPrecondition() {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new ConfigError(
        "scoring.provider 'anthropic' needs ANTHROPIC_API_KEY in the environment"
      );
    }
  },

  async score(postings, opts = {}) {
    if (postings.length === 0) return [];

    const client = opts.client ?? (await createClient());
    const prefix = buildPrefix({
      rubric: readOr(opts.rubric, DEFAULT_RUBRIC, 'scoring.rubric'),
      profile: readOr(opts.profile, '', 'profile'),
    });

    const jobs = postings.map((posting) => async () => {
      try {
        const res = await client.messages.parse({
          model: opts.model,
          max_tokens: 1024,
          system: [{ type: 'text', text: prefix, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: buildPostingBlock(posting) }],
          thinking: { type: 'adaptive' },
          output_config: {
            format: { type: 'json_schema', schema: SCORE_SCHEMA },
            effort: opts.effort,
          },
        });

        // A refusal is a 200 with no parsed output — check stop_reason before
        // reading content, and degrade this posting rather than the run.
        if (res.stop_reason === 'refusal') {
          return unscored(posting, `the model refused (${res.stop_details?.category ?? 'no category'})`);
        }
        if (!res.parsed_output) {
          return unscored(posting, 'the response did not match the score schema');
        }
        return {
          ...posting,
          score: res.parsed_output.score,
          rationale: res.parsed_output.rationale,
          verdict: 'keep',
        };
      } catch (err) {
        return unscored(posting, err.message);
      }
    });

    return pool(jobs, opts.concurrency ?? 5);
  },
};
```

- [ ] **Step 4: Register it**

In `src/scoring/index.mjs`:

```js
import none from './none.mjs';
import anthropic from './anthropic.mjs';

const PROVIDERS = new Map([
  [none.id, none],
  [anthropic.id, anthropic],
]);
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — 17 new tests

- [ ] **Step 6: Commit**

```bash
git add src/scoring/anthropic.mjs src/scoring/index.mjs test/scoring.anthropic.test.mjs
git commit -m "feat: anthropic scoring provider"
```

---

### Task 6: The `claude-cli` provider

**Files:**
- Create: `src/scoring/claude-cli.mjs`
- Modify: `src/scoring/index.mjs` (register it)
- Test: `test/scoring.claude-cli.test.mjs`

**Interfaces:**
- Consumes: the same prompt module
- Produces: provider `{ id: 'claude-cli', checkPrecondition(), score(postings, opts) }`
- `opts.exec` injects the process runner for tests: `exec(prompt) → Promise<string>` returning the CLI's stdout.

Batches ten postings per invocation because each call is a process spawn, not an HTTP request. Batching reintroduces the pairing risk, so results are matched on an echoed id and never on position.

- [ ] **Step 1: Write the failing test**

Create `test/scoring.claude-cli.test.mjs`:

```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/scoring.claude-cli.test.mjs`
Expected: FAIL — `Cannot find module '../src/scoring/claude-cli.mjs'`

- [ ] **Step 3: Write the provider**

Create `src/scoring/claude-cli.mjs`:

```js
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { ConfigError } from '../config.mjs';
import { DEFAULT_RUBRIC, buildPostingBlock, buildPrefix, unscored } from './prompt.mjs';

const execFileAsync = promisify(execFile);
const BATCH = 10;
const TIMEOUT_MS = 180_000;

function readOr(path, fallback, label) {
  if (!path) return fallback;
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigError(`could not read ${label} at ${path}: ${err.message}`);
  }
}

/** Default runner: pipe the prompt to `claude -p` and return its stdout. */
async function runClaude(prompt) {
  const { stdout } = await execFileAsync('claude', ['-p'], {
    input: prompt,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

/** Tolerate a fenced code block around the JSON, which the CLI often adds. */
function parseScores(stdout) {
  const fenced = stdout.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : stdout).trim();
  const data = JSON.parse(body);
  if (!Array.isArray(data.scores)) throw new Error("expected a 'scores' array");
  return data.scores;
}

function buildBatchPrompt(prefix, batch) {
  const blocks = batch.map((p) => `<posting id="${p.id}">\n${buildPostingBlock(p)}\n</posting>`);
  return [
    prefix,
    '',
    '## Postings',
    '',
    ...blocks,
    '',
    '## Output',
    '',
    'Reply with JSON only, no prose and no explanation outside it:',
    '{"scores":[{"id":"<the posting id, copied exactly>","score":<1-10>,"rationale":"<one sentence>"}]}',
    '',
    'Include one entry for every posting above, echoing its id exactly.',
  ].join('\n');
}

export default {
  id: 'claude-cli',

  checkPrecondition() {
    // Presence of the binary is checked lazily by the first invocation; what
    // matters here is failing before the crawl when it is obviously absent.
    if (process.env.JOBCANARY_SKIP_CLI_CHECK === '1') return;
    if (!process.env.PATH) {
      throw new ConfigError("scoring.provider 'claude-cli' needs the claude binary on PATH");
    }
  },

  /**
   * Batches ten postings per invocation: each call is a process spawn of one
   * to two seconds, so per-posting calls would spend a minute doing nothing.
   *
   * Batching reintroduces the pairing risk that the anthropic provider avoids
   * by construction, so results are matched on the echoed id and never on
   * position. A posting the model forgets comes back unscored rather than
   * silently taking another posting's score.
   */
  async score(postings, opts = {}) {
    if (postings.length === 0) return [];

    const exec = opts.exec ?? runClaude;
    const prefix = buildPrefix({
      rubric: readOr(opts.rubric, DEFAULT_RUBRIC, 'scoring.rubric'),
      profile: readOr(opts.profile, '', 'profile'),
    });

    const scored = new Map();
    for (let i = 0; i < postings.length; i += BATCH) {
      const batch = postings.slice(i, i + BATCH);
      try {
        for (const row of parseScores(await exec(buildBatchPrompt(prefix, batch)))) {
          scored.set(row.id, row);
        }
      } catch (err) {
        // This batch is lost; the rest of the run is not.
        for (const p of batch) scored.set(p.id, { id: p.id, error: err.message });
      }
    }

    return postings.map((posting) => {
      const row = scored.get(posting.id);
      if (!row) return unscored(posting, 'the model returned no score for this posting');
      if (row.error) return unscored(posting, row.error);
      return { ...posting, score: row.score, rationale: row.rationale, verdict: 'keep' };
    });
  },
};
```

- [ ] **Step 4: Register it**

In `src/scoring/index.mjs`, add the import and map entry so all three are registered: `none`, `anthropic`, `claude-cli`.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — 11 new tests

- [ ] **Step 6: Commit**

```bash
git add src/scoring/claude-cli.mjs src/scoring/index.mjs test/scoring.claude-cli.test.mjs
git commit -m "feat: claude-cli scoring provider"
```

---

### Task 7: Exit 4, the optional peer dependency, and the docs

**Files:**
- Modify: `bin/jobcanary.mjs`
- Modify: `package.json`
- Modify: `README.md`
- Create: `examples/profile.md`
- Test: `test/cli.test.mjs` (add cases)

**Interfaces:**
- Consumes: `stats.scoringError` from Task 3
- Produces: exit code 4 when scoring failed but a digest was written

- [ ] **Step 1: Write the failing tests**

Append to `test/cli.test.mjs`. The fixture server and `workspace()` helper already exist; add a config writer that selects a failing provider:

```js
test('a scoring failure still writes the digest and exits 4', async () => {
  const { dir, out } = workspace();
  // A provider that cannot possibly work: claude-cli with a profile, driven
  // through a PATH with no claude binary on it.
  const cfg = join(dir, 'scoring.yaml');
  const profile = join(dir, 'profile.md');
  writeFileSync(profile, 'Graduate engineer.', 'utf8');
  writeFileSync(cfg, [
    'output:',
    '  dir: ./out',
    'profile: ./profile.md',
    'scoring:',
    '  provider: claude-cli',
    'sites:',
    `  - {id: vantor, company: Vantor Propulsion, type: workday, host: "${host}", tenant: vantor, board: External}`,
    '',
  ].join('\n'), 'utf8');

  const r = await runCli(['run', '--config', cfg], { cwd: dir, env: { ...process.env, PATH: dir } });
  assert.equal(r.code, 4, 'scoring failed but the crawl succeeded');
  const name = readdirSync(out).find((f) => f.endsWith('.md'));
  assert.ok(name, 'the digest must still be written');
  const md = readFileSync(join(out, name), 'utf8');
  assert.match(md, /\[—\]/, 'postings appear unscored rather than vanishing');
  assert.match(r.stderr, /scoring/i);
});

test('an LLM provider without a profile exits 2 before any fetch', async () => {
  const { dir } = workspace();
  const cfg = join(dir, 'noprofile.yaml');
  writeFileSync(cfg, [
    'output:',
    '  dir: ./out',
    'scoring:',
    '  provider: anthropic',
    'sites:',
    `  - {id: vantor, company: Vantor Propulsion, type: workday, host: "${host}", tenant: vantor, board: External}`,
    '',
  ].join('\n'), 'utf8');

  const r = await runCli(['run', '--config', cfg], { cwd: dir });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /needs 'profile'/);
});
```

`runCli` must forward an `env` option — if it does not already, extend it to pass `env` through to `execFileAsync`.

**If the `PATH` override proves unreliable on Windows** (a stripped `PATH` can
affect more than the `claude` lookup), do not fight it: instead point the
config at `provider: claude-cli` and set the environment variable
`JOBCANARY_CLAUDE_BIN` to a name that cannot exist, and have
`src/scoring/claude-cli.mjs` read that variable in place of the literal
`'claude'` when it is set. That is a one-line change to the provider, it makes
the test deterministic on every platform, and it is genuinely useful to
anyone whose `claude` lives somewhere unusual. Say in your report which route
you took.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/cli.test.mjs`
Expected: FAIL — the run exits 0 with no exit-4 path

- [ ] **Step 3: Add the exit-4 path to `bin/jobcanary.mjs`**

After the digest and `seen.json` are written, and before `return 0`:

```js
  // Scoring failed but the crawl did not: the digest is written unscored so
  // the run's fetch work is not lost, and the exit code says what happened.
  if (stats.scoringError) {
    console.error(`scoring failed: ${stats.scoringError}`);
    console.error('the digest was written with postings unscored');
    return 4;
  }

  return 0;
```

Also add `enrichmentFetches` and the scoring state to the existing summary line only if it is not already there — do not restructure the line.

- [ ] **Step 4: Declare the optional peer dependency**

In `package.json`, add alongside the existing `dependencies`:

```json
  "peerDependencies": {
    "@anthropic-ai/sdk": ">=0.30.0"
  },
  "peerDependenciesMeta": {
    "@anthropic-ai/sdk": { "optional": true }
  }
```

Leave `dependencies` as `yaml` alone. Verify `npm install` still installs exactly one package and `npm test` still passes without the SDK present.

- [ ] **Step 5: Write `examples/profile.md`**

A short, obviously-fictional candidate profile — a graduate mechanical engineer with named tools and target sectors — around 10 lines. It exists so the quickstart works verbatim. Do not use the repo author's real profile.

- [ ] **Step 6: Update `README.md`**

In the scoring providers section, replace the "arriving in a later release" wording with what now exists:

- `none` — default, keyword ranking, no key, no cost.
- `anthropic` — one request per posting, needs `ANTHROPIC_API_KEY` and `npm install @anthropic-ai/sdk`.
- `claude-cli` — free if you already have Claude Code; needs `claude` on `PATH`.

Document `profile` (required for both LLM providers), `scoring.rubric`, `scoring.concurrency`, and that `scoring.batch` defaults to **false** because the Batch API's 24-hour SLA does not suit a daily digest. State that the model scores and ranks but never omits, and that a posting it could not score appears as `[—]` rather than disappearing. Add exit code 4 to the exit-code list. Do not claim the adapter fleet or presets exist.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS — everything green, no network, no API key

- [ ] **Step 8: Commit**

```bash
git add bin/jobcanary.mjs package.json README.md examples/profile.md test/cli.test.mjs
git commit -m "feat: exit 4 on scoring failure, optional sdk peer, and docs"
```

---

## Definition of done

`jobcanary run` with `provider: none` behaves exactly as before. With
`provider: anthropic` and a profile it scores each posting in one cached
request apiece and ranks by fit. With no API key it exits 2 before fetching
anything. When scoring fails it writes an unscored digest and exits 4. The
whole suite passes with no network access and no API key.

## Deferred

- **The Batch API.** The spec describes `batch: true` at half cost for a
  one-off backfill. It is not built here, and Task 4 rejects the key with a
  clear message rather than letting it sit in config doing nothing.
- The adapter fleet and the browser tier
- The `uk-motorsport` preset
- The GitHub Actions daily workflow
- Caching scores across runs
- Everything in the carried-findings section of the Plan 1 plan
