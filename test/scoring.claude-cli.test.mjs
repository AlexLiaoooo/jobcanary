import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import claudeCli from '../src/scoring/claude-cli.mjs';
import { getProvider } from '../src/scoring/index.mjs';
import { DEFAULT_RUBRIC } from '../src/scoring/prompt.mjs';

const PROFILE_TEXT = 'Graduate mechanical engineer. SENTINEL-PROFILE-MARKER.';

function profileFile() {
  const dir = mkdtempSync(join(tmpdir(), 'jc-prof-'));
  const p = join(dir, 'profile.md');
  writeFileSync(p, PROFILE_TEXT, 'utf8');
  return p;
}

/**
 * Write a stand-in for the `claude` binary that runs `body` under this Node.
 *
 * Spawned as a real child process, because the defect this exists to catch is
 * "the default runner is never executed": every other test in this file
 * injects `opts.exec`, so the code that actually talks to a child process had
 * no coverage at all, and shipped a prompt that never reached its stdin.
 *
 * Windows needs the .cmd wrapper (a bare .mjs is not executable there);
 * everything else gets a shebang wrapper, so both spawn paths are exercised
 * on the platform they run on.
 */
function stubClaude(body) {
  const dir = mkdtempSync(join(tmpdir(), 'jc-stub-'));
  const js = join(dir, 'stub.mjs');
  writeFileSync(js, body, 'utf8');
  if (process.platform === 'win32') {
    const cmd = join(dir, 'stub.cmd');
    writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`, 'utf8');
    return cmd;
  }
  const sh = join(dir, 'stub.sh');
  writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`, 'utf8');
  chmodSync(sh, 0o755);
  return sh;
}

/** Point the provider's default runner at a stub for the duration of `fn`. */
async function withStubBin(bin, fn) {
  const saved = process.env.JOBCANARY_CLAUDE_BIN;
  process.env.JOBCANARY_CLAUDE_BIN = bin;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.JOBCANARY_CLAUDE_BIN;
    else process.env.JOBCANARY_CLAUDE_BIN = saved;
  }
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

/**
 * score() returns `{ scored, usage }`. Most tests here are about the scoring,
 * so they take the postings; the shape itself is asserted on score() directly
 * in its own test below.
 */
const scoreOnly = async (postings, o) => (await claudeCli.score(postings, o)).scored;

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
  const out = await scoreOnly([posting('a:1'), posting('a:2')], opts(exec));
  const byId = Object.fromEntries(out.map((p) => [p.id, p]));
  assert.equal(byId['a:1'].score, 3);
  assert.equal(byId['a:1'].rationale, 'first posting');
  assert.equal(byId['a:2'].score, 9);
});

test('a posting missing from the response comes back unscored, not dropped', async () => {
  const exec = fakeExec(() => scoresFor(['a:1']));
  const out = await scoreOnly([posting('a:1'), posting('a:2')], opts(exec));
  assert.equal(out.length, 2);
  assert.equal(out.find((p) => p.id === 'a:2').score, null);
  assert.match(out.find((p) => p.id === 'a:2').rationale, /not scored/);
});

test('an unknown id in the response is ignored rather than added', async () => {
  const exec = fakeExec(() => JSON.stringify({
    scores: [{ id: 'a:1', score: 5, rationale: 'r' }, { id: 'ghost', score: 9, rationale: 'r' }],
  }));
  const out = await scoreOnly([posting('a:1')], opts(exec));
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'a:1');
});

// The model's answer arrives as raw JSON.parse output, so every one of these
// would otherwise reach the digest: [undefined/10], [47/10], or a score the
// comparator cannot order at all.
for (const [label, row] of [
  ['a missing score', { id: 'a:1', rationale: 'r' }],
  ['a null score', { id: 'a:1', score: null, rationale: 'r' }],
  ['a score above the range', { id: 'a:1', score: 47, rationale: 'r' }],
  ['a score below the range', { id: 'a:1', score: 0, rationale: 'r' }],
  ['a fractional score', { id: 'a:1', score: 7.5, rationale: 'r' }],
  ['a string score', { id: 'a:1', score: 'strong', rationale: 'r' }],
  ['a numeric string score', { id: 'a:1', score: '8', rationale: 'r' }],
  ['a missing rationale', { id: 'a:1', score: 8 }],
  ['a non-string rationale', { id: 'a:1', score: 8, rationale: 42 }],
]) {
  test(`${label} comes back unscored rather than trusted`, async () => {
    const exec = fakeExec(() => JSON.stringify({ scores: [row] }));
    const [out] = await scoreOnly([posting('a:1')], opts(exec));
    assert.equal(out.score, null, `${label} must not reach the digest`);
    assert.equal(out.verdict, 'keep');
    assert.match(out.rationale, /not scored: the model returned an invalid score/);
  });
}

