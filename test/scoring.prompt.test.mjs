import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_RUBRIC,
  buildPrefix,
  buildPrefixFromSources,
  buildPostingBlock,
  SCORE_SCHEMA,
  unscored,
} from '../src/scoring/prompt.mjs';
import { ConfigError } from '../src/config.mjs';

function tempFile(name, contents) {
  const dir = mkdtempSync(join(tmpdir(), 'jc-prompt-'));
  const p = join(dir, name);
  writeFileSync(p, contents, 'utf8');
  return p;
}

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

test('buildPrefixFromSources falls back to DEFAULT_RUBRIC when both paths are null', () => {
  const out = buildPrefixFromSources({ rubric: null, profile: null });
  assert.match(out, new RegExp(DEFAULT_RUBRIC.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('buildPrefixFromSources reads a real rubric file instead of the default', () => {
  const rubricPath = tempFile('rubric.md', 'CUSTOM RUBRIC TEXT');
  const out = buildPrefixFromSources({ rubric: rubricPath, profile: null });
  assert.match(out, /CUSTOM RUBRIC TEXT/);
  assert.doesNotMatch(out, /Give the posting a fit score/);
});

test('buildPrefixFromSources reads a real profile file', () => {
  const profilePath = tempFile('profile.md', 'CUSTOM PROFILE TEXT');
  const out = buildPrefixFromSources({ rubric: null, profile: profilePath });
  assert.match(out, /CUSTOM PROFILE TEXT/);
});

test('an unreadable rubric path throws ConfigError naming scoring.rubric and the path', () => {
  const badPath = join(tmpdir(), 'jc-prompt-missing', 'no-such-rubric.md');
  assert.throws(
    () => buildPrefixFromSources({ rubric: badPath, profile: null }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /could not read scoring\.rubric at/);
      assert.match(err.message, new RegExp(badPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    }
  );
});

test('an unreadable profile path throws ConfigError naming profile and the path', () => {
  const badPath = join(tmpdir(), 'jc-prompt-missing', 'no-such-profile.md');
  assert.throws(
    () => buildPrefixFromSources({ rubric: null, profile: badPath }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /could not read profile at/);
      assert.match(err.message, new RegExp(badPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    }
  );
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
