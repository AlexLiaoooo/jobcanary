# jobcanary Core Implementation Plan (Plan 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working `jobcanary run` that polls real ATS job boards, applies user-defined rules, deduplicates across runs, ranks postings without an LLM, and writes a Markdown digest.

**Architecture:** ESM library with a thin CLI. Pure functions for config, rules, dedup, ranking, and rendering; impure work confined to adapters (network) and the pipeline (disk). Adapters sit behind one interface and a registry, so Plan 2 adds ten more without touching the pipeline.

**Tech Stack:** Node 20+, ESM, `node --test`, `node:util` `parseArgs`. One runtime dependency: `yaml`. No test framework, no bundler, no TypeScript.

**Spec:** `docs/superpowers/specs/2026-08-19-jobcanary-design.md`

## Global Constraints

- Node 20 or later. ESM only (`"type": "module"`). No CommonJS.
- Exactly one runtime dependency in Plan 1: `yaml`. Do not add others.
- Never use `Date.now()` or `new Date()` inside pure functions — the caller passes `today` explicitly, so tests are deterministic.
- All network access goes through `ctx.http`, never a bare global `fetch`. Tests inject a stub.
- No absolute paths, no personal names, no real company data in source or fixtures. Fixtures use fictional companies.
- Exit codes: `0` ok · `1` unexpected · `2` config invalid · `3` all sites failed · `4` scoring failed (digest still written). **Exit 4 is not implemented in Plan 1** — the `none` provider is pure and cannot fail. Plan 3 adds it with the `anthropic` provider.
- Every posting id is `${site.id}:${nativeId}`.
- Commit after every task.

**Spec amendment made by this plan:** the spec did not define how the `none` scoring provider ranks. This plan adds `scoring.keywords: string[]`, used *only* by that provider. Update the spec's config block when Task 8 lands.

---

### Task 1: Project scaffold and config loader

**Files:**
- Create: `package.json`
- Create: `src/config.mjs`
- Test: `test/config.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `class ConfigError extends Error` — thrown on any invalid config
  - `compileMatcher(spec: string) → RegExp` — literal substring by default; `/body/flags` syntax produces a real regex
  - `parseConfig(text: string, baseDir: string) → Config`
  - `loadConfig(filePath: string) → Config`
  - `Config` = `{ profile, scoring: {provider, model, effort, batch, keywords}, output: {dir, format}, dedupe: {retentionDays}, rules: {exclude: Rule[], annotate: AnnotateRule[]}, sites: Site[] }`
  - `Rule` = `{ id, field, match: RegExp[] }`
  - `AnnotateRule` = `{ id, field, match: RegExp[], note: string }`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "jobcanary",
  "version": "0.1.0",
  "description": "Config-driven job monitor: polls career sites and ATS boards, filters, scores, and writes a ranked digest.",
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=20" },
  "bin": { "jobcanary": "bin/jobcanary.mjs" },
  "exports": { ".": "./src/index.mjs" },
  "scripts": {
    "test": "node --test test/*.test.mjs"
  },
  "dependencies": {
    "yaml": "^2.5.0"
  }
}
```

Then run `npm install`.

- [ ] **Step 2: Write the failing test**

Create `test/config.test.mjs`:

```js
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

test('compileMatcher honours the flags given and does not force case-insensitivity', () => {
  const sensitive = compileMatcher('/PhD/');
  assert.ok(sensitive.test('a PhD required'));
  assert.ok(!sensitive.test('a phd required'));
  assert.ok(compileMatcher('/PhD/i').test('a phd required'));
});

test('parseConfig rejects a non-array rules.exclude', () => {
  const yaml = 'sites:\n  - {id: a, company: A, type: greenhouse, board: x}\nrules:\n  exclude: {id: senior, field: title, match: ["x"]}\n';
  assert.throws(() => parseConfig(yaml, '/base'), ConfigError);
});

test('parseConfig rejects a non-array rules.annotate', () => {
  const yaml = 'sites:\n  - {id: a, company: A, type: greenhouse, board: x}\nrules:\n  annotate: {id: rtw, field: title, match: ["x"], note: "n"}\n';
  assert.throws(() => parseConfig(yaml, '/base'), ConfigError);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/config.mjs'`

- [ ] **Step 4: Write the implementation**

Create `src/config.mjs`:

```js
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const PROVIDERS = ['none', 'anthropic', 'claude-cli'];
const FORMATS = ['markdown', 'json', 'both'];
const FIELDS = ['title', 'company', 'location', 'description', 'all'];

const escapeLiteral = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Compile one match specification into a RegExp.
 *
 * A plain string is matched case-insensitively as a literal, which is what a
 * rule author almost always wants. The '/body/flags' form is the escape hatch
 * for precision and uses exactly the flags given — '/PhD/' is case-sensitive,
 * '/PhD/i' is not.
 */
export function compileMatcher(spec) {
  if (typeof spec !== 'string' || spec.length === 0) {
    throw new ConfigError(`match entries must be non-empty strings, got: ${JSON.stringify(spec)}`);
  }
  const m = spec.match(/^\/(.*)\/([gimsuy]*)$/s);
  if (m) {
    try {
      return new RegExp(m[1], m[2]);
    } catch (err) {
      throw new ConfigError(`invalid regex ${spec}: ${err.message}`);
    }
  }
  return new RegExp(escapeLiteral(spec), 'i');
}

function compileRule(raw, kind, index) {
  const where = `rules.${kind}[${index}]`;
  if (!raw || typeof raw !== 'object') throw new ConfigError(`${where} must be an object`);
  if (!raw.id) throw new ConfigError(`${where} is missing 'id'`);
  const field = raw.field ?? 'all';
  if (!FIELDS.includes(field)) {
    throw new ConfigError(`${where}.field must be one of ${FIELDS.join(', ')}, got '${field}'`);
  }
  if (!Array.isArray(raw.match) || raw.match.length === 0) {
    throw new ConfigError(`${where} needs a non-empty 'match' array`);
  }
  const rule = { id: raw.id, field, match: raw.match.map(compileMatcher) };
  if (kind === 'annotate') {
    if (!raw.note) throw new ConfigError(`${where} is missing 'note'`);
    rule.note = raw.note;
  }
  return rule;
}

function validateSite(raw, index, seenIds) {
  const where = `sites[${index}]`;
  if (!raw || typeof raw !== 'object') throw new ConfigError(`${where} must be an object`);
  if (!raw.id) throw new ConfigError(`${where} is missing 'id'`);
  if (!raw.type) throw new ConfigError(`${where} ('${raw.id}') is missing 'type'`);
  if (!raw.company) throw new ConfigError(`${where} ('${raw.id}') is missing 'company'`);
  if (seenIds.has(raw.id)) throw new ConfigError(`duplicate site id '${raw.id}'`);
  seenIds.add(raw.id);
  return { ...raw, enabled: raw.enabled !== false };
}

export function parseConfig(text, baseDir) {
  let raw;
  try {
    raw = parseYaml(text) ?? {};
  } catch (err) {
    throw new ConfigError(`could not parse YAML: ${err.message}`);
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('config root must be a mapping');
  }

  if (!Array.isArray(raw.sites) || raw.sites.length === 0) {
    throw new ConfigError("config needs a non-empty 'sites' list");
  }

  const scoring = {
    provider: raw.scoring?.provider ?? 'none',
    model: raw.scoring?.model ?? 'claude-opus-5',
    effort: raw.scoring?.effort ?? 'high',
    batch: raw.scoring?.batch ?? true,
    keywords: raw.scoring?.keywords ?? [],
  };
  if (!PROVIDERS.includes(scoring.provider)) {
    throw new ConfigError(`scoring.provider must be one of ${PROVIDERS.join(', ')}, got '${scoring.provider}'`);
  }
  if (!Array.isArray(scoring.keywords)) throw new ConfigError('scoring.keywords must be a list');

  const output = {
    dir: resolve(baseDir, raw.output?.dir ?? './digests'),
    format: raw.output?.format ?? 'markdown',
  };
  if (!FORMATS.includes(output.format)) {
    throw new ConfigError(`output.format must be one of ${FORMATS.join(', ')}, got '${output.format}'`);
  }

  const retentionDays = raw.dedupe?.retentionDays ?? 30;
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new ConfigError('dedupe.retentionDays must be a positive integer');
  }

  // Guard before mapping: a non-nullish non-array (`exclude: {…}`, i.e. a
  // forgotten list dash) slips past `?? []` and would throw a raw TypeError,
  // which escapes as exit 1 instead of the exit 2 the config contract promises.
  const ruleList = (value, kind) => {
    const list = value ?? [];
    if (!Array.isArray(list)) throw new ConfigError(`rules.${kind} must be a list`);
    return list;
  };

  const seenIds = new Set();
  return {
    profile: raw.profile ? resolve(baseDir, raw.profile) : null,
    scoring,
    output,
    dedupe: { retentionDays },
    rules: {
      exclude: ruleList(raw.rules?.exclude, 'exclude').map((r, i) => compileRule(r, 'exclude', i)),
      annotate: ruleList(raw.rules?.annotate, 'annotate').map((r, i) => compileRule(r, 'annotate', i)),
    },
    sites: raw.sites.map((s, i) => validateSite(s, i, seenIds)),
  };
}

export function loadConfig(filePath) {
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new ConfigError(`could not read config at ${filePath}: ${err.message}`);
  }
  return parseConfig(text, dirname(resolve(filePath)));
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — 13 config tests

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/config.mjs test/config.test.mjs
git commit -m "feat: config loader with validation and matcher compilation"
```

