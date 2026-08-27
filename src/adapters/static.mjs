import { makePosting, stripHtml } from '../posting.mjs';

const DESCRIPTION_CAP = 8000;

// Anchor text that is a call to action rather than a job title. A page whose
// only link text is "Apply" or "Find out more" is common enough that the
// titleFromSlug escape hatch exists for it.
const JUNK_TEXT = /^(apply|read more|view|see|learn more|find out more|more info|details|share|login|log in|sign)/i;
const MIN_TITLE = 4;
const MAX_TITLE = 160;

/**
 * Compile a `/body/flags` string from site config into a RegExp.
 *
 * Static sites are the one adapter that genuinely needs regexes in config —
 * every other adapter talks to a typed API. They are compiled here rather than
 * in config.mjs so the config loader stays adapter-agnostic: nine more
 * adapters are coming and none of them should teach it new field names.
 */
function compileSiteRegex(spec, field, siteId) {
  const m = String(spec).match(/^\/(.*)\/([gimsuy]*)$/s);
  const [body, flags] = m ? [m[1], m[2]] : [String(spec), 'i'];
  try {
    // g and y make .test() stateful across calls; the patterns here are reused
    // against every anchor on the page, so they must not carry position.
    return new RegExp(body, flags.replace(/[gy]/g, ''));
  } catch (err) {
    throw new Error(`site '${siteId}' has an invalid ${field}: ${err.message}`);
  }
}

const compileList = (specs, field, siteId) =>
  (specs ?? []).map((s, i) => compileSiteRegex(s, `${field}[${i}]`, siteId));

/**
 * Harvest `<a href>` pairs whose href matches `pattern`.
 *
 * Returns a Map keyed by absolute url, holding the longest title seen for it:
 * a job usually appears once with its real title and again as "Apply" or
 * inside a nav, and the longest text is reliably the real one.
 */
function harvestAnchors(html, pattern, baseUrl, { allowJunkText }) {
  const found = new Map();
  const anchor = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  for (const [, href, inner] of html.matchAll(anchor)) {
    if (!pattern.test(href)) continue;

    let title = stripHtml(inner);
    const junk = !title || title.length < MIN_TITLE || title.length > MAX_TITLE || JUNK_TEXT.test(title);
    if (junk && !allowJunkText) continue;

    let url = href;
    try {
      url = new URL(href, baseUrl).toString();
    } catch {
      // A malformed href is not worth losing the rest of the page over.
      continue;
    }

    const previous = found.get(url);
    if (!previous || title.length > previous.length) found.set(url, title);
  }
  return found;
}