test('a valid score at each end of the range is accepted', async () => {
  for (const score of [1, 10]) {
    const exec = fakeExec(() => JSON.stringify({ scores: [{ id: 'a:1', score, rationale: 'r' }] }));
    const [out] = await scoreOnly([posting('a:1')], opts(exec));
    assert.equal(out.score, score);
  }
});

test('postings are batched ten to an invocation', async () => {
  const ids = Array.from({ length: 25 }, (_, i) => `a:${i}`);
  const exec = fakeExec((prompt) => {
    const inBatch = ids.filter((id) => prompt.includes(id));
    return scoresFor(inBatch);
  });
  const out = await scoreOnly(ids.map((id) => posting(id)), opts(exec));
  assert.equal(exec.calls.length, 3, '25 postings should take 3 invocations of 10');
  assert.equal(out.length, 25);
});

test('unparseable output degrades that batch only', async () => {
  const exec = fakeExec((_p, i) => (i === 0 ? 'not json at all' : scoresFor(['a:10'])));
  const input = [...Array.from({ length: 10 }, (_, i) => posting(`a:${i}`)), posting('a:10')];
  const out = await scoreOnly(input, opts(exec));
  assert.equal(out.length, 11);
  assert.equal(out.find((p) => p.id === 'a:0').score, null);
  assert.equal(out.find((p) => p.id === 'a:10').score, 6);
});

test('a thrown invocation degrades that batch only', async () => {
  const exec = fakeExec((_p, i) => { if (i === 0) throw new Error('claude not found'); return scoresFor(['a:10']); });
  const input = [...Array.from({ length: 10 }, (_, i) => posting(`a:${i}`)), posting('a:10')];
  const out = await scoreOnly(input, opts(exec));
  assert.equal(out.length, 11);
  assert.match(out.find((p) => p.id === 'a:0').rationale, /claude not found/);
});

test('the prompt carries the rubric, the profile and each posting id', async () => {
  const exec = fakeExec(() => scoresFor(['a:1']));
  await scoreOnly([posting('a:1')], opts(exec));
  // The rubric half of this test's name used to be unasserted: a prompt with
  // no scoring instructions at all would have passed it.
  assert.match(exec.calls[0], /Give the posting a fit score from 1 to 10/);
  assert.match(exec.calls[0], /Score every posting you are given/);
  assert.ok(
    exec.calls[0].includes(DEFAULT_RUBRIC),
    'the built-in rubric should reach the model verbatim when none is configured'
  );
  assert.match(exec.calls[0], /Graduate mechanical engineer/);
  assert.match(exec.calls[0], /a:1/);
});

test('a configured rubric replaces the built-in one in the prompt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jc-rub-'));
  const rubric = join(dir, 'rubric.md');
  writeFileSync(rubric, 'ONLY SCORE ODD NUMBERS', 'utf8');
  const exec = fakeExec(() => scoresFor(['a:1']));
  await scoreOnly([posting('a:1')], opts(exec, { rubric }));
  assert.match(exec.calls[0], /ONLY SCORE ODD NUMBERS/);
  assert.doesNotMatch(exec.calls[0], /Give the posting a fit score/);
});

test('output wrapped in a fenced code block is still parsed', async () => {
  const exec = fakeExec(() => '```json\n' + scoresFor(['a:1'], 8) + '\n```');
  const out = await scoreOnly([posting('a:1')], opts(exec));
  assert.equal(out[0].score, 8);
});

test('one result comes back per posting, in input order', async () => {
  const exec = fakeExec(() => scoresFor(['a:1', 'a:2', 'a:3']));
  const out = await scoreOnly([posting('a:1'), posting('a:2'), posting('a:3')], opts(exec));
  assert.deepEqual(out.map((p) => p.id), ['a:1', 'a:2', 'a:3']);
});

test('an empty posting list makes no invocations', async () => {
  const exec = fakeExec(() => scoresFor([]));
  assert.deepEqual(await scoreOnly([], opts(exec)), []);
  assert.equal(exec.calls.length, 0);
});

