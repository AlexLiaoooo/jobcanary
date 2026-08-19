import { makePosting, stripHtml } from '../posting.mjs';

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
    const res = await ctx.http(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      throw new Error(`greenhouse board '${site.board}' returned HTTP ${res.status}`);
    }

    let data;
    try {
      data = JSON.parse(res.text);
    } catch {
      throw new Error(`greenhouse board '${site.board}' returned a body that is not valid JSON`);
    }

    return (data.jobs ?? []).map((job) =>
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
