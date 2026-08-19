import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, compileMatcher, ConfigError } from '../src/config.mjs';

test('compileMatcher treats a plain string as a case-insensitive literal', () => {
  const re = compileMatcher('head of');
  assert.ok(re.test('HEAD OF Aerodynamics'));
  assert.ok(!re.test('headof'));
});

test('compileMatcher escapes regex metacharacters in literals', () => {
  const re = compileMatcher('c++');
  assert.ok(re.test('Senior C++ Engineer'));
});

test('compileMatcher parses /body/flags as a real regex', () => {
  const re = compileMatcher('/\\b\\d+\\+ years\\b/i');
  assert.ok(re.test('needs 5+ years'));
  assert.ok(!re.test('needs experience'));
});

test('parseConfig applies defaults for omitted sections', () => {
  const cfg = parseConfig('sites:\n  - {id: a, company: A, type: greenhouse, board: acme}\n', '/base');
  assert.equal(cfg.scoring.provider, 'none');
  assert.equal(cfg.output.format, 'markdown');
  assert.equal(cfg.dedupe.retentionDays, 30);
  assert.deepEqual(cfg.rules.exclude, []);
});

test('parseConfig compiles rule matchers to regexes', () => {
  const cfg = parseConfig(`
sites:
  - {id: a, company: A, type: greenhouse, board: acme}
rules:
  exclude:
    - {id: senior, field: title, match: ["head of"]}
  annotate:
    - {id: rtw, field: description, match: ["no sponsorship"], note: "Check eligibility"}
`, '/base');
  assert.ok(cfg.rules.exclude[0].match[0] instanceof RegExp);
  assert.equal(cfg.rules.annotate[0].note, 'Check eligibility');
});

test('parseConfig rejects config with no sites', () => {
  assert.throws(() => parseConfig('scoring: {provider: none}\n', '/base'), ConfigError);
});

test('parseConfig rejects a site missing an id', () => {
  assert.throws(() => parseConfig('sites:\n  - {company: A, type: greenhouse}\n', '/base'), ConfigError);
});

test('parseConfig rejects duplicate site ids', () => {
  const yaml = 'sites:\n  - {id: a, company: A, type: greenhouse, board: x}\n  - {id: a, company: B, type: lever, board: y}\n';
  assert.throws(() => parseConfig(yaml, '/base'), ConfigError);
});

test('parseConfig rejects an unknown scoring provider', () => {
  const yaml = 'scoring: {provider: wishful}\nsites:\n  - {id: a, company: A, type: greenhouse, board: x}\n';
  assert.throws(() => parseConfig(yaml, '/base'), ConfigError);
});

test('parseConfig defaults site.enabled to true and honours false', () => {
  const yaml = 'sites:\n  - {id: a, company: A, type: greenhouse, board: x}\n  - {id: b, company: B, type: lever, board: y, enabled: false}\n';
  const cfg = parseConfig(yaml, '/base');
  assert.equal(cfg.sites[0].enabled, true);
  assert.equal(cfg.sites[1].enabled, false);
});

test('parseConfig rejects a non-array rules.exclude', () => {
  const yaml = 'sites:\n  - {id: a, company: A, type: greenhouse, board: x}\nrules:\n  exclude: {id: senior, field: title, match: ["x"]}\n';
  assert.throws(() => parseConfig(yaml, '/base'), ConfigError);
});

test('parseConfig rejects a non-array rules.annotate', () => {
  const yaml = 'sites:\n  - {id: a, company: A, type: greenhouse, board: x}\nrules:\n  annotate: {id: rtw, field: title, match: ["x"], note: "n"}\n';
  assert.throws(() => parseConfig(yaml, '/base'), ConfigError);
});

test('compileMatcher honours the flags given and does not force case-insensitivity', () => {
  const sensitive = compileMatcher('/PhD/');
  assert.ok(sensitive.test('a PhD required'));
  assert.ok(!sensitive.test('a phd required'));
  assert.ok(compileMatcher('/PhD/i').test('a phd required'));
});

test('compileMatcher strips the stateful g and y flags so a matcher is reusable', () => {
  const re = compileMatcher('/senior/gi');
  assert.equal(re.flags, 'i');
  // Three, not two: an off-by-one alternation would still pass a two-call check.
  assert.ok(re.test('Senior Engineer'));
  assert.ok(re.test('Senior Engineer'));
  assert.ok(re.test('Senior Engineer'));
  assert.equal(re.lastIndex, 0);
});

test('compileMatcher keeps the non-stateful flags alongside a stripped one', () => {
  const re = compileMatcher('/a.b/gis');
  assert.equal(re.flags, 'is');
  assert.ok(re.test('A\nB'));
  assert.ok(re.test('A\nB'));
});

test('parseConfig rejects a non-string profile as a config error, not a TypeError', () => {
  assert.throws(
    () => parseConfig('profile: 2026\nsites:\n  - {id: a, company: A, type: greenhouse, board: x}\n', 'base'),
    (err) => err instanceof ConfigError && /profile must be a string path, got number/.test(err.message)
  );
});

test('parseConfig rejects a non-string output.dir as a config error, not a TypeError', () => {
  assert.throws(
    () => parseConfig('output: {dir: 2026}\nsites:\n  - {id: a, company: A, type: greenhouse, board: x}\n', 'base'),
    (err) => err instanceof ConfigError && /output\.dir must be a string path, got number/.test(err.message)
  );
});

test('parseConfig still accepts an omitted or null profile and output.dir', () => {
  const cfg = parseConfig('profile: ~\noutput: {dir: ~}\nsites:\n  - {id: a, company: A, type: greenhouse, board: x}\n', 'base');
  assert.equal(cfg.profile, null);
  assert.match(cfg.output.dir, /digests$/);
});