---

### Task 2: Rules engine

**Files:**
- Create: `src/rules.mjs`
- Test: `test/rules.test.mjs`

**Interfaces:**
- Consumes: `Rule` and `AnnotateRule` from Task 1
- Produces: `applyRules(posting, rules) → { keep: boolean, excludedBy: string|null, notes: string[] }`

Exclude rules are evaluated first and short-circuit. Annotate rules never drop a posting — this is the spec's "flag, don't block" requirement, and it is the reason the two rule kinds exist.

- [ ] **Step 1: Write the failing test**

Create `test/rules.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRules } from '../src/rules.mjs';
import { compileMatcher } from '../src/config.mjs';

const rule = (id, field, ...m) => ({ id, field, match: m.map(compileMatcher) });
const note = (id, field, text, ...m) => ({ ...rule(id, field, ...m), note: text });

const posting = (over = {}) => ({
  id: 'x:1', title: 'Graduate Design Engineer', company: 'Acme Dynamics',
  location: 'Oxford, UK', url: 'https://example.test/1', postedAt: null,
  description: 'Looking for a graduate engineer.', source: 'x', notes: [], ...over,
});

test('a posting with no rules is kept', () => {
  const r = applyRules(posting(), { exclude: [], annotate: [] });
  assert.deepEqual(r, { keep: true, excludedBy: null, notes: [] });
});

test('an exclude rule matching the title drops the posting', () => {
  const r = applyRules(posting({ title: 'Head of Aerodynamics' }), {
    exclude: [rule('senior', 'title', 'head of')], annotate: [],
  });
  assert.equal(r.keep, false);
  assert.equal(r.excludedBy, 'senior');
});

test('an exclude rule scoped to title ignores a match in the description', () => {
  const r = applyRules(posting({ description: 'reports to the head of engineering' }), {
    exclude: [rule('senior', 'title', 'head of')], annotate: [],
  });
  assert.equal(r.keep, true);
});

test("field 'all' searches every text field", () => {
  const r = applyRules(posting({ description: 'no sponsorship available' }), {
    exclude: [rule('nosp', 'all', 'no sponsorship')], annotate: [],
  });
  assert.equal(r.keep, false);
});

test('an annotate rule adds a note but keeps the posting', () => {
  const r = applyRules(posting({ description: 'no sponsorship available' }), {
    exclude: [],
    annotate: [note('rtw', 'description', 'Check eligibility', 'no sponsorship')],
  });
  assert.equal(r.keep, true);
  assert.deepEqual(r.notes, ['Check eligibility']);
});

test('an excluded posting is not annotated', () => {
  const r = applyRules(posting({ title: 'Head of Aero', description: 'no sponsorship' }), {
    exclude: [rule('senior', 'title', 'head of')],
    annotate: [note('rtw', 'description', 'Check eligibility', 'no sponsorship')],
  });
  assert.equal(r.keep, false);
  assert.deepEqual(r.notes, []);
});

test('multiple annotate rules accumulate in declaration order', () => {
  const r = applyRules(posting({ description: 'no sponsorship, 5+ years required' }), {
    exclude: [],
    annotate: [
      note('rtw', 'all', 'Check eligibility', 'no sponsorship'),
      note('exp', 'all', 'Experience gap', '/\\d\\+ years/i'),
    ],
  });
  assert.deepEqual(r.notes, ['Check eligibility', 'Experience gap']);
});

test('a rule matches when any of its match entries hits', () => {
  const r = applyRules(posting({ title: 'Principal Engineer' }), {
    exclude: [rule('senior', 'title', 'head of', 'principal')], annotate: [],
  });
  assert.equal(r.keep, false);
});

test('a missing field is treated as empty, not an error', () => {
  const r = applyRules(posting({ description: undefined }), {
    exclude: [rule('x', 'description', 'anything')], annotate: [],
  });
  assert.equal(r.keep, true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/rules.test.mjs`
Expected: FAIL — `Cannot find module '../src/rules.mjs'`

- [ ] **Step 3: Write the implementation**

Create `src/rules.mjs`:

```js
/**
 * Resolve the text a rule should search. 'all' concatenates every text field,
 * which is why it is the default: a rule author who does not say where to look
 * means "anywhere".
 */
function fieldText(posting, field) {
  if (field === 'all') {
    return [posting.title, posting.company, posting.location, posting.description]
      .filter(Boolean).join('\n');
  }
  return posting[field] ?? '';
}

function matches(posting, rule) {
  const text = fieldText(posting, rule.field);
  if (!text) return false;
  return rule.match.some((re) => re.test(text));
}

/**
 * Apply exclude and annotate rules to one posting.
 *
 * Exclude rules short-circuit: the first match drops the posting and no
 * annotations are computed. Annotate rules never drop anything — they attach a
 * note so a later scoring stage can judge with full context instead of a
 * keyword guess.
 *
 * @param {object} posting
 * @param {{exclude: object[], annotate: object[]}} rules
 * @returns {{keep: boolean, excludedBy: string|null, notes: string[]}}
 */
export function applyRules(posting, rules) {
  for (const rule of rules.exclude ?? []) {
    if (matches(posting, rule)) {
      return { keep: false, excludedBy: rule.id, notes: [] };
    }
  }
  const notes = [];
  for (const rule of rules.annotate ?? []) {
    if (matches(posting, rule)) notes.push(rule.note);
  }
  return { keep: true, excludedBy: null, notes };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/rules.test.mjs`
Expected: PASS — 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/rules.mjs test/rules.test.mjs
git commit -m "feat: rules engine with exclude and annotate verbs"
```

---

### Task 3: Dedup state

**Files:**
- Create: `src/dedupe.mjs`
- Test: `test/dedupe.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `loadSeen(path) → Record<string, string>` — `{}` when the file is absent
  - `saveSeen(path, seen) → void`
  - `isSeen(seen, id) → boolean`
  - `recordSeen(seen, id, isoDate) → Record<string,string>` — returns a new object
  - `pruneSeen(seen, todayIso, retentionDays) → Record<string,string>`

Dates are `YYYY-MM-DD` strings. `pruneSeen` takes `today` as an argument so it is pure and testable.

- [ ] **Step 1: Write the failing test**

Create `test/dedupe.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSeen, saveSeen, isSeen, recordSeen, pruneSeen } from '../src/dedupe.mjs';

test('loadSeen returns an empty object when the file does not exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jc-'));
  assert.deepEqual(loadSeen(join(dir, 'nope.json')), {});
});

test('loadSeen throws a clear error on malformed JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jc-'));
  const p = join(dir, 'seen.json');
  writeFileSync(p, '{not json', 'utf8');
  assert.throws(() => loadSeen(p), /Failed to parse/);
});

test('saveSeen then loadSeen round-trips', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jc-'));
  const p = join(dir, 'seen.json');
  saveSeen(p, { 'a:1': '2026-08-19' });
  assert.deepEqual(loadSeen(p), { 'a:1': '2026-08-19' });
});

test('isSeen distinguishes present from absent ids', () => {
  const seen = { 'a:1': '2026-08-19' };
  assert.equal(isSeen(seen, 'a:1'), true);
  assert.equal(isSeen(seen, 'a:2'), false);
});

test('isSeen is not fooled by inherited object properties', () => {
  assert.equal(isSeen({}, 'constructor'), false);
});

test('recordSeen returns a new object and leaves the original untouched', () => {
  const before = { 'a:1': '2026-08-01' };
  const after = recordSeen(before, 'a:2', '2026-08-19');
  assert.deepEqual(before, { 'a:1': '2026-08-01' });
  assert.deepEqual(after, { 'a:1': '2026-08-01', 'a:2': '2026-08-19' });
});

test('pruneSeen drops entries older than the retention window', () => {
  const seen = { old: '2026-07-01', fresh: '2026-08-18' };
  assert.deepEqual(pruneSeen(seen, '2026-08-19', 30), { fresh: '2026-08-18' });
});

test('pruneSeen keeps an entry exactly on the cutoff', () => {
  const seen = { edge: '2026-07-20' };
  assert.deepEqual(pruneSeen(seen, '2026-08-19', 30), { edge: '2026-07-20' });
});

test('pruneSeen drops entries with unparseable dates', () => {
  assert.deepEqual(pruneSeen({ bad: 'not-a-date' }, '2026-08-19', 30), {});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/dedupe.test.mjs`
Expected: FAIL — `Cannot find module '../src/dedupe.mjs'`

- [ ] **Step 3: Write the implementation**

Create `src/dedupe.mjs`:

```js
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export function loadSeen(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to parse ${path}: ${err.message}`);
  }
}

export function saveSeen(path, seen) {
  writeFileSync(path, JSON.stringify(seen, null, 2), 'utf8');
}

export function isSeen(seen, id) {
  return Object.prototype.hasOwnProperty.call(seen, id);
}

export function recordSeen(seen, id, isoDate) {
  return { ...seen, [id]: isoDate };
}

/**
 * Drop entries older than `retentionDays` before `todayIso`.
 * `today` is a parameter, not a clock read, so the function is pure.
 * Entries whose date will not parse are dropped — an unreadable date cannot
 * be shown to be fresh, and keeping it would leak state forever.
 */
