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
