import { spawn } from 'node:child_process';
import { ConfigError } from '../config.mjs';
import { buildPostingBlock, buildPrefixFromSources, unscored } from './prompt.mjs';

const BATCH = 10;
const TIMEOUT_MS = 180_000;

/**
 * Which binary to invoke. Overridable via JOBCANARY_CLAUDE_BIN for anyone
 * whose `claude` is not a bare name on PATH (a wrapper script, an unusual
 * install location), and it doubles as a deterministic way to point this
 * provider at a binary that is guaranteed not to exist.
 *
 * Read on every call rather than captured at import: the env var is how a
 * test points this provider at a stub, and a module-level constant would
 * freeze whatever the environment happened to be when the module loaded.
 */
const claudeBin = () => process.env.JOBCANARY_CLAUDE_BIN || 'claude';

/**
 * Spawn the CLI, hand it `input` on stdin, and resolve with its stdout.
 *
 * The prompt goes over stdin and never over argv: a ten-posting batch runs to
 * tens of kilobytes and would blow through Windows' ~32 KB command-line limit.
 * It is written explicitly here because `input` is an option of the *Sync*
 * spawn/exec family only — async `execFile` silently discards it, leaving the
 * child with a piped stdin that is never written and never closed, so a CLI
 * that reads stdin to EOF hangs until the timeout fires. That was this
 * provider's behaviour on every real invocation.
 */
function spawnClaude(args, { input = '', timeoutMs }) {
  return new Promise((resolve, reject) => {
    // On Windows the `claude` on PATH is a .cmd shim, and since Node 18.20 /
    // 20.12 spawning a .cmd without a shell throws EINVAL outright — so this
    // provider could not run there at all without the shell. The command line
    // is passed as one string because the shell-plus-args form is deprecated
    // (DEP0190); the only thing interpolated into it is the binary path from
    // the environment, since the prompt itself goes over stdin.
    const child = process.platform === 'win32'
      ? spawn(`"${claudeBin()}" ${args.join(' ')}`, { shell: true, timeout: timeoutMs, windowsHide: true })
      : spawn(claudeBin(), args, { timeout: timeoutMs });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) return resolve(stdout);
      const detail = stderr.trim().slice(0, 200);
      return reject(new Error(
        signal
          ? `claude was killed by ${signal} after ${timeoutMs} ms${detail ? `: ${detail}` : ''}`
          : `claude exited ${code}${detail ? `: ${detail}` : ''}`
      ));
    });
    // A child that exits before draining stdin makes this write emit EPIPE.
    // An unhandled 'error' on the stream would take the whole run down over a
    // child that already said what it had to say.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** Default runner: pipe the prompt to `claude -p` and return its stdout. */
function runClaude(prompt) {
  return spawnClaude(['-p'], { input: prompt, timeoutMs: TIMEOUT_MS });
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
    const prefix = buildPrefixFromSources({ rubric: opts.rubric, profile: opts.profile });

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
