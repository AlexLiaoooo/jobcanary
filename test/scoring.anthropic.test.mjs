import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import anthropic, { CLIENT_OPTIONS } from '../src/scoring/anthropic.mjs';
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

/**
 * score() returns `{ scored, usage }`. Most tests here are about the scoring,
 * so they take the postings; the shape itself and the usage numbers are
 * asserted directly on score() in their own tests below.
 */
const scoreOnly = async (postings, o) => (await anthropic.score(postings, o)).scored;

test('registry resolves the anthropic provider', () => {
  assert.equal(getProvider('anthropic').id, 'anthropic');
});

/** Run `fn` with ANTHROPIC_API_KEY set (or removed, for `key === null`). */
async function withKey(key, fn) {
  const saved = process.env.ANTHROPIC_API_KEY;
  if (key === null) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = key;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
}

const missingPath = (name) => join(tmpdir(), 'jc-anthropic-missing', name);

test('checkPrecondition rejects when ANTHROPIC_API_KEY is absent', async () => {
  await withKey(null, () =>
    assert.rejects(() => anthropic.checkPrecondition({ profile: profileFile() }), /ANTHROPIC_API_KEY/));
});

test('checkPrecondition rejects an unreadable profile before the crawl, not at scoring time', async () => {
  await withKey('sk-test', () => assert.rejects(
    () => anthropic.checkPrecondition({ profile: missingPath('no-profile.md'), rubric: null }),
    (err) => {
      assert.equal(err.name, 'ConfigError');
      assert.match(err.message, /could not read profile at/);
      return true;
    }
  ));
});

test('checkPrecondition rejects an unreadable rubric too', async () => {
  await withKey('sk-test', () => assert.rejects(
    () => anthropic.checkPrecondition({ profile: profileFile(), rubric: missingPath('no-rubric.md') }),
    /could not read scoring\.rubric at/
  ));
});

// The optional peer dependency is deliberately absent from this repo's
// install (`npm ls` shows one dependency), so this is the real code path.
// Guarded anyway, for a checkout where someone has installed it.
const sdkInstalled = await import('@anthropic-ai/sdk').then(() => true, () => false);

test('checkPrecondition rejects when the optional SDK is not installed', {
  skip: sdkInstalled ? '@anthropic-ai/sdk is installed in this checkout' : false,
}, async () => {
  await withKey('sk-test', () => assert.rejects(
    () => anthropic.checkPrecondition({ profile: profileFile(), rubric: null }),
    (err) => {
      assert.equal(err.name, 'ConfigError');
      assert.match(err.message, /@anthropic-ai\/sdk/);
      assert.match(err.message, /npm install/);
      return true;
    }
  ));
});

test('the client pins retries and the timeout instead of inheriting them', () => {
  // Left to the SDK, a rate-limited run silently issues 3x the requests it
  // appears to, and a stuck one holds the digest open for the SDK's
  // ten-minute default.
  assert.equal(CLIENT_OPTIONS.maxRetries, 2, 'the retry count must be stated, not inherited');
  assert.ok(Number.isFinite(CLIENT_OPTIONS.timeout), 'the timeout must be stated, not inherited');
  assert.ok(
    CLIENT_OPTIONS.timeout < 10 * 60 * 1000,
    'the timeout must be shorter than the SDK default it exists to replace'
  );
});

test('one request is made per posting', async () => {
  const client = fakeClient(() => ok(7));
  const out = await scoreOnly([posting({ id: 'a:1' }), posting({ id: 'a:2' })], opts(client));
  assert.equal(client.calls.length, 2);
  assert.equal(out.length, 2);
});

test('the score and rationale come back on the posting', async () => {
  const client = fakeClient(() => ok(9, 'strong CFD match'));
  const [out] = await scoreOnly([posting()], opts(client));
  assert.equal(out.id, 'acme:1');
  assert.equal(out.score, 9);
  assert.equal(out.rationale, 'strong CFD match');
  assert.equal(out.verdict, 'keep');
});

