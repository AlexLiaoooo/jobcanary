#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
  -p, --preset <name>   Not available yet — no presets are bundled in this release
      --out <dir>       Override the output directory
      --browser         Include browser-tier sites
      --dry             Fetch and report, but write nothing
  -h, --help            Show this help

Exit codes: 0 ok · 1 unexpected · 2 config invalid · 3 all sites failed or no postings · 4 scoring failed
`.trim();

function today() {
  return new Date().toISOString().slice(0, 10);
}

const DIGEST_EXTS = ['md', 'json'];

/**
 * Decide which file stem this run's digest should be written under.
 *
 * A digest is named for the day, but a day can hold more than one run, so the
 * two can collide. Never overwrite: if today's digest already exists, a run
 * with nothing new leaves it alone (returns null), and a run that did find
 * something writes alongside it as `<date>-2`, `-3`, and so on.
 *
 * @returns {string|null} the stem to write, or null to write nothing
 */
export function digestStem(dir, date, hasPostings) {
  const taken = (stem) => DIGEST_EXTS.some((ext) => existsSync(join(dir, `${stem}.${ext}`)));
  if (!taken(date)) return date;
  if (!hasPostings) return null;
  for (let n = 2; ; n += 1) {
    if (!taken(`${date}-${n}`)) return `${date}-${n}`;
  }
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

  // The flag is kept so the failure is a sentence rather than a puzzle: with a
  // presets/ directory that does not exist on this branch, resolving the path
  // produced a bare "could not read config at .../presets/x.yaml".
  if (values.preset !== undefined) {
    throw new ConfigError(
      `--preset is not available yet: no presets are bundled in this release, so there is no preset '${values.preset}'. ` +
      'Write a config file and pass it with --config <path> instead.'
    );
  }

  const configPath = resolve(values.config ?? './jobcanary.yaml');

  const config = loadConfig(configPath);
  if (values.out) config.output.dir = resolve(values.out);

  const date = today();
  const seenPath = join(config.output.dir, 'seen.json');
  // A dry run still consults seen state, so its counts match what a real run
  // would report. It just does not write anything back.
  const seen = loadSeen(seenPath);

  const { postings, stats } = await run(config, { seen, browser: values.browser });

  // enrichmentFetches is in the summary because it is the run's hidden cost:
  // a posting excluded on its description is re-fetched every run by design,
  // and a number nobody can see is a number nobody can act on.
  console.log(
    `scanned=${stats.scanned} seen=${stats.alreadySeen} excluded=${stats.excluded} ` +
    `kept=${stats.kept} enrichmentFetches=${stats.enrichmentFetches} siteErrors=${stats.siteErrors.length}`
  );

  if (values.dry) {
    console.log('--dry: nothing written');
    return 0;
  }

  mkdirSync(config.output.dir, { recursive: true });

  const stem = digestStem(config.output.dir, date, postings.length > 0);
  if (stem === null) {
    // Today's digest exists and this run found nothing new. Overwriting it
    // would replace a real digest with "No new postings today" — a second run
    // on the same day used to destroy the first one's results.
    console.log(`nothing new since the digest already written for ${date} — left it untouched`);
  } else {
    if (config.output.format === 'markdown' || config.output.format === 'both') {
      const md = renderDigest(postings, { date, scanned: stats.scanned, siteErrors: stats.siteErrors });
      const target = join(config.output.dir, `${stem}.md`);
      writeFileSync(target, md, 'utf8');
      console.log(`wrote ${target}`);
    }
    if (config.output.format === 'json' || config.output.format === 'both') {
      const target = join(config.output.dir, `${stem}.json`);
      writeFileSync(target, JSON.stringify({ date, stats, postings }, null, 2), 'utf8');
      console.log(`wrote ${target}`);
    }
  }

  let next = seen;
  for (const p of postings) next = recordSeen(next, p.id, date);
  saveSeen(seenPath, pruneSeen(next, date, config.dedupe.retentionDays));

  return 0;
}

// Set process.exitCode and let the event loop drain naturally, rather than
// calling process.exit(). process.exit() tears the process down while undici
// may still have sockets and abort timers in flight, which fast-fails with a
// native libuv assertion on Windows; process.exitCode lets everything close
// on its own and produces the documented exit code on every platform.
try {
  process.exitCode = await main();
} catch (err) {
  if (err instanceof ConfigError || /unknown adapter type|unknown scoring provider/.test(err.message)) {
    console.error(`config error: ${err.message}`);
    process.exitCode = 2;
  } else if (/^all \d+ site\(s\) (failed|returned zero postings)/.test(err.message)) {
    console.error(err.message);
    process.exitCode = 3;
  } else {
    console.error(err.stack ?? err.message);
    process.exitCode = 1;
  }
}
