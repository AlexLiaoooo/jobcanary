import { makePosting, stripHtml } from '../posting.mjs';
import { escapeLiteral } from '../config.mjs';

const DESCRIPTION_CAP = 8000;

// Anchor text that is a call to action rather than a job title. A page whose
// only link text is "Apply" or "Find out more" is common enough that the
// titleFromSlug escape hatch exists for it.
//
// The short entries are anchored. Unanchored, `^sign`, `^share`, `^see` and
// `^view` silently discarded Signalling Engineer, Signal Processing Engineer,
// Shared Services Analyst, Seed Programme Engineer and Viewpoint Analyst —
// "Signalling Engineer" is a mainstream UK engineering title.
//
// `^sign(\s|$)` still costs "Sign Writer", because the same two words open
// "Sign in" and "Sign up". That one is a knowing trade, not an oversight, and
// the debug line below is what makes it findable.
const JUNK_TEXT =
  /^(apply|read more|learn more|find out more|more info|details|login|log in|sign(\s|$)|share$|see\b|view(\s|$))/i;
const MIN_TITLE = 4;
const MAX_TITLE = 160;

/**
 * Compile a `/body/flags` string from site config into a RegExp.
 *
 * Static sites are the one adapter that genuinely needs regexes in config —
 * every other adapter talks to a typed API. They are compiled here rather than
 * in config.mjs so the config loader stays adapter-agnostic: nine more
 * adapters are coming and none of them should teach it new field names.
 *
 * The two spellings are compileMatcher's, because the README says they are the
 * same: `/body/flags` is a real regex, and anything else is a case-insensitive
 * literal. Compiling a plain string as a pattern instead made
 * `hrefPattern: "job (UK)"` match the href `/job UK/1` — the parentheses became
 * a group — which is silently wrong rather than an error, the worst way for a
 * config field to be misunderstood.
 */
function compileSiteRegex(spec, field, siteId) {
  const m = String(spec).match(/^\/(.*)\/([gimsuy]*)$/s);
  if (!m) return new RegExp(escapeLiteral(String(spec)), 'i');
  try {
    // g and y make .test() stateful across calls; the patterns here are reused
    // against every anchor on the page, so they must not carry position.
    return new RegExp(m[1], m[2].replace(/[gy]/g, ''));
  } catch (err) {
    throw new Error(`site '${siteId}' has an invalid ${field}: ${err.message}`);
  }
}

const compileList = (specs, field, siteId) =>
  (specs ?? []).map((s, i) => compileSiteRegex(s, `${field}[${i}]`, siteId));

/** Why this anchor text cannot be a job title, or '' if it can. */
function junkReason(title) {
  if (!title) return 'is empty';
  if (title.length < MIN_TITLE) return `is under ${MIN_TITLE} characters`;
  if (title.length > MAX_TITLE) return `is over ${MAX_TITLE} characters`;
  if (JUNK_TEXT.test(title)) return 'reads as a call to action rather than a job title';
  return '';
}

/**
 * Harvest `<a href>` pairs whose href matches `pattern`.
 *
 * Returns a Map keyed by absolute url, holding the longest title seen for it:
 * a job usually appears once with its real title and again as "Apply" or
 * inside a nav, and the longest text is reliably the real one.
 *
 * Every rejection is logged at debug. A whole job family can disappear behind
 * one of these rules, and without a line somewhere there is no way for a user
 * to find out why.
 */