test('the cached prefix is byte-identical across every request', async () => {
  const client = fakeClient(() => ok(5));
  await scoreOnly([posting({ id: 'a:1' }), posting({ id: 'a:2' }), posting({ id: 'a:3' })], opts(client));
  const prefixes = client.calls.map((c) => c.system[0].text);
  assert.equal(new Set(prefixes).size, 1, 'a varying prefix silently defeats prompt caching');
});

test('the prefix is marked for caching', async () => {
  const client = fakeClient(() => ok(5));
  await scoreOnly([posting()], opts(client));
  assert.deepEqual(client.calls[0].system[0].cache_control, { type: 'ephemeral' });
});

test('the request asks for the score schema and carries the model and effort', async () => {
  const client = fakeClient(() => ok(5));
  await scoreOnly([posting()], opts(client, { model: 'claude-haiku-4-5', effort: 'low' }));
  const req = client.calls[0];
  assert.equal(req.model, 'claude-haiku-4-5');
  assert.equal(req.output_config.effort, 'low');
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.equal(req.output_config.format.schema.properties.score.maximum, 10);
  assert.deepEqual(req.thinking, { type: 'adaptive' });
});

test('the posting notes reach the prompt', async () => {
  const client = fakeClient(() => ok(5));
  await scoreOnly([posting({ notes: ['Mentions a sponsorship restriction'] })], opts(client));
  assert.match(client.calls[0].messages[0].content, /Mentions a sponsorship restriction/);
});

test('a null parsed_output degrades that posting only', async () => {
  const client = fakeClient((_req, i) => (i === 0 ? { parsed_output: null, stop_reason: 'end_turn' } : ok(8)));
  const out = await scoreOnly([posting({ id: 'a:1' }), posting({ id: 'a:2' })], opts(client));
  const byId = Object.fromEntries(out.map((p) => [p.id, p]));
  assert.equal(byId['a:1'].score, null);
  assert.match(byId['a:1'].rationale, /not scored/);
  assert.equal(byId['a:2'].score, 8);
});

test('a truncated response is named as truncation, not as a schema mismatch', async () => {
  // stop_reason max_tokens also arrives with parsed_output null, so without
  // its own branch it is reported as "the response did not match the score
  // schema" — which sends the reader to the schema instead of to max_tokens.
  const client = fakeClient((_req, i) => (i === 0
    ? { parsed_output: null, stop_reason: 'max_tokens' }
    : ok(6)));
  const out = await scoreOnly([posting({ id: 'a:1' }), posting({ id: 'a:2' })], opts(client));
  const byId = Object.fromEntries(out.map((p) => [p.id, p]));
  assert.equal(byId['a:1'].score, null);
  assert.match(byId['a:1'].rationale, /hit max_tokens/);
  assert.doesNotMatch(byId['a:1'].rationale, /schema/);
  assert.equal(byId['a:2'].score, 6);
});

test('max_tokens leaves room for thinking as well as the answer', async () => {
  // Thinking tokens count against this cap and the default effort is high, so
  // a cap sized for the JSON object alone truncates systematically — and a
  // truncated response is a request billed for its thinking and thrown away.
  // 16000 is the recommended default for a non-streaming request.
  const client = fakeClient(() => ok(5));
  await scoreOnly([posting()], opts(client));
  assert.ok(client.calls[0].max_tokens >= 16_000, `max_tokens was ${client.calls[0].max_tokens}`);
});

test('a refusal degrades that posting only', async () => {
  const client = fakeClient((_req, i) => (i === 0
    ? { parsed_output: null, stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'other' } }
    : ok(6)));
  const out = await scoreOnly([posting({ id: 'a:1' }), posting({ id: 'a:2' })], opts(client));
  const byId = Object.fromEntries(out.map((p) => [p.id, p]));
  assert.equal(byId['a:1'].score, null);
  assert.match(byId['a:1'].rationale, /refus/i);
  assert.equal(byId['a:2'].score, 6);
});