export function pruneSeen(seen, todayIso, retentionDays) {
  const cutoff = new Date(`${todayIso}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
  const out = {};
  for (const [id, dateStr] of Object.entries(seen)) {
    const d = new Date(`${dateStr}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) continue;
    if (d >= cutoff) out[id] = dateStr;
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/dedupe.test.mjs`
Expected: PASS — 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/dedupe.mjs test/dedupe.test.mjs
git commit -m "feat: dedup state with pure pruning"
```

---

### Task 4: Posting helpers

**Files:**
- Create: `src/posting.mjs`
- Test: `test/posting.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `stripHtml(html) → string`
  - `makePosting({ site, nativeId, title, url, location, postedAt, description }) → Posting`
  - `Posting` = `{ id, title, company, location, url, postedAt, description, source, notes }`

Every adapter builds its output through `makePosting`, so the normalised shape is guaranteed in one place rather than thirteen.

- [ ] **Step 1: Write the failing test**

Create `test/posting.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripHtml, makePosting } from '../src/posting.mjs';

test('stripHtml removes tags and collapses whitespace', () => {
  assert.equal(stripHtml('<p>Hello   <b>world</b></p>'), 'Hello world');
});

test('stripHtml turns list items into bullet lines', () => {
  assert.equal(stripHtml('<ul><li>One</li><li>Two</li></ul>'), '• One\n• Two');
});

test('stripHtml decodes the common entities', () => {
  assert.equal(stripHtml('R&amp;D &quot;fast&quot; &#39;work&#39; &lt;x&gt;&nbsp;y'), 'R&D "fast" \'work\' <x> y');
});

test('stripHtml drops script and style content', () => {
  assert.equal(stripHtml('<style>a{}</style>Keep<script>bad()</script>'), 'Keep');
});

test('stripHtml returns an empty string for null or non-string input', () => {
  assert.equal(stripHtml(null), '');
  assert.equal(stripHtml(undefined), '');
  assert.equal(stripHtml(42), '');
});

test('makePosting namespaces the id by site', () => {
  const p = makePosting({
    site: { id: 'acme', company: 'Acme Dynamics' },
    nativeId: '123', title: 'Engineer', url: 'https://example.test/123',
  });
  assert.equal(p.id, 'acme:123');
  assert.equal(p.source, 'acme');
  assert.equal(p.company, 'Acme Dynamics');
});

test('makePosting defaults optional fields', () => {
  const p = makePosting({
    site: { id: 'acme', company: 'Acme Dynamics' },
    nativeId: '1', title: 'Engineer', url: 'https://example.test/1',
  });
  assert.equal(p.location, '');
  assert.equal(p.description, '');
  assert.equal(p.postedAt, null);
  assert.deepEqual(p.notes, []);
});

test('makePosting trims the title', () => {
  const p = makePosting({
    site: { id: 'a', company: 'A' }, nativeId: '1',
    title: '  Graduate Engineer \n', url: 'https://example.test/1',
  });
  assert.equal(p.title, 'Graduate Engineer');
});

