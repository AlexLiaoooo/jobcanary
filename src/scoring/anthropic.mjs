import { ConfigError } from '../config.mjs';
import { SCORE_SCHEMA, buildPostingBlock, buildPrefixFromSources, unscored } from './prompt.mjs';

const SDK = '@anthropic-ai/sdk';

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
          max_tokens: 1024,
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
