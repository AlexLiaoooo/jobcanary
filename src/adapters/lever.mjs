import { makePosting } from '../posting.mjs';

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
    const res = await ctx.http(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`lever board '${site.board}' returned HTTP ${res.status}`);

    let data;
    try {
      data = JSON.parse(res.text);
    } catch {
      throw new Error(`lever board '${site.board}' returned a body that is not valid JSON`);
    }
    if (!Array.isArray(data)) {
      throw new Error(`lever board '${site.board}': expected a JSON array of postings`);
    }

    return data.map((job) =>
      makePosting({
        site,
        nativeId: job.id,
        title: job.text,
        url: job.hostedUrl,
        location: job.categories?.location ?? '',
        description: job.descriptionPlain ?? '',
        // Lever sends epoch milliseconds, not a date string.
        postedAt: Number.isFinite(job.createdAt)
          ? new Date(job.createdAt).toISOString().slice(0, 10)
          : null,
      })
    );
  },
};
