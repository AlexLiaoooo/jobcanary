import { makePosting, stripHtml } from '../posting.mjs';
import { fetchJson, mapRows } from './fetch-json.mjs';

const PAGE = 20;        // Workday CXS silently caps `limit` at 20.
const MAX_PAGES = 5;    // 100 postings is plenty for a daily monitor.

function requireFields(site) {
  if (!site.host || !site.tenant || !site.board) {
    throw new Error(`site '${site.id}' needs 'host', 'tenant' and 'board' for the workday adapter`);
  }
}

const cxsBase = (site) => `${site.host}/wday/cxs/${site.tenant}/${site.board}`;

/**
 * Workday's CXS endpoint is unauthenticated but POST-only and paginated.
 * The listing carries no description, so `yieldsDescription` is false and the
 * pipeline calls `fetchDescription` for the postings that survive the rules.
 *
 * Site config:
 *   { id, company, type: 'workday', host: 'https://x.wd3.myworkdayjobs.com',
 *     tenant: 'x', board: 'External' }
 */
export default {
  id: 'workday',
  tier: 'http',
  yieldsDescription: false,

  async fetch(site, ctx) {
    requireFields(site);
    const url = `${cxsBase(site)}/jobs`;
    const out = [];

    for (let page = 0; page < MAX_PAGES; page += 1) {
      let rows;
      try {
        rows = await fetchJson(
          ctx,
          url,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
              appliedFacets: {}, limit: PAGE, offset: page * PAGE, searchText: site.searchText ?? '',
            }),
          },
          `workday tenant '${site.tenant}'`,
          // No `jobPostings` array means the endpoint changed shape; that is a
          // site error, not a tenant with no vacancies.
          { arrayAt: 'jobPostings' }
        );
      } catch (err) {
        if (page === 0) throw err;
        break; // a later page failing still leaves earlier pages usable
      }

      out.push(...mapRows(rows, ctx, site, (job) => {
        const path = job.externalPath ?? '';
        return makePosting({
          site,
          // bulletFields normally carries the requisition id; the slug is the fallback.
          nativeId: job.bulletFields?.[0] ?? path.split('/').pop() ?? path,
          title: job.title,
          url: `${site.host}/en-US/${site.board}${path}`,
          location: job.locationsText ?? '',
          description: '',
          postedAt: null, // `postedOn` is prose ("Posted 2 Days Ago"), not a date
        });
      }));

      if (rows.length < PAGE) break;
    }

    return out;
  },

  /**
   * Fetch one posting's description. Returns '' on any failure — a missing
   * description must never abort a run that has already fetched a full listing.
   */
  async fetchDescription(posting, site, ctx) {
    requireFields(site);
    const path = new URL(posting.url).pathname.replace(`/en-US/${site.board}`, '');
    try {
      const res = await ctx.http(`${cxsBase(site)}${path}`, { headers: { Accept: 'application/json' } });
      if (!res.ok) return '';
      const data = JSON.parse(res.text);
      return stripHtml(data.jobPostingInfo?.jobDescription ?? '');
    } catch {
      return '';
    }
  },
};
