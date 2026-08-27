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
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const FORMATS = ['markdown', 'json', 'both'];
const FIELDS = ['title', 'company', 'location', 'description', 'all'];

/**
 * Escape a plain string so it compiles to a regex matching itself.
 *
 * Exported for the `static` adapter: it compiles its own site regexes, but the
 * README promises those fields take the same form as a rule's `match`, and only
 * one definition of "the same form" can stay true as both move.
 */
export const escapeLiteral = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Compile one match specification into a RegExp.
 * Plain strings are matched case-insensitively as literals (escaped for regex metacharacters).
 * /body/flags syntax creates a real regex using exactly the flags given, so /PhD/ is case-sensitive while /PhD/i is not.
 *
 * `g` and `y` are stripped rather than honoured. A matcher is compiled once at
 * config load and then reused with `.test()` for every posting of every run;
 * on a global or sticky regex `.test()` advances `lastIndex`, so the same rule
 * would match, then miss, then match again. `g` is the most reflexively typed
 * flag there is, and neither flag changes what a rule *means* here — the rules
 * engine only ever asks "does this text match at all".
 */
export function compileMatcher(spec) {
  if (typeof spec !== 'string' || spec.length === 0) {
    throw new ConfigError(`match entries must be non-empty strings, got: ${JSON.stringify(spec)}`);
  }
  const m = spec.match(/^\/(.*)\/([gimsuy]*)$/s);
  if (m) {
    try {
      return new RegExp(m[1], m[2].replace(/[gy]/g, ''));
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
    batch: raw.scoring?.batch ?? false,
    concurrency: raw.scoring?.concurrency ?? 5,
    keywords: raw.scoring?.keywords ?? [],
    rubric: null,
  };
  if (!PROVIDERS.includes(scoring.provider)) {
    throw new ConfigError(`scoring.provider must be one of ${PROVIDERS.join(', ')}, got '${scoring.provider}'`);
  }
  if (!Array.isArray(scoring.keywords)) throw new ConfigError('scoring.keywords must be a list');
  if (!Number.isInteger(scoring.concurrency) || scoring.concurrency < 1) {
    throw new ConfigError('scoring.concurrency must be a positive integer');
  }
  // Not validated, this is a 400 on every posting — discovered after the whole
  // crawl, for a typo. YAML quotes nothing, so 'higH' or 'max ' arrive as
  // plain strings the API will reject one request at a time.
  if (!EFFORTS.includes(scoring.effort)) {
    throw new ConfigError(`scoring.effort must be one of ${EFFORTS.join(', ')}, got '${scoring.effort}'`);
  }
  // The Batch API is specified but not built in this plan. Accepting the key
  // silently would leave a config option that does nothing — say so instead.
  //
  // Typed, not truthiness-checked: `batch: "true"` is a string, which YAML
  // produces from `batch: "true"` or `batch: yes!`, and which used to sail
  // past both the `=== true` rejection here and any later `if (batch)` as a
  // truthy value. A key that means "spend money differently" has to be a
  // boolean or an error, never a maybe.
  if (typeof scoring.batch !== 'boolean') {
    throw new ConfigError(`scoring.batch must be true or false, got ${JSON.stringify(scoring.batch)}`);
  }
  if (scoring.batch) {
    throw new ConfigError(
      'scoring.batch is not implemented yet — the Batch API is planned but unbuilt, so leave it false'
    );
  }
  if (raw.scoring?.rubric !== undefined && raw.scoring?.rubric !== null) {
    if (typeof raw.scoring.rubric !== 'string') {
      throw new ConfigError('scoring.rubric must be a path string');
    }
    // An empty string is absence, not a path: resolve('') returns the config's
    // own directory, and the provider would then try to read a directory as a
    // rubric and fail at scoring time with a baffling EISDIR.
    if (raw.scoring.rubric.trim() !== '') {
      scoring.rubric = resolve(baseDir, raw.scoring.rubric);
    }
  }

  // resolve() throws a raw TypeError on a non-string, which the CLI reports as
  // exit 1 (unexpected) instead of the exit 2 the config contract promises.
  // `output: {dir: 2026}` is a plausible YAML slip, so it must be a ConfigError.
  const rawDir = raw.output?.dir;
  if (rawDir !== undefined && rawDir !== null && typeof rawDir !== 'string') {
    throw new ConfigError(`output.dir must be a string path, got ${typeof rawDir}`);
  }
  const output = {
    dir: resolve(baseDir, rawDir ?? './digests'),
    format: raw.output?.format ?? 'markdown',
  };
  if (!FORMATS.includes(output.format)) {
    throw new ConfigError(`output.format must be one of ${FORMATS.join(', ')}, got '${output.format}'`);
  }

  const retentionDays = raw.dedupe?.retentionDays ?? 30;
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new ConfigError('dedupe.retentionDays must be a positive integer');
  }

  const seenIds = new Set();

  const excludeRules = raw.rules?.exclude ?? [];
  if (!Array.isArray(excludeRules)) {
    throw new ConfigError('rules.exclude must be a list');
  }

  const annotateRules = raw.rules?.annotate ?? [];
  if (!Array.isArray(annotateRules)) {
    throw new ConfigError('rules.annotate must be a list');
  }

  if (raw.profile !== undefined && raw.profile !== null && typeof raw.profile !== 'string') {
    throw new ConfigError(`profile must be a string path, got ${typeof raw.profile}`);
  }
  const profile = raw.profile ? resolve(baseDir, raw.profile) : null;

  // An LLM provider scores against the profile, so a missing one is a config
  // error rather than a surprise at scoring time — after the crawl is paid for.
  if (scoring.provider !== 'none' && !profile) {
    throw new ConfigError(`scoring.provider '${scoring.provider}' needs 'profile' to be set`);
  }

  return {
    profile,
    scoring,
    output,
    dedupe: { retentionDays },
    rules: {
      exclude: excludeRules.map((r, i) => compileRule(r, 'exclude', i)),
      annotate: annotateRules.map((r, i) => compileRule(r, 'annotate', i)),
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
