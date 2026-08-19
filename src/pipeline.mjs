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

  // Resolve the scoring provider before any network work. A provider the
  // config blesses but the registry does not know about (today: anthropic and
  // claude-cli) must fail on the first second of the run, not after every site
  // has been crawled and every enrichment request paid for. This mirrors
  // getAdapter below, which already fails fast in the `active` filter.
  const provider = getProvider(config.scoring.provider);

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
  const postings = await provider.score(enriched, { ...config.scoring, profile: config.profile });

  return {
    postings,
    stats: { scanned, excluded, alreadySeen, kept: postings.length, siteErrors },
  };
}