/** Turn a url slug into a readable title: "aero-design-engineer" -> "Aero Design Engineer". */
function titleFromSlug(url, slugStrip) {
  let slug;
  try {
    slug = decodeURIComponent(new URL(url).pathname.replace(/\/+$/, '').split('/').pop() ?? '');
  } catch {
    return '';
  }
  for (const re of slugStrip) slug = slug.replace(re, '');
  return slug
    .split('-')
    .filter(Boolean)
    .map((w) => (/^(and|of|the|for|in|at|to)$/i.test(w) ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ')
    .trim();
}

function cleanTitle(title, url, site, compiled) {
  let out = title;
  if (site.titleFromSlug) {
    const fromSlug = titleFromSlug(url, compiled.slugStrip);
    if (fromSlug.length >= MIN_TITLE) out = fromSlug;
  }
  if (site.titleSplit && out.includes(site.titleSplit)) {
    out = out.split(site.titleSplit)[0];
  }
  for (const re of compiled.titleStrip) out = out.replace(re, '');
  return out.replace(/\s{2,}/g, ' ').trim();
}

// Containers whose contents are page furniture, not the advert. Matched by
// tag, and by the class/id names that carry the same meaning in a div soup.
const CHROME_TAGS = /<(nav|header|footer|aside|form|script|style|noscript|svg|select)\b[\s\S]*?<\/\1>/gi;
const CHROME_ATTRS =
  /<(div|section|ul|ol)\b[^>]*(?:class|id)\s*=\s*["'][^"']*\b(nav|menu|sidebar|side-bar|breadcrumb|cookie|consent|related|similar|share|social|search|filter|pagination|skip-link|banner)\b[^"']*["'][\s\S]*?<\/\1>/gi;

/**
 * Reduce a job page to the advert text.
 *
 * A live run against real career sites showed why this needs more than tag
 * stripping: the first attempt returned 7,000 characters that opened with a
 * page title and a run of empty bullets, and matched "aero", "design" and
 * "engineer" from a site-wide category list on a health-and-safety vacancy.
 * Feeding that to a scoring model is worse than feeding it nothing — a thin
 * description makes the model cautious, a noisy one makes it confident and
 * wrong.
 *
 * So: prefer a semantic main/article container when the page has one, fall
 * back to the densest block of text, and drop the empty list items that turn
 * a nav into a wall of bullets.
 *
 * @param {string} html
 * @returns {string}
 */
export function extractDescription(html) {
  if (!html || typeof html !== 'string') return '';

  const cleaned = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(CHROME_TAGS, ' ').replace(CHROME_ATTRS, ' ');

  // A page with <main> or <article> has told us where the content is; believe
  // it. Otherwise take the longest text run, which on a job page is the advert.
  const semantic = cleaned.match(/<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i);
  const source = semantic
    ? semantic[2]
    : [...cleaned.matchAll(/<(div|section)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
        .map((m) => m[2])
        .reduce((best, block) => (stripHtml(block).length > stripHtml(best).length ? block : best), cleaned);

  return stripHtml(source)
    .split('\n')
    // An empty list item renders as a bare bullet. Real adverts have text
    // after theirs; navigation, stripped of its links, does not.
    .filter((line) => line.replace(/^[•\s]+/, '').length > 0)
    .join('\n')
    .slice(0, DESCRIPTION_CAP);
}

/** Static sites have no ids, so the url path is the stable identity. */
function nativeIdFor(url) {
  try {
    return new URL(url).pathname.replace(/\/+$/, '') || '/';
  } catch {
    return url;
  }
}

/**
 * Server-rendered career pages: jobs are harvested from `<a>` tags whose href
 * matches a per-site pattern.
 *
 * This is the least structured adapter and the most widely applicable one — a
 * company with no recognised ATS almost always still has a list of links. The
 * cost of that generality is per-site configuration; the typed adapters need
 * none.
 *
 * Site config:
 *   { id, company, type: 'static', url, hrefPattern,
 *     looseHrefPattern?, pages?, titleFromSlug?, slugStrip?,
 *     titleSplit?, titleStrip?, zeroIsOk? }
 */
export default {
  id: 'static',
  tier: 'http',
  yieldsDescription: false,

  async fetch(site, ctx) {
    if (!site.url) throw new Error(`site '${site.id}' needs 'url' for the static adapter`);
    if (!site.hrefPattern) throw new Error(`site '${site.id}' needs 'hrefPattern' for the static adapter`);

    const compiled = {
      href: compileSiteRegex(site.hrefPattern, 'hrefPattern', site.id),
      loose: site.looseHrefPattern
        ? compileSiteRegex(site.looseHrefPattern, 'looseHrefPattern', site.id)
        : null,
      slugStrip: compileList(site.slugStrip, 'slugStrip', site.id),
      titleStrip: compileList(site.titleStrip, 'titleStrip', site.id),
    };

    const urls = [site.url, ...(site.pages ?? [])];
    const allowJunkText = Boolean(site.titleFromSlug);
    const byUrl = new Map();
    let firstStatus = null;

    for (const [index, pageUrl] of urls.entries()) {
      const res = await ctx.http(pageUrl, { headers: { Accept: 'text/html,*/*;q=0.8' } });
      if (index === 0) firstStatus = res.status;

      if (!res.ok) {
        // The first page failing means the site is broken; a later page
        // failing still leaves the earlier pages' postings usable.
        if (index === 0) throw new Error(`static site '${site.id}' returned HTTP ${res.status}`);
        ctx.logger?.warn?.(`[${site.id}] page ${index + 1} returned HTTP ${res.status} — keeping earlier pages`);
        break;
      }

      let hits = harvestAnchors(res.text, compiled.href, pageUrl, { allowJunkText });
      if (hits.size === 0 && compiled.loose) {
        hits = harvestAnchors(res.text, compiled.loose, pageUrl, { allowJunkText });
      }
      for (const [url, title] of hits) if (!byUrl.has(url)) byUrl.set(url, title);
    }

    if (byUrl.size === 0 && !site.zeroIsOk) {
      // A page that renders fine but matches nothing usually means the markup
      // changed, not that the company stopped hiring. Say so rather than
      // reporting zero jobs for ever. `zeroIsOk` marks the boards that really
      // do sit empty.
      throw new Error(
        `static site '${site.id}' returned HTTP ${firstStatus} but found no job links — ` +
          `hrefPattern may be stale, or set zeroIsOk if the board is legitimately empty`
      );
    }

    const postings = [];
    for (const [url, rawTitle] of byUrl) {
      const title = cleanTitle(rawTitle, url, site, compiled);
      if (!title) continue;
      postings.push(makePosting({ site, nativeId: nativeIdFor(url), title, url, description: '' }));
    }
    return postings;
  },

  /**
   * Fetch one posting's page and reduce it to readable text.
   *
   * There is no per-site selector: 53 sites would be 53 selectors to maintain,
   * and a wrong one is worse than a generic pass. Instead the page chrome is
   * removed and what remains is capped. Returns '' on any failure — a missing
   * description must never abort a run that already has a full listing.
   */
  async fetchDescription(posting, site, ctx) {
    try {
      const res = await ctx.http(posting.url, { headers: { Accept: 'text/html,*/*;q=0.8' } });
      if (!res.ok) return '';
      return extractDescription(res.text);
    } catch (err) {
      ctx.logger?.warn?.(`[${site.id}] could not read ${posting.url}: ${err.message}`);
      return '';
    }
  },
};
