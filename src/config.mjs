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
 * Plain strings are matched case-insensitively as literals (escaped for regex metacharacters).
 * /body/flags syntax creates a real regex using exactly the flags given, so /PhD/ is case-sensitive while /PhD/i is not.
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

  const seenIds = new Set();

  const excludeRules = raw.rules?.exclude ?? [];
  if (!Array.isArray(excludeRules)) {
    throw new ConfigError('rules.exclude must be a list');
  }

  const annotateRules = raw.rules?.annotate ?? [];
  if (!Array.isArray(annotateRules)) {
    throw new ConfigError('rules.annotate must be a list');
  }

  return {
    profile: raw.profile ? resolve(baseDir, raw.profile) : null,
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