test('makePosting throws when a required field is missing', () => {
  assert.throws(() => makePosting({ site: { id: 'a', company: 'A' }, nativeId: '1', title: '' }), /title/);
  assert.throws(() => makePosting({ site: { id: 'a', company: 'A' }, title: 'X', url: 'u' }), /nativeId/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/posting.test.mjs`
Expected: FAIL — `Cannot find module '../src/posting.mjs'`

- [ ] **Step 3: Write the implementation**

Create `src/posting.mjs`:

```js
/**
 * Convert description HTML into readable plain text.
 * Block-level closers and <br> become newlines, <li> becomes a bullet, so the
 * result keeps the shape a human (and a scoring model) needs to read it.
 */
export function stripHtml(html) {
  if (!html || typeof html !== 'string') return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|ul|ol|li|h[1-6]|section|tr)>/gi, '\n')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * Build a normalised Posting. Every adapter goes through here so the shape is
 * defined once. Ids are namespaced by site so two boards cannot collide on a
 * bare numeric id.
 */
export function makePosting({ site, nativeId, title, url, location, postedAt, description }) {
  if (nativeId === undefined || nativeId === null || `${nativeId}` === '') {
    throw new Error(`posting from site '${site?.id}' is missing nativeId`);
  }
  const cleanTitle = (title ?? '').trim();
  if (!cleanTitle) throw new Error(`posting ${site?.id}:${nativeId} is missing a title`);
  if (!url) throw new Error(`posting ${site?.id}:${nativeId} is missing a url`);

  return {
    id: `${site.id}:${nativeId}`,
    title: cleanTitle,
    company: site.company,
    location: (location ?? '').trim(),
    url,
    postedAt: postedAt ?? null,
    description: description ?? '',
    source: site.id,
    notes: [],
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/posting.test.mjs`
Expected: PASS — 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/posting.mjs test/posting.test.mjs
git commit -m "feat: posting normalisation helpers"
```

---

### Task 5: Adapter registry and Greenhouse adapter

**Files:**
- Create: `src/adapters/index.mjs`
- Create: `src/adapters/greenhouse.mjs`
- Create: `test/fixtures/greenhouse.json`
- Test: `test/adapters.greenhouse.test.mjs`

**Interfaces:**
- Consumes: `makePosting`, `stripHtml` from Task 4
- Produces:
  - `getAdapter(type) → Adapter` — throws `Error` naming the unknown type
  - `listAdapterTypes() → string[]`
  - `Adapter` = `{ id, tier: 'http'|'browser', yieldsDescription: boolean, fetch(site, ctx) → Promise<Posting[]> }`
  - `ctx` = `{ http, logger, timeoutMs }` where `http(url, opts) → Promise<{ok, status, text}>`

Greenhouse's board API returns the full description inline when `content=true`, so `yieldsDescription` is `true` and no detail fetch is ever needed.

Site config shape: `{ id, company, type: 'greenhouse', board: '<board-token>' }`

- [ ] **Step 1: Create the fixture**

Create `test/fixtures/greenhouse.json` — a trimmed real-shape response with fictional companies:

```json
{
  "jobs": [
    {
      "id": 4001,
      "title": "Graduate Design Engineer",
      "absolute_url": "https://boards.greenhouse.io/acmedynamics/jobs/4001",
      "updated_at": "2026-08-17T09:12:00-04:00",
      "location": { "name": "Oxford, UK" },
      "content": "&lt;p&gt;Join our chassis team.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;CAD&lt;/li&gt;&lt;li&gt;FEA&lt;/li&gt;&lt;/ul&gt;"
    },
    {
      "id": 4002,
      "title": "Head of Aerodynamics",
      "absolute_url": "https://boards.greenhouse.io/acmedynamics/jobs/4002",
      "updated_at": "2026-08-16T11:00:00-04:00",
      "location": { "name": "Remote" },
      "content": "&lt;p&gt;Lead the aero group.&lt;/p&gt;"
    }
  ],
  "meta": { "total": 2 }
}
```

- [ ] **Step 2: Write the failing test**

Create `test/adapters.greenhouse.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import greenhouse from '../src/adapters/greenhouse.mjs';
import { getAdapter, listAdapterTypes } from '../src/adapters/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, 'fixtures/greenhouse.json'), 'utf8');

const site = { id: 'acme', company: 'Acme Dynamics', type: 'greenhouse', board: 'acmedynamics' };
const stubHttp = (body, { ok = true, status = 200 } = {}) => {
  const calls = [];
  const http = async (url, opts) => { calls.push({ url, opts }); return { ok, status, text: body }; };
  http.calls = calls;
  return http;
};

test('registry resolves the greenhouse adapter by type', () => {
  assert.equal(getAdapter('greenhouse').id, 'greenhouse');
  assert.ok(listAdapterTypes().includes('greenhouse'));
});

test('registry throws a helpful error for an unknown type', () => {
  assert.throws(() => getAdapter('nonesuch'), /unknown adapter type 'nonesuch'/);
});

test('greenhouse declares it yields descriptions inline', () => {
  assert.equal(greenhouse.yieldsDescription, true);
  assert.equal(greenhouse.tier, 'http');
});

test('greenhouse requests the board endpoint with content=true', async () => {
  const http = stubHttp(fixture);
  await greenhouse.fetch(site, { http, logger: console, timeoutMs: 1000 });
  assert.equal(http.calls.length, 1);
  assert.equal(
    http.calls[0].url,
    'https://boards-api.greenhouse.io/v1/boards/acmedynamics/jobs?content=true'
  );
});

test('greenhouse maps postings to the normalised shape', async () => {
  const http = stubHttp(fixture);
  const out = await greenhouse.fetch(site, { http, logger: console, timeoutMs: 1000 });
  assert.equal(out.length, 2);
  assert.deepEqual(
    { id: out[0].id, title: out[0].title, company: out[0].company, location: out[0].location, url: out[0].url },
    {
      id: 'acme:4001', title: 'Graduate Design Engineer', company: 'Acme Dynamics',
      location: 'Oxford, UK', url: 'https://boards.greenhouse.io/acmedynamics/jobs/4001',
    }
  );
  assert.equal(out[0].postedAt, '2026-08-17');
});

test('greenhouse decodes the double-escaped content field to plain text', async () => {
  const http = stubHttp(fixture);
  const out = await greenhouse.fetch(site, { http, logger: console, timeoutMs: 1000 });
  assert.equal(out[0].description, 'Join our chassis team.\n• CAD\n• FEA');
});

test('greenhouse throws on a non-200 response', async () => {
  const http = stubHttp('', { ok: false, status: 404 });
  await assert.rejects(
    () => greenhouse.fetch(site, { http, logger: console, timeoutMs: 1000 }),
    /greenhouse board 'acmedynamics' returned HTTP 404/
  );
});

test('greenhouse throws on unparseable JSON', async () => {
  const http = stubHttp('<html>nope</html>');
  await assert.rejects(() => greenhouse.fetch(site, { http, logger: console, timeoutMs: 1000 }), /not valid JSON/);
});

test('greenhouse returns an empty array for a board with no jobs', async () => {
  const http = stubHttp(JSON.stringify({ jobs: [] }));
  const out = await greenhouse.fetch(site, { http, logger: console, timeoutMs: 1000 });
  assert.deepEqual(out, []);
});

test('greenhouse requires a board token in site config', async () => {
  await assert.rejects(
    () => greenhouse.fetch({ id: 'a', company: 'A', type: 'greenhouse' }, { http: stubHttp('{}'), logger: console, timeoutMs: 1 }),
    /site 'a' needs 'board'/
  );
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test test/adapters.greenhouse.test.mjs`
Expected: FAIL — `Cannot find module '../src/adapters/greenhouse.mjs'`

- [ ] **Step 4: Write the Greenhouse adapter**

Create `src/adapters/greenhouse.mjs`:

```js
import { makePosting, stripHtml } from '../posting.mjs';

/**
 * Greenhouse job boards expose an unauthenticated JSON API. With
 * `content=true` the full description ships in the listing, so this adapter
 * never needs a second request per posting.
 *
 * Site config: { id, company, type: 'greenhouse', board: '<board-token>' }
 */
export default {
  id: 'greenhouse',
  tier: 'http',
  yieldsDescription: true,

  async fetch(site, ctx) {
    if (!site.board) throw new Error(`site '${site.id}' needs 'board' for the greenhouse adapter`);

    const url = `https://boards-api.greenhouse.io/v1/boards/${site.board}/jobs?content=true`;
    const res = await ctx.http(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      throw new Error(`greenhouse board '${site.board}' returned HTTP ${res.status}`);
    }

    let data;
    try {
      data = JSON.parse(res.text);
    } catch {
      throw new Error(`greenhouse board '${site.board}' returned a body that is not valid JSON`);
    }

    return (data.jobs ?? []).map((job) =>
      makePosting({
        site,
        nativeId: job.id,
        title: job.title,
        url: job.absolute_url,
        location: job.location?.name ?? '',
        // Greenhouse serves `content` HTML-escaped, so it needs two passes:
        // once to turn &lt;p&gt; into <p>, once to turn that into text.
        description: stripHtml(stripHtml(job.content)),
        postedAt: job.updated_at ? job.updated_at.slice(0, 10) : null,
      })
    );
  },
};
```

- [ ] **Step 5: Write the registry**

Create `src/adapters/index.mjs`:

```js
import greenhouse from './greenhouse.mjs';

const ADAPTERS = new Map([
  [greenhouse.id, greenhouse],
]);

export function getAdapter(type) {
  const adapter = ADAPTERS.get(type);
  if (!adapter) {
    throw new Error(
      `unknown adapter type '${type}' — known types: ${listAdapterTypes().join(', ')}`
    );
  }
  return adapter;
}

export function listAdapterTypes() {
  return [...ADAPTERS.keys()].sort();
}

export function registerAdapter(adapter) {
  ADAPTERS.set(adapter.id, adapter);
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test test/adapters.greenhouse.test.mjs`
Expected: PASS — 10 tests

- [ ] **Step 7: Commit**

```bash
git add src/adapters test/adapters.greenhouse.test.mjs test/fixtures/greenhouse.json
git commit -m "feat: adapter registry and greenhouse adapter"
```

---

### Task 6: Lever adapter

**Files:**
- Create: `src/adapters/lever.mjs`
- Modify: `src/adapters/index.mjs` (register it)
- Create: `test/fixtures/lever.json`
- Test: `test/adapters.lever.test.mjs`

**Interfaces:**
- Consumes: `makePosting`, `stripHtml` (Task 4); registry from Task 5
- Produces: default-exported adapter with `id: 'lever'`, `tier: 'http'`, `yieldsDescription: true`

Site config: `{ id, company, type: 'lever', board: '<lever-account>' }`. Lever returns `createdAt` as epoch milliseconds, not a string — that is the one trap in this adapter.

- [ ] **Step 1: Create the fixture**

Create `test/fixtures/lever.json`:

```json
[
  {
    "id": "b1e7c2a4-0000-4000-8000-000000000001",
    "text": "Powertrain Systems Engineer",
    "hostedUrl": "https://jobs.lever.co/nordholt/b1e7c2a4",
    "createdAt": 1755388800000,
    "categories": { "location": "Bicester, UK", "team": "Powertrain", "commitment": "Full-time" },
    "descriptionPlain": "Own the hybrid control strategy.\nRequires MATLAB."
  },
  {
    "id": "b1e7c2a4-0000-4000-8000-000000000002",
    "text": "Composites Technician",
    "hostedUrl": "https://jobs.lever.co/nordholt/b1e7c2a5",
    "createdAt": 1755302400000,
    "categories": { "location": "Bicester, UK" },
    "descriptionPlain": "Layup and autoclave work."
  }
]
```

- [ ] **Step 2: Write the failing test**

Create `test/adapters.lever.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import lever from '../src/adapters/lever.mjs';
import { getAdapter } from '../src/adapters/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, 'fixtures/lever.json'), 'utf8');

const site = { id: 'nordholt', company: 'Nordholt Racing', type: 'lever', board: 'nordholt' };
const stubHttp = (body, { ok = true, status = 200 } = {}) => {
  const calls = [];
  const http = async (url, opts) => { calls.push({ url, opts }); return { ok, status, text: body }; };
  http.calls = calls;
  return http;
};
const ctx = (http) => ({ http, logger: console, timeoutMs: 1000 });

test('registry resolves the lever adapter', () => {
  assert.equal(getAdapter('lever').id, 'lever');
});

test('lever requests the postings endpoint in json mode', async () => {
  const http = stubHttp(fixture);
  await lever.fetch(site, ctx(http));
  assert.equal(http.calls[0].url, 'https://api.lever.co/v0/postings/nordholt?mode=json');
});

test('lever maps postings to the normalised shape', async () => {
  const out = await lever.fetch(site, ctx(stubHttp(fixture)));
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'nordholt:b1e7c2a4-0000-4000-8000-000000000001');
  assert.equal(out[0].title, 'Powertrain Systems Engineer');
  assert.equal(out[0].company, 'Nordholt Racing');
  assert.equal(out[0].location, 'Bicester, UK');
  assert.equal(out[0].url, 'https://jobs.lever.co/nordholt/b1e7c2a4');
});

test('lever converts the epoch-millisecond createdAt to an ISO date', async () => {
  const out = await lever.fetch(site, ctx(stubHttp(fixture)));
  assert.equal(out[0].postedAt, '2026-08-17');
});

test('lever carries descriptionPlain through unchanged', async () => {
  const out = await lever.fetch(site, ctx(stubHttp(fixture)));
  assert.equal(out[0].description, 'Own the hybrid control strategy.\nRequires MATLAB.');
});

test('lever tolerates a posting with no categories', async () => {
  const body = JSON.stringify([{ id: 'x', text: 'Engineer', hostedUrl: 'https://jobs.lever.co/n/x' }]);
  const out = await lever.fetch(site, ctx(stubHttp(body)));
  assert.equal(out[0].location, '');
  assert.equal(out[0].postedAt, null);
});

test('lever throws on a non-200 response', async () => {
  await assert.rejects(
    () => lever.fetch(site, ctx(stubHttp('', { ok: false, status: 403 }))),
    /lever board 'nordholt' returned HTTP 403/
  );
});

test('lever throws when the body is not a JSON array', async () => {
  await assert.rejects(() => lever.fetch(site, ctx(stubHttp('{"jobs":[]}'))), /expected a JSON array/);
});

test('lever requires a board in site config', async () => {
  await assert.rejects(
    () => lever.fetch({ id: 'a', company: 'A', type: 'lever' }, ctx(stubHttp('[]'))),
    /site 'a' needs 'board'/
  );
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test test/adapters.lever.test.mjs`
Expected: FAIL — `Cannot find module '../src/adapters/lever.mjs'`

- [ ] **Step 4: Write the adapter**

Create `src/adapters/lever.mjs`:

```js
import { makePosting } from '../posting.mjs';

/**
 * Lever exposes an unauthenticated postings API returning a bare JSON array.
 * `descriptionPlain` is already text, so no HTML stripping is needed.
 *
 * Site config: { id, company, type: 'lever', board: '<lever-account>' }
 */
export default {
  id: 'lever',
  tier: 'http',
  yieldsDescription: true,

  async fetch(site, ctx) {
    if (!site.board) throw new Error(`site '${site.id}' needs 'board' for the lever adapter`);

    const url = `https://api.lever.co/v0/postings/${site.board}?mode=json`;
    const res = await ctx.http(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`lever board '${site.board}' returned HTTP ${res.status}`);

    let data;
    try {
      data = JSON.parse(res.text);
    } catch {
      throw new Error(`lever board '${site.board}' returned a body that is not valid JSON`);
    }
    if (!Array.isArray(data)) {
      throw new Error(`lever board '${site.board}': expected a JSON array of postings`);
    }

    return data.map((job) =>
      makePosting({
        site,
        nativeId: job.id,
        title: job.text,
        url: job.hostedUrl,
        location: job.categories?.location ?? '',
        description: job.descriptionPlain ?? '',
        // Lever sends epoch milliseconds, not a date string.
        postedAt: Number.isFinite(job.createdAt)
          ? new Date(job.createdAt).toISOString().slice(0, 10)
          : null,
      })
    );
  },
};
```

- [ ] **Step 5: Register it**

In `src/adapters/index.mjs`, add the import and map entry:

```js
import greenhouse from './greenhouse.mjs';
import lever from './lever.mjs';

const ADAPTERS = new Map([
  [greenhouse.id, greenhouse],
  [lever.id, lever],
]);
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test test/adapters.lever.test.mjs`
Expected: PASS — 9 tests

- [ ] **Step 7: Commit**

```bash
git add src/adapters test/adapters.lever.test.mjs test/fixtures/lever.json
git commit -m "feat: lever adapter"
```

---

### Task 7: Workday adapter with description enrichment

**Files:**
- Create: `src/adapters/workday.mjs`
- Modify: `src/adapters/index.mjs` (register it)
- Create: `test/fixtures/workday-list.json`
- Create: `test/fixtures/workday-detail.json`
- Test: `test/adapters.workday.test.mjs`

**Interfaces:**
- Consumes: `makePosting`, `stripHtml` (Task 4)
- Produces: adapter `id: 'workday'`, `tier: 'http'`, `yieldsDescription: false`, plus an extra exported method `fetchDescription(posting, site, ctx) → Promise<string>` used by the pipeline's enrich stage

Site config: `{ id, company, type: 'workday', host: 'https://x.wd3.myworkdayjobs.com', tenant: 'x', board: 'External' }`.

Workday's CXS endpoint caps `limit` at 20, so the adapter paginates. It returns no description in the listing — this is the adapter that exercises the enrich path, which is why it belongs in Plan 1 rather than Plan 2.

- [ ] **Step 1: Create the fixtures**

Create `test/fixtures/workday-list.json`:

```json
{
  "total": 2,
  "jobPostings": [
    {
      "title": "Thermal Systems Engineer",
      "externalPath": "/job/Bicester/Thermal-Systems-Engineer_R-1001",
      "locationsText": "Bicester, United Kingdom",
      "postedOn": "Posted 2 Days Ago",
      "bulletFields": ["R-1001"]
    },
    {
      "title": "Graduate Simulation Engineer",
      "externalPath": "/job/Bicester/Graduate-Simulation-Engineer_R-1002",
      "locationsText": "Bicester, United Kingdom",
      "postedOn": "Posted 5 Days Ago",
      "bulletFields": ["R-1002"]
    }
  ]
}
```

Create `test/fixtures/workday-detail.json`:

```json
{
  "jobPostingInfo": {
    "id": "R-1001",
    "title": "Thermal Systems Engineer",
    "jobDescription": "<p>Own thermal management for the hybrid system.</p><ul><li>GT-SUITE</li><li>1D modelling</li></ul>",
    "externalUrl": "https://vantor.wd3.myworkdayjobs.com/en-US/External/job/Bicester/Thermal-Systems-Engineer_R-1001",
    "startDate": "2026-08-17"
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `test/adapters.workday.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import workday from '../src/adapters/workday.mjs';
import { getAdapter } from '../src/adapters/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const listBody = readFileSync(join(here, 'fixtures/workday-list.json'), 'utf8');
const detailBody = readFileSync(join(here, 'fixtures/workday-detail.json'), 'utf8');

const site = {
  id: 'vantor', company: 'Vantor Propulsion', type: 'workday',
  host: 'https://vantor.wd3.myworkdayjobs.com', tenant: 'vantor', board: 'External',
};

// Serves the list fixture on the first call and an empty page on the second,
// so pagination terminates.
function listHttp() {
  const calls = [];
  let n = 0;
  const http = async (url, opts) => {
    calls.push({ url, opts });
    n += 1;
    return { ok: true, status: 200, text: n === 1 ? listBody : JSON.stringify({ jobPostings: [] }) };
  };
  http.calls = calls;
  return http;
}
const ctx = (http) => ({ http, logger: console, timeoutMs: 1000 });

test('registry resolves the workday adapter', () => {
  assert.equal(getAdapter('workday').id, 'workday');
});

test('workday declares that it does not yield descriptions inline', () => {
  assert.equal(workday.yieldsDescription, false);
});

test('workday POSTs to the CXS jobs endpoint', async () => {
  const http = listHttp();
  await workday.fetch(site, ctx(http));
  assert.equal(http.calls[0].url, 'https://vantor.wd3.myworkdayjobs.com/wday/cxs/vantor/External/jobs');
  assert.equal(http.calls[0].opts.method, 'POST');
  assert.deepEqual(JSON.parse(http.calls[0].opts.body), { appliedFacets: {}, limit: 20, offset: 0, searchText: '' });
});

test('workday maps postings, deriving the id from bulletFields', async () => {
  const out = await workday.fetch(site, ctx(listHttp()));
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'vantor:R-1001');
  assert.equal(out[0].title, 'Thermal Systems Engineer');
  assert.equal(out[0].location, 'Bicester, United Kingdom');
  assert.equal(
    out[0].url,
    'https://vantor.wd3.myworkdayjobs.com/en-US/External/job/Bicester/Thermal-Systems-Engineer_R-1001'
  );
});

test('workday falls back to the externalPath slug when bulletFields is absent', async () => {
  const body = JSON.stringify({
    jobPostings: [{ title: 'Engineer', externalPath: '/job/Site/Engineer_R-9', locationsText: '' }],
  });
  let n = 0;
  const http = async () => { n += 1; return { ok: true, status: 200, text: n === 1 ? body : '{"jobPostings":[]}' }; };
  const out = await workday.fetch(site, ctx(http));
  assert.equal(out[0].id, 'vantor:Engineer_R-9');
});

test('workday leaves description empty in the listing pass', async () => {
  const out = await workday.fetch(site, ctx(listHttp()));
  assert.equal(out[0].description, '');
});

test('workday stops paginating on a short page', async () => {
  const http = listHttp();
  await workday.fetch(site, ctx(http));
  assert.equal(http.calls.length, 1); // 2 postings < 20, so no second request
});

test('workday paginates while pages are full', async () => {
  const full = JSON.stringify({
    jobPostings: Array.from({ length: 20 }, (_, i) => ({
      title: `Role ${i}`, externalPath: `/job/S/Role-${i}_R-${i}`, locationsText: '', bulletFields: [`R-${i}`],
    })),
  });
  const calls = [];
  let n = 0;
  const http = async (url, opts) => {
    calls.push(JSON.parse(opts.body).offset);
    n += 1;
    return { ok: true, status: 200, text: n === 1 ? full : '{"jobPostings":[]}' };
  };
  await workday.fetch(site, ctx(http));
  assert.deepEqual(calls, [0, 20]);
});

test('workday throws when the first page fails', async () => {
  const http = async () => ({ ok: false, status: 500, text: '' });
  await assert.rejects(() => workday.fetch(site, ctx(http)), /workday tenant 'vantor' returned HTTP 500/);
});

test('workday requires host, tenant and board', async () => {
  await assert.rejects(
    () => workday.fetch({ id: 'a', company: 'A', type: 'workday' }, ctx(listHttp())),
    /site 'a' needs 'host', 'tenant' and 'board'/
  );
});

test('fetchDescription retrieves and cleans the detail description', async () => {
  const calls = [];
  const http = async (url) => { calls.push(url); return { ok: true, status: 200, text: detailBody }; };
  const posting = {
    id: 'vantor:R-1001',
    url: 'https://vantor.wd3.myworkdayjobs.com/en-US/External/job/Bicester/Thermal-Systems-Engineer_R-1001',
  };
  const text = await workday.fetchDescription(posting, site, ctx(http));
  assert.equal(
    calls[0],
    'https://vantor.wd3.myworkdayjobs.com/wday/cxs/vantor/External/job/Bicester/Thermal-Systems-Engineer_R-1001'
  );
  assert.equal(text, 'Own thermal management for the hybrid system.\n• GT-SUITE\n• 1D modelling');
});

test('fetchDescription returns an empty string rather than throwing on failure', async () => {
  const http = async () => ({ ok: false, status: 404, text: '' });
  const posting = { id: 'vantor:R-1', url: 'https://vantor.wd3.myworkdayjobs.com/en-US/External/job/S/X_R-1' };
  assert.equal(await workday.fetchDescription(posting, site, ctx(http)), '');
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test test/adapters.workday.test.mjs`
Expected: FAIL — `Cannot find module '../src/adapters/workday.mjs'`

- [ ] **Step 4: Write the adapter**

Create `src/adapters/workday.mjs`:

```js
import { makePosting, stripHtml } from '../posting.mjs';

const PAGE = 20;        // Workday CXS silently caps `limit` at 20.
const MAX_PAGES = 5;    // 100 postings is plenty for a daily monitor.

function requireFields(site) {
  if (!site.host || !site.tenant || !site.board) {
    throw new Error(`site '${site.id}' needs 'host', 'tenant' and 'board' for the workday adapter`);
  }
}

const cxsBase = (site) => `${site.host}/wday/cxs/${site.tenant}/${site.board}`;

/**
 * Workday's CXS endpoint is unauthenticated but POST-only and paginated.
 * The listing carries no description, so `yieldsDescription` is false and the
 * pipeline calls `fetchDescription` for the postings that survive the rules.
 *
 * Site config:
 *   { id, company, type: 'workday', host: 'https://x.wd3.myworkdayjobs.com',
 *     tenant: 'x', board: 'External' }
 */
export default {
  id: 'workday',
  tier: 'http',
  yieldsDescription: false,

  async fetch(site, ctx) {
    requireFields(site);
    const url = `${cxsBase(site)}/jobs`;
    const out = [];

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const res = await ctx.http(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          appliedFacets: {}, limit: PAGE, offset: page * PAGE, searchText: site.searchText ?? '',
        }),
      });

      if (!res.ok) {
        if (page === 0) throw new Error(`workday tenant '${site.tenant}' returned HTTP ${res.status}`);
        break; // a later page failing still leaves earlier pages usable
      }

      let data;
      try {
        data = JSON.parse(res.text);
      } catch {
        if (page === 0) throw new Error(`workday tenant '${site.tenant}' returned a body that is not valid JSON`);
        break;
      }

      const rows = data.jobPostings ?? [];
      for (const job of rows) {
        const path = job.externalPath ?? '';
        out.push(makePosting({
          site,
          // bulletFields normally carries the requisition id; the slug is the fallback.
          nativeId: job.bulletFields?.[0] ?? path.split('/').pop() ?? path,
          title: job.title,
          url: `${site.host}/en-US/${site.board}${path}`,
          location: job.locationsText ?? '',
          description: '',
          postedAt: null, // `postedOn` is prose ("Posted 2 Days Ago"), not a date
        }));
      }

      if (rows.length < PAGE) break;
    }

    return out;
  },

  /**
   * Fetch one posting's description. Returns '' on any failure — a missing
   * description must never abort a run that has already fetched a full listing.
   */
  async fetchDescription(posting, site, ctx) {
    requireFields(site);
    const path = new URL(posting.url).pathname.replace(`/en-US/${site.board}`, '');
    try {
      const res = await ctx.http(`${cxsBase(site)}${path}`, { headers: { Accept: 'application/json' } });
      if (!res.ok) return '';
      const data = JSON.parse(res.text);
      return stripHtml(data.jobPostingInfo?.jobDescription ?? '');
    } catch {
      return '';
    }
  },
};
```

- [ ] **Step 5: Register it**

In `src/adapters/index.mjs`:

```js
import greenhouse from './greenhouse.mjs';
import lever from './lever.mjs';
import workday from './workday.mjs';

const ADAPTERS = new Map([
  [greenhouse.id, greenhouse],
  [lever.id, lever],
  [workday.id, workday],
]);
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test test/adapters.workday.test.mjs`
Expected: PASS — 12 tests

- [ ] **Step 7: Commit**

```bash
git add src/adapters test/adapters.workday.test.mjs test/fixtures/workday-*.json
git commit -m "feat: workday adapter with description enrichment"
```

---

### Task 8: The `none` scoring provider

**Files:**
- Create: `src/scoring/index.mjs`
- Create: `src/scoring/none.mjs`
- Test: `test/scoring.none.test.mjs`

**Interfaces:**
- Consumes: `Posting` from Task 4
- Produces:
  - `getProvider(id) → Provider`
  - `Provider` = `{ id, score(postings, opts) → Promise<Scored[]> }`
  - `Scored` = `Posting & { score: number, rationale: string, verdict: 'keep'|'omit' }`
  - `opts` = `{ profile, rubric, model, effort, keywords, batch }`

`none` ranks deterministically by how many configured keywords a posting matches: `score = min(10, 1 + 2 × matchCount)`. It never omits. It exists so the tool is usable and fully testable without an API key.

- [ ] **Step 1: Write the failing test**

Create `test/scoring.none.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import none from '../src/scoring/none.mjs';
import { getProvider } from '../src/scoring/index.mjs';

const posting = (over = {}) => ({
  id: 'a:1', title: 'Graduate Design Engineer', company: 'Acme Dynamics',
  location: 'Oxford', url: 'https://example.test/1', postedAt: '2026-08-18',
  description: 'CFD and CAD work.', source: 'a', notes: [], ...over,
});

test('registry resolves the none provider', () => {
  assert.equal(getProvider('none').id, 'none');
});

test('registry throws for an unknown provider', () => {
  assert.throws(() => getProvider('wishful'), /unknown scoring provider 'wishful'/);
});

test('with no keywords every posting scores 1', async () => {
  const out = await none.score([posting()], { keywords: [] });
  assert.equal(out[0].score, 1);
  assert.equal(out[0].verdict, 'keep');
});

test('each distinct keyword match adds 2', async () => {
  const out = await none.score([posting()], { keywords: ['cfd', 'graduate'] });
  assert.equal(out[0].score, 5);
});

test('the score is capped at 10', async () => {
  const out = await none.score(
    [posting({ description: 'cfd cad gt-suite matlab python motorsport' })],
    { keywords: ['cfd', 'cad', 'gt-suite', 'matlab', 'python', 'motorsport'] }
  );
  assert.equal(out[0].score, 10);
});

test('a repeated keyword counts once', async () => {
  const out = await none.score([posting({ description: 'CFD CFD CFD' })], { keywords: ['cfd'] });
  assert.equal(out[0].score, 3);
});

test('keyword matching is case-insensitive and searches all text fields', async () => {
  const out = await none.score([posting({ title: 'CFD Engineer' })], { keywords: ['cfd'] });
  assert.equal(out[0].score, 3);
});

test('the rationale names the matched keywords', async () => {
  const out = await none.score([posting()], { keywords: ['cfd', 'nothing'] });
  assert.match(out[0].rationale, /cfd/);
  assert.doesNotMatch(out[0].rationale, /nothing/);
});

test('the rationale is explicit when nothing matched', async () => {
  const out = await none.score([posting()], { keywords: ['nothing'] });
  assert.match(out[0].rationale, /No configured keywords matched/);
});

test('the provider never omits a posting', async () => {
  const out = await none.score([posting(), posting({ id: 'a:2' })], { keywords: [] });
  assert.deepEqual(out.map((p) => p.verdict), ['keep', 'keep']);
});

test('input postings are not mutated', async () => {
  const p = posting();
  await none.score([p], { keywords: ['cfd'] });
  assert.equal(p.score, undefined);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/scoring.none.test.mjs`
Expected: FAIL — `Cannot find module '../src/scoring/none.mjs'`

- [ ] **Step 3: Write the provider**

Create `src/scoring/none.mjs`:

```js
const searchText = (p) =>
  [p.title, p.company, p.location, p.description].filter(Boolean).join('\n').toLowerCase();

/**
 * Deterministic keyword ranking. No network, no key, no cost.
 *
 * This is the default provider so the tool is useful and fully testable before
 * anyone configures an LLM. It never omits a posting — omission is a judgement
 * call, and keyword counting is not judgement.
 */
export default {
  id: 'none',

  async score(postings, opts = {}) {
    const keywords = (opts.keywords ?? []).map((k) => k.toLowerCase()).filter(Boolean);

    return postings.map((posting) => {
      const haystack = searchText(posting);
      const matched = [...new Set(keywords)].filter((k) => haystack.includes(k));
      return {
        ...posting,
        score: Math.min(10, 1 + 2 * matched.length),
        rationale: matched.length
          ? `Matched configured keywords: ${matched.join(', ')}.`
          : 'No configured keywords matched.',
        verdict: 'keep',
      };
    });
  },
};
```

- [ ] **Step 4: Write the provider registry**

Create `src/scoring/index.mjs`:

```js
import none from './none.mjs';

const PROVIDERS = new Map([[none.id, none]]);

export function getProvider(id) {
  const provider = PROVIDERS.get(id);
  if (!provider) {
    throw new Error(
      `unknown scoring provider '${id}' — known providers: ${[...PROVIDERS.keys()].sort().join(', ')}`
    );
  }
  return provider;
}

export function registerProvider(provider) {
  PROVIDERS.set(provider.id, provider);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/scoring.none.test.mjs`
Expected: PASS — 11 tests

- [ ] **Step 6: Update the spec**

Add `keywords: []` to the `scoring` block in
`docs/superpowers/specs/2026-08-19-jobcanary-design.md`, with a one-line note
that it is consumed only by the `none` provider.

- [ ] **Step 7: Commit**

```bash
git add src/scoring test/scoring.none.test.mjs docs/superpowers/specs/2026-08-19-jobcanary-design.md
git commit -m "feat: deterministic none scoring provider"
```

---

### Task 9: Markdown writer

**Files:**
- Create: `src/output/markdown.mjs`
- Test: `test/output.markdown.test.mjs`

**Interfaces:**
- Consumes: `Scored` from Task 8
- Produces: `renderDigest(scored, meta) → string` where `meta` = `{ date, scanned, siteErrors }`

Sorted score-descending, ties alphabetical by company. Notes render only when present — an empty bullet is noise.

- [ ] **Step 1: Write the failing test**

Create `test/output.markdown.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDigest } from '../src/output/markdown.mjs';

const scored = (over = {}) => ({
  id: 'a:1', title: 'Graduate Design Engineer', company: 'Acme Dynamics',
  location: 'Oxford, UK', url: 'https://example.test/1', postedAt: '2026-08-18',
  description: 'CFD work.', source: 'acme', notes: [],
  score: 7, rationale: 'Matched CFD.', verdict: 'keep', ...over,
});

const meta = { date: '2026-08-19', scanned: 42, siteErrors: [] };

test('the digest opens with a dated heading and run line', () => {
  const md = renderDigest([scored()], meta);
  assert.match(md, /^# Job Picks — 2026-08-19\n/);
  assert.match(md, /\*\*Scanned:\*\* 42/);
  assert.match(md, /\*\*New:\*\* 1/);
});

test('each posting renders score, title and company in its heading', () => {
  const md = renderDigest([scored()], meta);
  assert.match(md, /### \[7\/10\] Graduate Design Engineer · Acme Dynamics/);
});

test('postings sort by score descending', () => {
  const md = renderDigest([scored({ id: 'a:1', score: 4 }), scored({ id: 'a:2', score: 9 })], meta);
  assert.ok(md.indexOf('[9/10]') < md.indexOf('[4/10]'));
});

test('ties sort alphabetically by company', () => {
  const md = renderDigest(
    [scored({ id: 'a:1', company: 'Zenith Motors' }), scored({ id: 'a:2', company: 'Acme Dynamics' })],
    meta
  );
  assert.ok(md.indexOf('Acme Dynamics') < md.indexOf('Zenith Motors'));
});

test('notes render as their own bullet when present', () => {
  const md = renderDigest([scored({ notes: ['Check eligibility'] })], meta);
  assert.match(md, /\*\*Notes:\*\* Check eligibility/);
});

test('the notes bullet is omitted entirely when there are none', () => {
  assert.doesNotMatch(renderDigest([scored()], meta), /\*\*Notes:\*\*/);
});

test('omitted postings are excluded from the digest', () => {
  const md = renderDigest([scored({ id: 'a:1', verdict: 'omit' }), scored({ id: 'a:2' })], meta);
  assert.equal((md.match(/### /g) ?? []).length, 1);
});

test('an empty result set produces an explicit no-results body', () => {
  const md = renderDigest([], meta);
  assert.match(md, /No new postings today\. Scanned 42\./);
  assert.doesNotMatch(md, /### /);
});

test('site errors are listed in a footer', () => {
  const md = renderDigest([scored()], { ...meta, siteErrors: [{ site: 'zenith', error: 'HTTP 503' }] });
  assert.match(md, /## Site errors/);
  assert.match(md, /zenith — HTTP 503/);
});

test('no site-error footer appears when every site succeeded', () => {
  assert.doesNotMatch(renderDigest([scored()], meta), /## Site errors/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/output.markdown.test.mjs`
Expected: FAIL — `Cannot find module '../src/output/markdown.mjs'`

- [ ] **Step 3: Write the implementation**

Create `src/output/markdown.mjs`:

```js
function byScoreThenCompany(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  return a.company.localeCompare(b.company);
}

function renderPosting(p) {
  const lines = [
    `### [${p.score}/10] ${p.title} · ${p.company}`,
    `- **Location:** ${p.location || 'Not stated'}${p.postedAt ? ` · **Posted:** ${p.postedAt}` : ''}`,
    `- **Fit:** ${p.rationale}`,
  ];
  if (p.notes?.length) lines.push(`- **Notes:** ${p.notes.join(' · ')}`);
  lines.push(`- **Link:** ${p.url}`);
  return lines.join('\n');
}

/**
 * Render the ranked digest.
 * @param {object[]} scored
 * @param {{date: string, scanned: number, siteErrors: {site: string, error: string}[]}} meta
 * @returns {string}
 */
export function renderDigest(scored, meta) {
  const kept = scored.filter((p) => p.verdict !== 'omit').sort(byScoreThenCompany);

  const out = [
    `# Job Picks — ${meta.date}`,
    `**Scanned:** ${meta.scanned} · **New:** ${kept.length}`,
    '',
  ];

  if (kept.length === 0) {
    out.push(`No new postings today. Scanned ${meta.scanned}.`);
  } else {
    out.push(kept.map(renderPosting).join('\n\n'));
  }

  if (meta.siteErrors?.length) {
    out.push('', '## Site errors', '');
    out.push(meta.siteErrors.map((e) => `- ${e.site} — ${e.error}`).join('\n'));
  }

  return `${out.join('\n')}\n`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/output.markdown.test.mjs`
Expected: PASS — 10 tests

- [ ] **Step 5: Commit**

```bash
git add src/output test/output.markdown.test.mjs
git commit -m "feat: markdown digest writer"
```

---

### Task 10: Pipeline

**Files:**
- Create: `src/http.mjs`
- Create: `src/pipeline.mjs`
- Create: `src/index.mjs`
- Test: `test/pipeline.test.mjs`

**Interfaces:**
- Consumes: everything from Tasks 1–9
- Produces:
  - `createHttp({ timeoutMs, userAgent }) → http(url, opts) → Promise<{ok, status, text}>`
  - `run(config, { seen, today, browser, http, logger }) → Promise<{ postings, stats }>`
  - `stats` = `{ scanned, excluded, alreadySeen, kept, siteErrors }`
  - `src/index.mjs` re-exports the public API

`run` is given `seen` and `today` and returns data; it does **not** read or write disk. The CLI owns all I/O. That keeps the pipeline testable without a filesystem.

- [ ] **Step 1: Write the failing test**

Create `test/pipeline.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/pipeline.test.mjs`
Expected: FAIL — `Cannot find module '../src/pipeline.mjs'`

- [ ] **Step 3: Write the HTTP helper**

Create `src/http.mjs`:

```js
const DEFAULT_UA =
  'Mozilla/5.0 (compatible; jobcanary/0.1; +https://github.com/AlexLiaoooo/jobcanary)';

/**
 * Build the injectable fetch used by every adapter. Adapters never touch the
 * global fetch, so tests can substitute a stub without a network.
 */
export function createHttp({ timeoutMs = 25_000, userAgent = DEFAULT_UA } = {}) {
  return async function http(url, { method = 'GET', body = null, headers = {} } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        body,
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': userAgent,
          'Accept-Language': 'en-GB,en;q=0.9',
          ...headers,
        },
      });
      return { ok: res.ok, status: res.status, text: await res.text() };
    } finally {
      clearTimeout(timer);
    }
  };
}
```

- [ ] **Step 4: Write the pipeline**

Create `src/pipeline.mjs`:

```js
import { getAdapter } from './adapters/index.mjs';
import { getProvider } from './scoring/index.mjs';
import { applyRules } from './rules.mjs';
import { isSeen } from './dedupe.mjs';
import { createHttp } from './http.mjs';

/**
 * Run the pipeline over a config.
 *
 * Deliberately does no disk I/O: `seen` comes in, postings and stats go out.
 * The CLI owns reading and writing state, which keeps this function testable
 * without a filesystem and makes it reusable from a library consumer.
 *
 * @param {object} config
 * @param {{seen: object, today: string, browser?: boolean, http?: Function, logger?: object}} opts
 */
export async function run(config, { seen = {}, today, browser = false, http, logger = console }) {
  const ctx = { http: http ?? createHttp({}), logger, timeoutMs: 25_000 };

  const active = config.sites.filter((site) => {
    if (site.enabled === false) return false;
    const adapter = getAdapter(site.type);
    if (adapter.tier === 'browser' && !browser) {
      logger.log(`[${site.id}] skipped (browser tier; pass --browser to include)`);
      return false;
    }
    return true;
  });

  // --- fetch ---
  const siteErrors = [];
  const collected = [];
  for (const site of active) {
    const adapter = getAdapter(site.type);
    try {
      const postings = await adapter.fetch(site, ctx);
      collected.push({ site, adapter, postings });
      logger.log(`[${site.id}] ${postings.length} posting(s)`);
    } catch (err) {
      siteErrors.push({ site: site.id, error: err.message });
      logger.warn(`[${site.id}] failed: ${err.message}`);
    }
  }

  if (active.length > 0 && siteErrors.length === active.length) {
    throw new Error(
      `all ${active.length} site(s) failed — likely a network problem, not a stale adapter`
    );
  }

  // --- dedupe within run, then against seen state ---
  const withinRun = new Map();
  for (const { site, adapter, postings } of collected) {
    for (const posting of postings) {
      if (!withinRun.has(posting.id)) withinRun.set(posting.id, { posting, site, adapter });
    }
  }
  const scanned = withinRun.size;

  let alreadySeen = 0;
  let excluded = 0;
  const survivors = [];
  for (const entry of withinRun.values()) {
    if (isSeen(seen, entry.posting.id)) {
      alreadySeen += 1;
      continue;
    }
    const verdict = applyRules(entry.posting, config.rules);
    if (!verdict.keep) {
      excluded += 1;
      continue;
    }
    survivors.push({ ...entry, posting: { ...entry.posting, notes: verdict.notes } });
  }

  // --- enrich: only adapters that do not ship descriptions, only survivors ---
  for (const entry of survivors) {
    if (entry.adapter.yieldsDescription) continue;
    if (typeof entry.adapter.fetchDescription !== 'function') continue;
    entry.posting.description = await entry.adapter.fetchDescription(entry.posting, entry.site, ctx);
  }

  // --- re-apply rules now that descriptions exist ---
  const enriched = [];
  for (const entry of survivors) {
    if (entry.adapter.yieldsDescription) {
      enriched.push(entry.posting);
      continue;
    }
    const verdict = applyRules(entry.posting, config.rules);
    if (!verdict.keep) {
      excluded += 1;
      continue;
    }
    enriched.push({ ...entry.posting, notes: verdict.notes });
  }

  // --- score ---
  const provider = getProvider(config.scoring.provider);
  const postings = await provider.score(enriched, { ...config.scoring, profile: config.profile });

  return {
    postings,
    stats: { scanned, excluded, alreadySeen, kept: postings.length, siteErrors },
  };
}
```

- [ ] **Step 5: Write the public entry point**

Create `src/index.mjs`:

```js
export { loadConfig, parseConfig, compileMatcher, ConfigError } from './config.mjs';
export { applyRules } from './rules.mjs';
export { loadSeen, saveSeen, isSeen, recordSeen, pruneSeen } from './dedupe.mjs';
export { makePosting, stripHtml } from './posting.mjs';
export { getAdapter, listAdapterTypes, registerAdapter } from './adapters/index.mjs';
export { getProvider, registerProvider } from './scoring/index.mjs';
export { renderDigest } from './output/markdown.mjs';
export { createHttp } from './http.mjs';
export { run } from './pipeline.mjs';
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test test/pipeline.test.mjs`
Expected: PASS — 10 tests

- [ ] **Step 7: Commit**

```bash
git add src/pipeline.mjs src/http.mjs src/index.mjs test/pipeline.test.mjs
git commit -m "feat: pipeline orchestration with conditional enrichment"
```

---

### Task 11: CLI, example config, README

**Files:**
- Create: `bin/jobcanary.mjs`
- Create: `examples/config.yaml`
- Create: `README.md`
- Create: `LICENSE`
- Test: `test/cli.test.mjs`

**Interfaces:**
- Consumes: `loadConfig`, `run`, `renderDigest`, dedup helpers
- Produces: the `jobcanary` executable

The CLI owns every side effect: reading config, reading and writing `seen.json`, creating the output directory, writing the digest, and mapping errors to the exit codes in Global Constraints.

- [ ] **Step 1: Write the failing test**

Create `test/cli.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'bin', 'jobcanary.mjs');