test('score reports one request per invocation, and no cache figures', async () => {
  // 25 postings is three invocations of ten, and what the `claude` process
  // does with the prompt is not observable from here — so the cache fields are
  // absent rather than reported as a zero nobody measured.
  const ids = Array.from({ length: 25 }, (_, i) => `a:${i}`);
  const exec = fakeExec((prompt) => scoresFor(ids.filter((id) => prompt.includes(id))));
  const res = await claudeCli.score(ids.map((id) => posting(id)), opts(exec));
  assert.equal(res.scored.length, 25);
  assert.deepEqual(res.usage, { requests: 3 });
});

test('a batch that failed still counts as a request made', async () => {
  const exec = fakeExec(() => { throw new Error('claude not found'); });
  const res = await claudeCli.score([posting('a:1')], opts(exec));
  assert.equal(res.usage.requests, 1);
});

// --- the default runner, executed for real ---------------------------------
// The only tests in this file that spawn a process. They exist because every
// test above injects `opts.exec`, which left the real runner — the one thing
// that has to talk to a child process — with no coverage whatsoever.

const ECHO_STUB = `
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { buf += c; });
process.stdin.on('end', () => {
  const ids = [...buf.matchAll(/<posting id="([^"]+)">/g)].map((m) => m[1]);
  process.stdout.write(JSON.stringify({
    scores: ids.map((id) => ({
      id,
      score: buf.includes('SENTINEL-PROFILE-MARKER') ? 7 : 1,
      rationale: 'read ' + buf.length + ' characters of prompt',
    })),
  }));
});
`;

test('the default runner writes the prompt to the child on stdin', async () => {
  const bin = stubClaude(ECHO_STUB);
  // No opts.exec: this goes through runClaude and a real spawn.
  const out = await withStubBin(bin, () =>
    scoreOnly([posting('a:1'), posting('a:2')], { profile: profileFile(), rubric: null }));

  // The stub knows the ids and the profile marker only by reading its stdin,
  // so a score of 7 on both is proof the whole prompt round-tripped.
  assert.deepEqual(out.map((p) => p.id), ['a:1', 'a:2']);
  assert.deepEqual(out.map((p) => p.score), [7, 7]);
  assert.match(out[0].rationale, /read \d{3,} characters of prompt/);
});

test('checkPrecondition accepts a binary that answers --version', async () => {
  const bin = stubClaude("process.stdout.write('1.2.3');");
  await withStubBin(bin, () =>
    claudeCli.checkPrecondition({ profile: profileFile(), rubric: null }));
});

test('checkPrecondition rejects a binary that is not there', async () => {
  await withStubBin('jobcanary-claude-does-not-exist', () => assert.rejects(
    () => claudeCli.checkPrecondition({ profile: profileFile(), rubric: null }),
    (err) => {
      assert.equal(err.name, 'ConfigError');
      assert.match(err.message, /could not run 'jobcanary-claude-does-not-exist'/);
      assert.match(err.message, /JOBCANARY_CLAUDE_BIN/);
      return true;
    }
  ));
});

test('checkPrecondition rejects a binary that runs but fails', async () => {
  const bin = stubClaude('process.exit(1);');
  await withStubBin(bin, () => assert.rejects(
    () => claudeCli.checkPrecondition({ profile: profileFile(), rubric: null }),
    /could not run/
  ));
});

test('checkPrecondition rejects an unreadable profile without spawning anything', async () => {
  // The binary name cannot resolve, so if this reached the probe it would
  // report the binary rather than the profile: the files are checked first.
  await withStubBin('jobcanary-claude-does-not-exist', () => assert.rejects(
    () => claudeCli.checkPrecondition({
      profile: join(tmpdir(), 'jc-cli-missing', 'no-profile.md'),
      rubric: null,
    }),
    (err) => {
      assert.equal(err.name, 'ConfigError');
      assert.match(err.message, /could not read profile at/);
      return true;
    }
  ));
});

test('the default runner reports a non-zero exit rather than hanging', async () => {
  const bin = stubClaude("process.stderr.write('stub refused'); process.exit(3);");
  const out = await withStubBin(bin, () =>
    scoreOnly([posting('a:1')], { profile: profileFile(), rubric: null }));
  assert.equal(out[0].score, null);
  assert.match(out[0].rationale, /claude exited 3/);
  assert.match(out[0].rationale, /stub refused/);
});
