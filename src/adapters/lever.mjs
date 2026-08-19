import { makePosting } from '../posting.mjs';
import { fetchJson, mapRows } from './fetch-json.mjs';

/**
 * Convert Lever's epoch-millisecond `createdAt` to an ISO date.
 *
 * `Number.isFinite` alone is not enough: 1e20 is finite but out of Date's
 * range, and `new Date(1e20).toISOString()` throws `RangeError: Invalid time
 * value`. An unusable date is not worth losing a board over, so it becomes
 * null like any other missing field.
 */
function isoDateFromEpochMs(ms) {
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

/**
 * Lever exposes an unauthenticated postings API returning a bare JSON array.
 * `descriptionPlain` is already text, so no HTML stripping is needed.
 *
 * Site config: { id, company, type: 'lever', board: '<lever-account>' }
 */
export default {
  id: 'lever',
  tier: 'http',
  yieldsDescription: true,

  async fetch(site, ctx) {
    if (!site.board) throw new Error(`site '${site.id}' needs 'board' for the lever adapter`);

    const url = `https://api.lever.co/v0/postings/${site.board}?mode=json`;
    const jobs = await fetchJson(
      ctx,
      url,
      { headers: { Accept: 'application/json' } },
      `lever board '${site.board}'`,
      { array: true }
    );

    return mapRows(jobs, ctx, site, (job) =>
      makePosting({
        site,
        nativeId: job.id,
        title: job.text,
        url: job.hostedUrl,
        location: job.categories?.location ?? '',
        description: job.descriptionPlain ?? '',
        // Lever sends epoch milliseconds, not a date string.
        postedAt: isoDateFromEpochMs(job.createdAt),
      })
    );
  },
};