function runCli(args, { cwd } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('--help exits 0 and lists the run command', () => {
  const r = runCli(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /jobcanary run/);
});

test('a missing config exits 2', () => {
  const r = runCli(['run', '--config', join(tmpdir(), 'does-not-exist.yaml')]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /could not read config/);
});

test('an invalid config exits 2 with a readable message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jc-'));
  const cfg = join(dir, 'config.yaml');
  writeFileSync(cfg, 'scoring: {provider: none}\n', 'utf8');
  const r = runCli(['run', '--config', cfg]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /needs a non-empty 'sites' list/);
});

test('an unknown adapter type exits 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jc-'));
  const cfg = join(dir, 'config.yaml');
  writeFileSync(cfg, 'sites:\n  - {id: a, company: A, type: nonesuch}\n', 'utf8');
  const r = runCli(['run', '--config', cfg]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown adapter type/);
});

test('--dry writes nothing but reports what it would do', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jc-'));
  const cfg = join(dir, 'config.yaml');
  writeFileSync(cfg, `
output: {dir: ./out}
sites:
  - {id: a, company: Acme, type: greenhouse, board: definitely-not-a-real-board-xyz}
`, 'utf8');
  const r = runCli(['run', '--config', cfg, '--dry']);
  // The board does not exist, so every site fails → exit 3, and nothing is written.
  assert.equal(r.code, 3);
  assert.deepEqual(readdirSync(dir).filter((f) => f === 'out'), []);
});
```

Note: the last test performs one real network call to a nonexistent Greenhouse board. If the CI environment has no network, that call fails too and the assertion still holds.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/cli.test.mjs`
Expected: FAIL — `Cannot find module .../bin/jobcanary.mjs`