function harvestAnchors(html, pattern, baseUrl, { allowJunkText, siteId, logger }) {
  const found = new Map();
  const anchor = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  for (const [, rawHref, inner] of html.matchAll(anchor)) {
    // `&` is written `&amp;` in an href, and the query string is now part of a
    // posting's identity: left encoded, `?id=101&amp;utm_source=x` parses as a
    // parameter literally named "amp;utm_source", which no tracking-parameter
    // list can recognise and which would mint a second id for the same job.
    const href = rawHref.replace(/&amp;/gi, '&');
    if (!pattern.test(href)) continue;

    const title = stripHtml(inner);
    const reason = junkReason(title);
    if (reason && !allowJunkText) {
      logger?.debug?.(`[${siteId}] dropped ${href}: anchor text ${JSON.stringify(title)} ${reason}`);
      continue;
    }

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
  // \s+ rather than \s{2,}: an anchor wrapping a heading and a location line
  // produces a title with a single newline in it, and markdown.mjs interpolates
  // the title straight into a `###` heading — one newline breaks the digest's
  // structure, not just its looks.
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Find the outermost elements of `tags` in `html`, pairing every closing tag
 * with its own opener.
 *
 * A regex cannot match balanced tags, so this stops trying. `<div
 * class="sidebar"><div>…</div>…more…</div>` ends a non-greedy `[\s\S]*?<\/\1>`
 * at the *inner* `</div>` and leaves the rest of the furniture behind — the
 * original failure on a real careers page, verbatim. Depth is counted here
 * instead. Unbalanced markup is skipped rather than guessed at: an element
 * whose closing tag never arrives is simply not reported.
 *
 * @param {string} html
 * @param {string[]} tags lower-case tag names
 * @returns {{tag: string, attrs: string, start: number, innerStart: number,
 *   innerEnd: number, end: number, inner: string}[]} in document order
 */
function findElements(html, tags) {
  // (?![-\w]) rather than \b so <nav-item> is not read as <nav>.
  const token = new RegExp(`<(/?)(${tags.join('|')})(?![-\\w])([^>]*?)(/?)>`, 'gi');
  const open = [];
  const found = [];

  for (const m of html.matchAll(token)) {
    const tag = m[2].toLowerCase();
    if (m[1]) {
      const at = open.findLastIndex((el) => el.tag === tag);
      if (at === -1) continue; // a stray closer belongs to nothing
      const el = open[at];
      open.length = at; // anything still open inside it was never closed
      if (open.length === 0) {
        found.push({ ...el, innerEnd: m.index, end: m.index + m[0].length, inner: html.slice(el.innerStart, m.index) });
      }
    } else if (!m[4]) {
      open.push({ tag, attrs: m[3], start: m.index, innerStart: m.index + m[0].length });
    }
  }
  return found;
}

/** The inner HTML of the `tag` element carrying the most text, or null. */
function longestElement(html, tag) {
  let best = null;
  let bestLength = -1;
  for (const el of findElements(html, [tag])) {
    const length = stripHtml(el.inner).length;
    if (length > bestLength) [best, bestLength] = [el.inner, length];
  }
  return best;
}

/** Remove each outermost `tags` element, children included. */
function removeElements(html, tags) {
  let out = '';
  let cursor = 0;
  for (const el of findElements(html, tags)) {
    out += `${html.slice(cursor, el.start)} `;
    cursor = el.end;
  }
  return out + html.slice(cursor);
}

// Removed wherever they appear, inside a semantic container or not: none of
// them ever carries advert text, and a <select> of every office turns a
// location picker into a list of cities the job is not in.
const INERT_TAGS = ['script', 'style', 'noscript', 'template', 'svg', 'select', 'nav', 'aside'];

// Page furniture — but only when the page gave us no semantic container. Inside
// a <main> or an <article>, a <header> is the advert's own title block, holding
// exactly the title, location, contract type and salary the exclude rules key
// on; removing it there threw away the most rule-relevant text on the page.
//
// `form` is deliberately in neither list. Legacy ASP.NET wraps the whole <body>
// in <form runat="server">, and stripping forms emptied those pages outright —
// and "server-rendered, no ATS" is precisely the demographic this adapter is
// for.
const PAGE_CHROME_TAGS = ['head', 'header', 'footer'];

// Containers a class or id can mark as furniture, and where the densest-block
// fallback looks.
const ATTR_CHROME_TAGS = ['div', 'section', 'ul', 'ol'];
const BLOCK_TAGS = ['div', 'section'];

// Names that mark a container as furniture. Matched as a prefix of a word in
// the value, so `navigation`, `navbar`, `site-navigation`, `mainNav`,
// `menuWrapper` and `primary-navigation` are all caught — a `\b(nav|…)\b` list
// missed every one of them.
const CHROME_WORDS = [
  'nav', 'menu', 'sidebar', 'breadcrumb', 'cookie', 'consent', 'related',
  'similar', 'share', 'social', 'search', 'filter', 'pagination', 'skip', 'banner',
];

// Anchored to an attribute-name boundary. Unanchored, `(?:class|id)` matched
// inside `data-testid="job-banner"` and `data-uid="related-99"` — which does
// not mark furniture, it deletes the advert.
const CLASS_OR_ID = /(?:^|\s)(?:class|id)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]*))/gi;

// Whitespace, the separators class names actually use, and camelCase humps.
const WORD_BREAK = /[\s_\-.:]+|(?<=[a-z0-9])(?=[A-Z])/;

function isChromeAttrs(attrs) {
  for (const m of attrs.matchAll(CLASS_OR_ID)) {
    for (const word of (m[1] ?? m[2] ?? m[3] ?? '').split(WORD_BREAK)) {
      const w = word.toLowerCase();
      if (w && CHROME_WORDS.some((prefix) => w.startsWith(prefix))) return true;
    }
  }
  return false;
}

/** Drop furniture containers at any depth, each one whole. */
function removeChromeContainers(html) {
  let out = '';
  let cursor = 0;
  for (const el of findElements(html, ATTR_CHROME_TAGS)) {
    out += html.slice(cursor, el.start);
    // Not furniture itself, but something nested inside it may be.
    out += isChromeAttrs(el.attrs)
      ? ' '
      : html.slice(el.start, el.innerStart) + removeChromeContainers(el.inner) + html.slice(el.innerEnd, el.end);
    cursor = el.end;
  }
  return out + html.slice(cursor);
}

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
 * Order matters, and getting it wrong is what made the first rewrite ineffective:
 *
 *   1. choose the container, believing <main>/<article> when the page has one;
 *   2. only then strip chrome, and only inside that container;
 *   3. and only without a semantic container, fall back to the densest block.
 *
 * @param {string} html
 * @returns {string}
 */
