import { ConfigError } from '../config.mjs';
import { SCORE_SCHEMA, buildPostingBlock, buildPrefixFromSources, unscored } from './prompt.mjs';

const SDK = '@anthropic-ai/sdk';

/**
 * The response cap, not a spend commitment: unused tokens cost nothing, and
 * every token this does not allow is a truncated response that has already
 * been paid for. Thinking tokens count against it, and this runs adaptive
 * thinking at effort `high` by default, so the old 1024 left very little room
 * for the answer itself — and a systematic truncation would leave every
 * posting unscored after a full crawl.
 */
const MAX_TOKENS = 4096;

/**
 * The SDK is an optional peer dependency: someone scoring by keyword should
 * not have to install it. Load it only when this provider is actually in use.
 *
 * Separate from createClient so the precondition can prove the package is
 * there before the crawl, rather than throwing out of score() once every site
 * has been fetched and every enrichment request paid for.
 */
async function loadSdk() {
  try {
    return (await import(SDK)).default;
  } catch {
    throw new ConfigError(
      `scoring.provider 'anthropic' needs the ${SDK} package — install it with: npm install ${SDK}`
    );
  }
}

async function createClient() {
  const Anthropic = await loadSdk();
  return new Anthropic();
}

/** Run `jobs` with at most `limit` in flight, preserving input order. */
async function pool(jobs, limit) {
  const results = new Array(jobs.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next;
      next += 1;
      results[i] = await jobs[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

export default {
  id: 'anthropic',

  /**
   * Everything this provider needs before a single site is fetched: the key,
   * the two files it reads, and the SDK itself. Discovering any of them after
   * paying for a full crawl is the failure this exists to prevent — and until
   * this was awaited it could only check the key, because the other two
   * require a promise.
   *
   * Ordered cheapest-first: an env var, then two local reads, then a module
   * load, so the commonest mistake is reported without doing the other work.
   */
  async checkPrecondition(opts = {}) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new ConfigError(
        "scoring.provider 'anthropic' needs ANTHROPIC_API_KEY in the environment"
      );
    }
    // Reads both files and throws ConfigError naming whichever is unreadable.
    // The result is discarded: reading them twice costs nothing next to a
    // crawl, and proving them readable here is the whole point.
    buildPrefixFromSources({ rubric: opts.rubric, profile: opts.profile });
    await loadSdk();
  },

  async score(postings, opts = {}) {
    if (postings.length === 0) return [];

    const client = opts.client ?? (await createClient());
    const prefix = buildPrefixFromSources({ rubric: opts.rubric, profile: opts.profile });

    const jobs = postings.map((posting) => async () => {
      try {
        const res = await client.messages.parse({
          model: opts.model,
          max_tokens: MAX_TOKENS,
          system: [{ type: 'text', text: prefix, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: buildPostingBlock(posting) }],
          thinking: { type: 'adaptive' },
          output_config: {
            format: { type: 'json_schema', schema: SCORE_SCHEMA },
            effort: opts.effort,
          },
        });

        // A refusal is a 200 with no parsed output — check stop_reason before
        // reading content, and degrade this posting rather than the run.
        if (res.stop_reason === 'refusal') {
          return unscored(posting, `the model refused (${res.stop_details?.category ?? 'no category'})`);
        }
        // Truncation is also a 200 with a null parsed_output, and it would
        // otherwise be reported as "the response did not match the score
        // schema" — a wrong diagnosis that sends the reader looking at the
        // schema instead of at max_tokens. It is worth naming separately
        // because it is the failure that can happen on *every* posting at
        // once, after the whole run has been paid for.
        if (res.stop_reason === 'max_tokens') {
          return unscored(posting, 'the response hit max_tokens before completing');
        }
        if (!res.parsed_output) {
          return unscored(posting, 'the response did not match the score schema');
        }
        return {
          ...posting,
          score: res.parsed_output.score,
          rationale: res.parsed_output.rationale,
          verdict: 'keep',
        };
      } catch (err) {
        return unscored(posting, err.message);
      }
    });

    return pool(jobs, opts.concurrency ?? 5);
  },
};