- [ ] **Step 3: Write the CLI**

Create `bin/jobcanary.mjs`:

```js
#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, ConfigError } from '../src/config.mjs';
import { run } from '../src/pipeline.mjs';
import { renderDigest } from '../src/output/markdown.mjs';
import { loadSeen, saveSeen, recordSeen, pruneSeen } from '../src/dedupe.mjs';

const HELP = `
jobcanary — poll career sites and ATS boards, filter, score, and write a digest.

Usage:
  jobcanary run [options]

Options:
  -c, --config <path>   Config file (default: ./jobcanary.yaml)
  -p, --preset <name>   Use a bundled preset from presets/<name>.yaml
      --out <dir>       Override the output directory
      --browser         Include browser-tier sites
      --dry             Fetch and report, but write nothing
  -h, --help            Show this help

Exit codes: 0 ok · 1 unexpected · 2 config invalid · 3 all sites failed · 4 scoring failed
`.trim();

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c' },
      preset: { type: 'string', short: 'p' },
      out: { type: 'string' },
      browser: { type: 'boolean', default: false },
      dry: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help || positionals[0] === undefined) {
    console.log(HELP);
    return 0;
  }
  if (positionals[0] !== 'run') {
    console.error(`unknown command '${positionals[0]}'\n\n${HELP}`);
    return 2;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const configPath = values.preset
    ? resolve(here, '..', 'presets', `${values.preset}.yaml`)
    : resolve(values.config ?? './jobcanary.yaml');

  const config = loadConfig(configPath);
  if (values.out) config.output.dir = resolve(values.out);

  const date = today();
  const seenPath = join(config.output.dir, 'seen.json');
  // A dry run still consults seen state, so its counts match what a real run
  // would report. It just does not write anything back.
  const seen = loadSeen(seenPath);

  const { postings, stats } = await run(config, { seen, today: date, browser: values.browser });

  console.log(
    `scanned=${stats.scanned} seen=${stats.alreadySeen} excluded=${stats.excluded} kept=${stats.kept} siteErrors=${stats.siteErrors.length}`
  );

  if (values.dry) {
    console.log('--dry: nothing written');
    return 0;
  }

  mkdirSync(config.output.dir, { recursive: true });

  if (config.output.format === 'markdown' || config.output.format === 'both') {
    const md = renderDigest(postings, { date, scanned: stats.scanned, siteErrors: stats.siteErrors });
    const target = join(config.output.dir, `${date}.md`);
    writeFileSync(target, md, 'utf8');
    console.log(`wrote ${target}`);
  }
  if (config.output.format === 'json' || config.output.format === 'both') {
    const target = join(config.output.dir, `${date}.json`);
    writeFileSync(target, JSON.stringify({ date, stats, postings }, null, 2), 'utf8');
    console.log(`wrote ${target}`);
  }

  let next = seen;
  for (const p of postings) next = recordSeen(next, p.id, date);
  saveSeen(seenPath, pruneSeen(next, date, config.dedupe.retentionDays));

  return 0;
}

try {
  process.exit(await main());
} catch (err) {
  if (err instanceof ConfigError || /unknown adapter type|unknown scoring provider/.test(err.message)) {
    console.error(`config error: ${err.message}`);
    process.exit(2);
  }
  if (/^all \d+ site\(s\) failed/.test(err.message)) {
    console.error(err.message);
    process.exit(3);
  }
  console.error(err.stack ?? err.message);
  process.exit(1);
}
```

