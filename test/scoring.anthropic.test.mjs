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
