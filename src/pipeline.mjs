import { getAdapter } from './adapters/index.mjs';
import { getProvider } from './scoring/index.mjs';
import { applyRules } from './rules.mjs';
import { isSeen } from './dedupe.mjs';
import { createHttp } from './http.mjs';
import { assertScoreContract } from './scoring/contract.mjs';
import { unscored } from './scoring/prompt.mjs';

/**
 * Run the pipeline over a config.
 *
 * Deliberately does no disk I/O: `seen` comes in, postings and stats go out.
 * The CLI owns reading and writing state, which keeps this function testable
 * without a filesystem and makes it reusable from a library consumer.
 *
 * `stats.excludedIds` and `stats.enrichmentFetches` are reported so a caller
 * can see what the rules dropped and what enrichment cost. Neither is state:
 * excluded ids are deliberately not persisted (see the rule loop below).
 *
 * @param {object} config
 * @param {{seen?: object, browser?: boolean, http?: Function, logger?: object}} [opts]
 * @returns {Promise<{postings: object[], stats: {scanned: number, excluded: number,
 *   excludedIds: string[], alreadySeen: number, kept: number, enrichmentFetches: number,
 *   siteErrors: {site: string, error: string}[], scoringError: string|null}}>}
 */
export async function run(config, { seen = {}, browser = false, http, logger = console } = {}) {
  const ctx = { http: http ?? createHttp({}), logger, timeoutMs: 25_000 };

  // Resolve the scoring provider before any network work. config.mjs's
  // PROVIDERS list and this registry are maintained separately, so a provider
  // id that passes config validation but was never registered here must fail
  // in the first second of the run, not after every site has been crawled and
  // every enrichment request paid for. This mirrors getAdapter below, which
  // already fails fast in the `active` filter.
  const provider = getProvider(config.scoring.provider);

  // A provider's precondition (an API key, a binary on PATH) is checked here,
  // before a single site is fetched — discovering a missing key after paying
  // for a full crawl is the failure this ordering exists to prevent.
  provider.checkPrecondition?.(config.scoring);

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

  // Spec: zero postings across *all* sites is an error, not an empty digest.
  // Adapters return [] rather than throw when a response changes shape, so a
  // renamed field yields a 200, valid JSON, and nothing at all — and a user on
  // a daily schedule would read "No new postings today" for months without
  // ever learning the tool had broken.
  if (active.length > 0 && scanned === 0) {
    throw new Error(
      `all ${active.length} site(s) returned zero postings — a board that is genuinely empty is rare; ` +
      'this usually means an adapter has gone stale or a site changed its response shape'
    );
  }

  let alreadySeen = 0;
  let excluded = 0;
  // Reported, never persisted. Recording an exclusion in seen.json would make
  // the redundant detail fetch go away, at the cost of a worse bug: a user who
  // later loosens a rule would never be shown those postings again. Rules stay
  // live and editable, so an excluded posting is reconsidered on every run.
  const excludedIds = [];
  const survivors = [];
  for (const entry of withinRun.values()) {
    if (isSeen(seen, entry.posting.id)) {
      alreadySeen += 1;
      continue;
    }
    const verdict = applyRules(entry.posting, config.rules);
    if (!verdict.keep) {
      excluded += 1;
      excludedIds.push(entry.posting.id);
      continue;
    }
    survivors.push({ ...entry, posting: { ...entry.posting, notes: verdict.notes } });
  }

  // --- enrich: only adapters that do not ship descriptions, only survivors ---
  // Counted so the cost of the second request per posting is visible in the
  // stats rather than invisible: postings excluded on their description below
  // are re-fetched on every run, by design.
  let enrichmentFetches = 0;
  for (const entry of survivors) {
    if (entry.adapter.yieldsDescription) continue;
    if (typeof entry.adapter.fetchDescription !== 'function') continue;
    entry.posting.description = await entry.adapter.fetchDescription(entry.posting, entry.site, ctx);
    enrichmentFetches += 1;
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
      excludedIds.push(entry.posting.id);
      continue;
    }
    enriched.push({ ...entry.posting, notes: verdict.notes });
  }

  // --- score ---
  // A scoring failure must not discard the crawl. Fall back to unscored
  // postings and report the reason; the CLI still writes a digest and exits 4.
  let postings;
  let scoringError = null;
  try {
    postings = await provider.score(enriched, { ...config.scoring, profile: config.profile });
    assertScoreContract(enriched, postings);
  } catch (err) {
    scoringError = err.message;
    postings = enriched.map((p) => unscored(p, err.message));
  }

  // Per-posting degradation is deliberate, but if NOTHING scored, the cause is
  // systemic (a missing binary, a revoked key, no network) and a silent exit 0
  // with a digest full of [—] would hide it. Set the flag without re-mapping
  // the postings, so each one keeps the specific reason it already carries.
  if (scoringError === null && enriched.length > 0 && postings.every((p) => p.score === null)) {
    scoringError = `no posting could be scored — first reason: ${postings[0].rationale}`;
  }

  return {
    postings,
    stats: {
      scanned,
      excluded,
      excludedIds,
      alreadySeen,
      kept: postings.length,
      enrichmentFetches,
      siteErrors,
      scoringError,
    },
  };
}