Then make it executable: `git update-index --chmod=+x bin/jobcanary.mjs` (after adding).

- [ ] **Step 4: Write the example config**

Create `examples/config.yaml`:

```yaml
# jobcanary example configuration.
# Run with: jobcanary run --config examples/config.yaml

output:
  dir: ./digests
  format: markdown

dedupe:
  retentionDays: 30

scoring:
  provider: none          # none | anthropic | claude-cli
  keywords:               # used only by the 'none' provider
    - graduate
    - cfd
    - powertrain

rules:
  exclude:
    - id: senior
      field: title
      match: ["senior", "principal", "head of", "director"]
    - id: non-engineering
      field: title
      match: ["sales", "marketing", "recruit"]
  annotate:
    - id: right-to-work
      field: description
      match: ["no visa sponsorship", "unable to sponsor"]
      note: "Mentions a sponsorship restriction — verify eligibility"

sites:
  - id: acme
    company: Acme Dynamics
    type: greenhouse
    board: acmedynamics

  - id: nordholt
    company: Nordholt Racing
    type: lever
    board: nordholt

  - id: vantor
    company: Vantor Propulsion
    type: workday
    host: https://vantor.wd3.myworkdayjobs.com
    tenant: vantor
    board: External
```

- [ ] **Step 5: Write the LICENSE**

