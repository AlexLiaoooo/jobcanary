import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { ConfigError } from '../config.mjs';
import { DEFAULT_RUBRIC, buildPostingBlock, buildPrefix, unscored } from './prompt.mjs';

const execFileAsync = promisify(execFile);
const BATCH = 10;
const TIMEOUT_MS = 180_000;

function readOr(path, fallback, label) {
  if (!path) return fallback;
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigError(`could not read ${label} at ${path}: ${err.message}`);
  }
}

/** Default runner: pipe the prompt to `claude -p` and return its stdout. */
async function runClaude(prompt) {
  const { stdout } = await execFileAsync('claude', ['-p'], {
    input: prompt,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

/** Tolerate a fenced code block around the JSON, which the CLI often adds. */
function parseScores(stdout) {
  const fenced = stdout.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : stdout).trim();
  const data = JSON.parse(body);
  if (!Array.isArray(data.scores)) throw new Error("expected a 'scores' array");
  return data.scores;
}

function buildBatchPrompt(prefix, batch) {
  const blocks = batch.map((p) => `<posting id="${p.id}">\n${buildPostingBlock(p)}\n</posting>`);
  return [
    prefix,
    '',
    '## Postings',
    '',
    ...blocks,
    '',
    '## Output',
    '',
    'Reply with JSON only, no prose and no explanation outside it:',
    '{"scores":[{"id":"<the posting id, copied exactly>","score":<1-10>,"rationale":"<one sentence>"}]}',
    '',
    'Include one entry for every posting above, echoing its id exactly.',
  ].join('\n');
}

export default {
  id: 'claude-cli',

  checkPrecondition() {
    // Presence of the binary is checked lazily by the first invocation; what
    // matters here is failing before the crawl when it is obviously absent.
    if (process.env.JOBCANARY_SKIP_CLI_CHECK === '1') return;
    if (!process.env.PATH) {
      throw new ConfigError("scoring.provider 'claude-cli' needs the claude binary on PATH");
    }
  },

  /**
   * Batches ten postings per invocation: each call is a process spawn of one
   * to two seconds, so per-posting calls would spend a minute doing nothing.
   *
   * Batching reintroduces the pairing risk that the anthropic provider avoids
   * by construction, so results are matched on the echoed id and never on
   * position. A posting the model forgets comes back unscored rather than
   * silently taking another posting's score.
   */
  async score(postings, opts = {}) {
    if (postings.length === 0) return [];

    const exec = opts.exec ?? runClaude;
    const prefix = buildPrefix({
      rubric: readOr(opts.rubric, DEFAULT_RUBRIC, 'scoring.rubric'),
      profile: readOr(opts.profile, '', 'profile'),
    });

    const scored = new Map();
    for (let i = 0; i < postings.length; i += BATCH) {
      const batch = postings.slice(i, i + BATCH);
      try {
        for (const row of parseScores(await exec(buildBatchPrompt(prefix, batch)))) {
          scored.set(row.id, row);
        }
      } catch (err) {
        // This batch is lost; the rest of the run is not.
        for (const p of batch) scored.set(p.id, { id: p.id, error: err.message });
      }
    }

    return postings.map((posting) => {
      const row = scored.get(posting.id);
      if (!row) return unscored(posting, 'the model returned no score for this posting');
      if (row.error) return unscored(posting, row.error);
      return { ...posting, score: row.score, rationale: row.rationale, verdict: 'keep' };
    });
  },
};
