import { makePosting, stripHtml } from '../posting.mjs';
import { fetchJson, mapRows } from './fetch-json.mjs';

/**
 * Greenhouse job boards expose an unauthenticated JSON API. With
 * `content=true` the full description ships in the listing, so this adapter
 * never needs a second request per posting.
 *
 * Site config: { id, company, type: 'greenhouse', board: '<board-token>' }
 */
export default {
  id: 'greenhouse',
  tier: 'http',
  yieldsDescription: true,

  async fetch(site, ctx) {
    if (!site.board) throw new Error(`site '${site.id}' needs 'board' for the greenhouse adapter`);

    const url = `https://boards-api.greenhouse.io/v1/boards/${site.board}/jobs?content=true`;
    const jobs = await fetchJson(
      ctx,
      url,
      { headers: { Accept: 'application/json' } },
      `greenhouse board '${site.board}'`,
      // A 200 whose body carries no `jobs` array is a broken board, not an
      // empty one. Reporting zero postings would hide a renamed field forever.
      { arrayAt: 'jobs' }
    );

    return mapRows(jobs, ctx, site, (job) =>
      makePosting({
        site,
        nativeId: job.id,
        title: job.title,
        url: job.absolute_url,
        location: job.location?.name ?? '',
        // Greenhouse serves `content` HTML-escaped, so it needs two passes:
        // once to turn &lt;p&gt; into <p>, once to turn that into text.
        description: stripHtml(stripHtml(job.content)),
        postedAt: job.updated_at ? job.updated_at.slice(0, 10) : null,
      })
    );
  },
};