Create `LICENSE` — the standard MIT text, `Copyright (c) 2026 Alex Liao`.

- [ ] **Step 6: Write the README**

Create `README.md` covering, in this order: one-line description; what it does and explicitly what it does not do (no auto-apply, no LinkedIn); install (`npm install`, Node 20+); quickstart with `examples/config.yaml`; the config reference (every key in Task 1's schema); the adapter table (type → required site fields); scoring providers with `none` as the default; exit codes; and a "Sources and terms" section stating that jobcanary reads public career pages and unauthenticated ATS endpoints only, that users are responsible for the terms of any site they configure, and that no adapter for a site whose terms prohibit automated access is accepted.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS — all suites, ~90 tests

- [ ] **Step 8: Commit**

```bash
git add bin examples README.md LICENSE test/cli.test.mjs
git update-index --chmod=+x bin/jobcanary.mjs
git commit -m "feat: cli, example config, readme, license"
```

---

## Definition of done for Plan 1

`jobcanary run --config examples/config.yaml` against real Greenhouse, Lever,
and Workday boards produces a ranked Markdown digest, records dedup state, and
returns 0. `npm test` passes with no network access. No API key involved at any
point.

## Deferred to later plans

**Plan 2 — adapter fleet:** static, pinpoint, workable, oracle, recruitee,
occupop, ashby, smartrecruiters, personio, sfrss, plus the browser tier and its
per-site timeout isolation.

**Plan 3 — LLM scoring and publication:** `anthropic` provider (structured
outputs, prompt caching, Batch API), `claude-cli` provider, the
`uk-motorsport` preset, the GitHub Actions daily workflow, CI, and the public
repo push.