test('a thrown request degrades that posting rather than failing the run', async () => {
  const client = fakeClient((_req, i) => { if (i === 0) throw new Error('rate limited'); return ok(4); });
  const out = await scoreOnly([posting({ id: 'a:1' }), posting({ id: 'a:2' })], opts(client));
  assert.equal(out.find((p) => p.id === 'a:1').score, null);
  assert.equal(out.find((p) => p.id === 'a:2').score, 4);
});

test('one result comes back per posting, in input order', async () => {
  const client = fakeClient(() => ok(5));
  const input = [posting({ id: 'a:1' }), posting({ id: 'a:2' }), posting({ id: 'a:3' })];
  const out = await scoreOnly(input, opts(client));
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
  await scoreOnly(input, opts(client, { concurrency: 2 }));
  assert.ok(peak <= 2, `expected at most 2 in flight, saw ${peak}`);
});

test('a custom rubric file replaces the built-in', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jc-rub-'));
  const rubric = join(dir, 'rubric.md');
  writeFileSync(rubric, 'ONLY SCORE ODD NUMBERS', 'utf8');
  const client = fakeClient(() => ok(5));
  await scoreOnly([posting()], opts(client, { rubric }));
  assert.match(client.calls[0].system[0].text, /ONLY SCORE ODD NUMBERS/);
});

test('an empty posting list makes no requests', async () => {
  const client = fakeClient(() => ok(5));
  assert.deepEqual(await scoreOnly([], opts(client)), []);
  assert.equal(client.calls.length, 0);
});

// --- what the scoring cost -------------------------------------------------
// Prompt caching is the entire economic argument for one request per posting,
// and a prefix below the model's minimum cacheable length is ignored in
// silence. These numbers are the only way anyone finds out.

const withUsage = (score, usage) => ({
  parsed_output: { score, rationale: 'because' }, stop_reason: 'end_turn', usage,
});

test('score reports the requests it made and the cache tokens they used', async () => {
  const client = fakeClient((_req, i) => withUsage(5, {
    cache_read_input_tokens: i === 0 ? 0 : 700,
    cache_creation_input_tokens: i === 0 ? 700 : 0,
  }));
  const res = await anthropic.score(
    [posting({ id: 'a:1' }), posting({ id: 'a:2' }), posting({ id: 'a:3' })],
    opts(client)
  );
  assert.equal(res.scored.length, 3);
  assert.deepEqual(res.usage, { requests: 3, cacheReadTokens: 1400, cacheCreationTokens: 700 });
});

test('a cache that never engages reports zero rather than nothing', async () => {
  // The failure mode this exists for: cache_control on a prefix under the
  // model's minimum is ignored silently, and the only symptom is the bill.
  const client = fakeClient(() => withUsage(5, { cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }));
  const res = await anthropic.score([posting({ id: 'a:1' }), posting({ id: 'a:2' })], opts(client));
  assert.equal(res.usage.cacheReadTokens, 0);
  assert.equal(res.usage.requests, 2);
});

test('a response with no usage block does not break the count', async () => {
  const client = fakeClient(() => ok(5));
  const res = await anthropic.score([posting()], opts(client));
  assert.deepEqual(res.usage, { requests: 1, cacheReadTokens: 0, cacheCreationTokens: 0 });
});

test('a request that failed still counts as a request made', async () => {
  // It was issued, and it may well have been billed.
  const client = fakeClient(() => { throw new Error('rate limited'); });
  const res = await anthropic.score([posting({ id: 'a:1' }), posting({ id: 'a:2' })], opts(client));
  assert.equal(res.usage.requests, 2);
  assert.deepEqual(res.scored.map((p) => p.score), [null, null]);
});