export function extractDescription(html) {
  if (!html || typeof html !== 'string') return '';

  // Comments first: a commented-out tag would otherwise unbalance the scan.
  const doc = html.replace(/<!--[\s\S]*?-->/g, ' ');

  // The longest <article>, not the first: related-job cards are commonly
  // <article>, so document order returned a different job's advert — the exact
  // failure this function exists to prevent.
  const semantic = longestElement(doc, 'main') ?? longestElement(doc, 'article');
  const container = semantic ?? longestElement(doc, 'body') ?? doc;

  let stripped = removeElements(container, INERT_TAGS);
  if (semantic === null) stripped = removeElements(stripped, PAGE_CHROME_TAGS);
  stripped = removeChromeContainers(stripped);

  let text = stripHtml(stripped);

  if (semantic === null) {
    // Seeded with '', not with the whole page: seeded with the page, no block
    // could ever be longer and the fallback never moved off its seed at all.
    const densest = findElements(stripped, BLOCK_TAGS).reduce(
      (best, el) => (stripHtml(el.inner).length > stripHtml(best).length ? el.inner : best),
      '',
    );
    // A block is only "the" block if it carries more text than the whole rest
    // of the page put together. Comparing it against the entire stripped page
    // instead would make the fallback inert a second time — a block is always
    // a subset of the page, so it can never win that comparison.
    const blockText = stripHtml(densest);
    if (blockText.length > text.length - blockText.length) text = blockText;
  }

  return text
    .split('\n')
    // An empty list item renders as a bare bullet. Real adverts have text
    // after theirs; navigation, stripped of its links, does not.
    .filter((line) => line.replace(/^[•\s]+/, '').length > 0)
    .join('\n')
    .slice(0, DESCRIPTION_CAP);
}

// Parameters that identify the referrer, not the job. Left in, a link that
// picks up a `?utm_source=` on one page and not another mints two ids for one
// posting; taken out along with everything else, `/job.php?id=101` loses the
// only thing that identifies it.
const TRACKING_PARAM = /^(utm_[\w-]*|gclid|fbclid|ref|source)$/i;

/**
 * Static sites have no ids, so the url is the stable identity.
 *
 * Path *and* query. Dropping the query was the adapter's stated design, and the
 * design was wrong: on a board using `/job.php?id=101` every posting collapsed
 * to `site:/job.php`, pipeline.mjs kept the first and discarded the rest with no
 * warning, and the dedupe file then suppressed that one id on every later run.
 */
function nativeIdFor(url) {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_PARAM.test(key)) parsed.searchParams.delete(key);
    }
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    const query = parsed.searchParams.toString();
    return query ? `${path}?${query}` : path;
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
    const harvestOpts = { allowJunkText: Boolean(site.titleFromSlug), siteId: site.id, logger: ctx.logger };
    const pages = [];
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
      pages.push({ url: pageUrl, html: res.text });
    }

    const byUrl = new Map();
    const harvest = (pattern) => {
      for (const page of pages) {
        for (const [url, title] of harvestAnchors(page.html, pattern, page.url, harvestOpts)) {
          if (!byUrl.has(url)) byUrl.set(url, title);
        }
      }
    };

    // Strictly over every page first, and only then loosely. Deciding this per
    // page meant a page 2 with no vacancies on it triggered the loose pattern —
    // scooping that page's nav into the run — while the strict pattern was
    // working perfectly on page 1. The question the fallback answers is whether
    // the site matched, not whether a page did.
    harvest(compiled.href);
    if (byUrl.size === 0 && compiled.loose) harvest(compiled.loose);

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
      if (!title) {
        ctx.logger?.warn?.(`[${site.id}] dropped ${url}: ${JSON.stringify(rawTitle)} cleaned to an empty title`);
        continue;
      }
      postings.push(makePosting({ site, nativeId: nativeIdFor(url), title, url, description: '' }));
    }

    // Checked again, because the guard above runs before cleanTitle. A
    // titleStrip of /.*/ used to produce a site that returned zero postings,
    // threw nothing and logged nothing — defeating exactly the protection
    // zeroIsOk exists to make deliberate.
    if (postings.length === 0 && !site.zeroIsOk) {
      throw new Error(
        `static site '${site.id}' found ${byUrl.size} job link(s) but every title cleaned to empty — ` +
          `titleSplit or titleStrip is too aggressive, or set zeroIsOk if the board is legitimately empty`
      );
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
