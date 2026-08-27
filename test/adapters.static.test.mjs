import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import staticAdapter, { extractDescription } from '../src/adapters/static.mjs';
import { getAdapter } from '../src/adapters/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const listing = readFileSync(join(here, 'fixtures/static-listing.html'), 'utf8');
const jobPage = readFileSync(join(here, 'fixtures/static-job.html'), 'utf8');

const site = (over = {}) => ({
  id: 'acme',
  company: 'Acme Dynamics',
  type: 'static',
  url: 'https://careers.acmedynamics.test/',
  hrefPattern: '/\\/careers\\/[a-z0-9-]{3,}/i',
  ...over,
});

// A stub with the same surface as ctx.http: (url, opts) -> {ok, status, text}.
function stubHttp(handler) {
  const calls = [];
  const http = async (url, opts) => {
    calls.push({ url, opts });
    const res = typeof handler === 'function' ? handler(url, calls.length - 1) : handler;
    return { ok: true, status: 200, ...res };
  };
  http.calls = calls;
  return http;
}
const ctx = (http) => ({ http, logger: { log() {}, warn() {}, error() {} }, timeoutMs: 1000 });

test('registry resolves the static adapter', () => {
  assert.equal(getAdapter('static').id, 'static');
});

test('static declares that it does not yield descriptions inline', () => {
  assert.equal(staticAdapter.yieldsDescription, false);
  assert.equal(staticAdapter.tier, 'http');
});

test('harvests only anchors whose href matches the pattern', async () => {
  const out = await staticAdapter.fetch(site(), ctx(stubHttp({ text: listing })));
  const titles = out.map((p) => p.title).sort();
  // Home, About and Privacy do not match /careers/<slug>, so they are absent.
  // The composites link does match, but its only anchor text is "Read more" —
  // junk, and dropped unless titleFromSlug is on to rescue it.
  assert.deepEqual(titles, ['Graduate Design Engineer', 'Thermal Systems Engineer | Bicester | Full-time']);
});

test('resolves relative hrefs against the page url', async () => {
  const out = await staticAdapter.fetch(site(), ctx(stubHttp({ text: listing })));
  const grad = out.find((p) => p.title === 'Graduate Design Engineer');
  assert.equal(grad.url, 'https://careers.acmedynamics.test/careers/graduate-design-engineer');
});

test('the posting id is namespaced by site and derived from the url path', async () => {
  const out = await staticAdapter.fetch(site(), ctx(stubHttp({ text: listing })));
  const grad = out.find((p) => p.title === 'Graduate Design Engineer');
  assert.equal(grad.id, 'acme:/careers/graduate-design-engineer');
  assert.equal(grad.company, 'Acme Dynamics');
  assert.equal(grad.description, '');
  assert.equal(grad.postedAt, null);
});

test('a query-string job id is part of the posting id', async () => {
  // Dropping the query collapsed every job on a /job.php?id=N board to one id.
  // pipeline.mjs keys its within-run map by posting.id and keeps the first, so
  // the rest vanished with no warning — and the dedupe file then suppressed
  // that surviving id on every later run.
  const html = `
    <a href="/job.php?id=101">Aerodynamicist</a>
    <a href="/job.php?id=102">Composites Engineer</a>
    <a href="/job.php?id=103">Thermal Systems Engineer</a>`;
  const out = await staticAdapter.fetch(
    site({ hrefPattern: '/\\/job\\.php/i' }),
    ctx(stubHttp({ text: html })),
  );
  assert.equal(out.length, 3);
  assert.equal(new Set(out.map((p) => p.id)).size, 3);
  assert.deepEqual(out.map((p) => p.id).sort(), ['acme:/job.php?id=101', 'acme:/job.php?id=102', 'acme:/job.php?id=103']);
});

test('a tracking parameter does not mint a second id for one job', async () => {
  // The other half of putting the query in the id: a link that picks up a
  // ?utm_source= on one page and not another must still be one posting.
  const html = `
    <a href="/job.php?id=101">Aerodynamicist</a>
    <a href="/job.php?id=101&amp;utm_source=newsletter">Aerodynamicist, Bicester</a>
    <a href="/job.php?gclid=abc&amp;id=101">Aerodynamicist role</a>`;
  const out = await staticAdapter.fetch(
    site({ hrefPattern: '/\\/job\\.php/i' }),
    ctx(stubHttp({ text: html })),
  );
  assert.equal(new Set(out.map((p) => p.id)).size, 1);
  assert.equal(out[0].id, 'acme:/job.php?id=101');
});

test('a title that merely starts like a call to action is kept', async () => {
  // Unanchored, ^sign / ^share / ^see / ^view discarded these silently, at no
  // log level at all. "Signalling Engineer" is a mainstream UK title.
  const html = `
    <a href="/careers/signalling-engineer">Signalling Engineer</a>
    <a href="/careers/signal-processing-engineer">Signal Processing Engineer</a>
    <a href="/careers/shared-services-analyst">Shared Services Analyst</a>
    <a href="/careers/seed-programme-engineer">Seed Programme Engineer</a>
    <a href="/careers/viewpoint-analyst">Viewpoint Analyst</a>`;
  const out = await staticAdapter.fetch(site(), ctx(stubHttp({ text: html })));
  assert.deepEqual(out.map((p) => p.title).sort(), [
    'Seed Programme Engineer',
    'Shared Services Analyst',
    'Signal Processing Engineer',
    'Signalling Engineer',
    'Viewpoint Analyst',
  ]);
});

test('a real call to action is still junk', async () => {
  const html = `
    <a href="/careers/one">Apply now</a>
    <a href="/careers/two">Share</a>
    <a href="/careers/three">See all vacancies</a>
    <a href="/careers/four">View job</a>
    <a href="/careers/five">Sign in</a>`;
  const out = await staticAdapter.fetch(site({ zeroIsOk: true }), ctx(stubHttp({ text: html })));
  assert.deepEqual(out, []);
});

test('an anchor dropped as junk says so at debug', async () => {
  const debug = [];
  const logger = { log() {}, warn() {}, error() {}, debug: (m) => debug.push(m) };
  await staticAdapter.fetch(
    site({ hrefPattern: '/\\/careers\\/composites-technician/i', zeroIsOk: true }),
    { http: stubHttp({ text: listing }), logger, timeoutMs: 1000 },
  );
  assert.equal(debug.length, 1);
  assert.match(debug[0], /composites-technician/);
  assert.match(debug[0], /"Read more"/);
  assert.match(debug[0], /call to action/);
});

test('titles that all clean to empty are a site error, not a silent zero', async () => {
  // The zero-links guard runs before cleanTitle, and the posting loop dropped
  // an empty title with no log, so a titleStrip of /.*/ produced a site that
  // returned nothing and threw nothing — defeating what zeroIsOk exists for.
  const warnings = [];
  const logger = { log() {}, warn: (m) => warnings.push(m), error() {} };
  await assert.rejects(
    () => staticAdapter.fetch(site({ titleStrip: ['/.*/'] }), { http: stubHttp({ text: listing }), logger, timeoutMs: 1000 }),
    /every title cleaned to empty/,
  );
  assert.equal(warnings.length, 2, `expected one warning per dropped title, got ${JSON.stringify(warnings)}`);
  assert.match(warnings[0], /cleaned to an empty title/);
});

test('zeroIsOk still covers a board whose every title cleans to empty', async () => {
  const out = await staticAdapter.fetch(
    site({ titleStrip: ['/.*/'], zeroIsOk: true }),
    ctx(stubHttp({ text: listing })),
  );
  assert.deepEqual(out, []);
});

test('keeps the longest title when one link appears twice', async () => {
  // The fixture links the graduate role twice: once with its real title, once
  // as "Apply". Nav duplicates are always the short one.
  const out = await staticAdapter.fetch(site(), ctx(stubHttp({ text: listing })));
  assert.equal(out.filter((p) => p.url.endsWith('graduate-design-engineer')).length, 1);
  assert.equal(out.find((p) => p.url.endsWith('graduate-design-engineer')).title, 'Graduate Design Engineer');
});

test('junk anchor text is dropped unless the title comes from the slug', async () => {
  const strict = await staticAdapter.fetch(
    // zeroIsOk so the empty result is observable rather than a thrown site error.
    site({ hrefPattern: '/\\/careers\\/composites-technician/i', zeroIsOk: true }),
    ctx(stubHttp({ text: listing })),
  );
  // "Read more" is junk and there is no other anchor for that link, so with a
  // pattern matching only it, nothing survives.
  assert.deepEqual(strict, []);
});

test('titleFromSlug rescues links whose only anchor text is junk', async () => {
  const out = await staticAdapter.fetch(
    site({ hrefPattern: '/\\/careers\\/composites-technician/i', titleFromSlug: true }),
    ctx(stubHttp({ text: listing })),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Composites Technician');
});

test('slugStrip removes boilerplate before the slug becomes a title', async () => {
  const html = '<a href="/careers/electrical-design-engineer-jid-4471">Find out more</a>';
  const out = await staticAdapter.fetch(
    site({ titleFromSlug: true, slugStrip: ['/-jid-\\d+$/i'] }),
    ctx(stubHttp({ text: html })),
  );
  assert.equal(out[0].title, 'Electrical Design Engineer');
});

test('titleSplit keeps only the text before the separator', async () => {
  const out = await staticAdapter.fetch(site({ titleSplit: '|' }), ctx(stubHttp({ text: listing })));
  const titles = out.map((p) => p.title);
  assert.ok(titles.includes('Thermal Systems Engineer'), `got ${JSON.stringify(titles)}`);
});

test('a multi-line anchor becomes a single-line title', async () => {
  // stripHtml turns the block closers into newlines, and \s{2,} does not catch
  // a single one. markdown.mjs interpolates the title into a `###` heading, so
  // a newline in it breaks the digest's structure.
  const html = '<a href="/careers/aerodynamics-engineer"><h3>Aerodynamics Engineer</h3><p>Bicester</p></a>';
  const out = await staticAdapter.fetch(site(), ctx(stubHttp({ text: html })));
  assert.equal(out[0].title, 'Aerodynamics Engineer Bicester');
  assert.doesNotMatch(out[0].title, /\n/);
});

test('a plain-string pattern is a literal, exactly as a rule matcher is', async () => {
  // The README says site regex fields take the same form as a rule's `match`,
  // where a plain string is escaped as a literal. Compiled as a pattern, the
  // parentheses in "job (UK)" became a group and matched the href "/job UK/1".
  const html = '<a href="/job UK/1">Aerodynamicist</a><a href="/job (UK)/2">Composites Engineer</a>';
  const out = await staticAdapter.fetch(
    site({ hrefPattern: 'job (UK)' }),
    ctx(stubHttp({ text: html })),
  );
  assert.deepEqual(out.map((p) => p.title), ['Composites Engineer']);
});

test('a /body/flags pattern is still a real regex', async () => {
  const html = '<a href="/careers/aero-engineer">Aero Engineer</a><a href="/other/x">Other</a>';
  const out = await staticAdapter.fetch(
    site({ hrefPattern: '/\\/careers\\/[a-z-]+/i' }),
    ctx(stubHttp({ text: html })),
  );
  assert.deepEqual(out.map((p) => p.title), ['Aero Engineer']);
});

test('titleStrip removes matching boilerplate from titles', async () => {
  const html = '<a href="/careers/design-engineer">Design Engineer (Apply now)</a>';
  const out = await staticAdapter.fetch(
    site({ titleStrip: ['/\\(apply now\\)/i'] }),
    ctx(stubHttp({ text: html })),
  );
  assert.equal(out[0].title, 'Design Engineer');
});

test('extra pages are fetched and their postings merged', async () => {
  const page2 = '<a href="/careers/aero-engineer">Aero Engineer</a>';
  const http = stubHttp((url) => ({ text: url.includes('page=2') ? page2 : listing }));
  const out = await staticAdapter.fetch(
    site({ pages: ['https://careers.acmedynamics.test/?page=2'] }),
    ctx(http),
  );
  assert.equal(http.calls.length, 2);
  assert.ok(out.some((p) => p.title === 'Aero Engineer'));
});

test('the loose pattern is used only when the strict one finds nothing', async () => {
  const out = await staticAdapter.fetch(
    site({ hrefPattern: '/\\/vacancies\\/[a-z-]+/i', looseHrefPattern: '/\\/careers\\//i' }),
    ctx(stubHttp({ text: listing })),
  );
  assert.ok(out.length > 0, 'the loose pattern should have rescued the run');
});

test('the loose pattern is a question about the site, not about a page', async () => {
  // A page 2 with no vacancies on it used to trigger the fallback on its own
  // and scoop that page's nav into the run, while the strict pattern was
  // working perfectly on page 1.
  const page2 = '<nav><a href="/careers-advice">Careers advice</a><a href="/careers-fair">Careers fair</a></nav>';
  const http = stubHttp((url) => ({ text: url.includes('page=2') ? page2 : listing }));
  const out = await staticAdapter.fetch(
    site({ pages: ['https://careers.acmedynamics.test/?page=2'], looseHrefPattern: '/careers/i' }),
    ctx(http),
  );
  assert.equal(out.length, 2, `got ${JSON.stringify(out.map((p) => p.title))}`);
  assert.ok(!out.some((p) => p.url.includes('careers-advice')));
});

test('the loose pattern is not consulted when the strict one matched', async () => {
  const out = await staticAdapter.fetch(
    site({ looseHrefPattern: '/./' }),
    ctx(stubHttp({ text: listing })),
  );
  // A loose pattern of /./ would match every anchor including nav and footer.
  assert.equal(out.length, 2);
});

test('zero matching anchors is a site error by default', async () => {
  await assert.rejects(
    () => staticAdapter.fetch(site(), ctx(stubHttp({ text: '<p>no jobs here</p>' }))),
    /found no job links/,
  );
});

test('zeroIsOk turns a legitimately empty board into an empty result', async () => {
  const out = await staticAdapter.fetch(
    site({ zeroIsOk: true }),
    ctx(stubHttp({ text: '<p>no vacancies at present</p>' })),
  );
  assert.deepEqual(out, []);
});

test('a non-200 on the first page is a site error', async () => {
  await assert.rejects(
    () => staticAdapter.fetch(site(), ctx(stubHttp({ ok: false, status: 503, text: '' }))),
    /returned HTTP 503/,
  );
});

test('a non-200 on a later page keeps what the earlier pages produced', async () => {
  const http = stubHttp((url) =>
    url.includes('page=2') ? { ok: false, status: 500, text: '' } : { text: listing });
  const out = await staticAdapter.fetch(
    site({ pages: ['https://careers.acmedynamics.test/?page=2'] }),
    ctx(http),
  );
  assert.equal(out.length, 2);
});

test('a site without hrefPattern is rejected', async () => {
  await assert.rejects(
    () => staticAdapter.fetch({ id: 'a', company: 'A', type: 'static', url: 'https://x.test/' }, ctx(stubHttp({ text: '' }))),
    /needs 'hrefPattern'/,
  );
});

test('a site without url is rejected', async () => {
  await assert.rejects(
    () => staticAdapter.fetch({ id: 'a', company: 'A', type: 'static', hrefPattern: '/x/' }, ctx(stubHttp({ text: '' }))),
    /needs 'url'/,
  );
});

test('an unparseable regex in the config is rejected by name', async () => {
  await assert.rejects(
    () => staticAdapter.fetch(site({ hrefPattern: '/[unclosed/' }), ctx(stubHttp({ text: listing }))),
    /hrefPattern/,
  );
});

test('fetchDescription returns the job page body as text, without the chrome', async () => {
  const posting = { id: 'acme:/careers/graduate-design-engineer', url: 'https://careers.acmedynamics.test/careers/graduate-design-engineer' };
  const text = await staticAdapter.fetchDescription(posting, site(), ctx(stubHttp({ text: jobPage })));

  assert.match(text, /Join our chassis team in Bicester\./);
  assert.match(text, /• CAD and GD&T/);
  assert.match(text, /cannot offer visa sponsorship/);

  // Chrome and inert content must not reach the model or the rules.
  assert.doesNotMatch(text, /window\.analytics/);
  assert.doesNotMatch(text, /color: red/);
  assert.doesNotMatch(text, /Home About Careers Contact/);
  assert.doesNotMatch(text, /registered in England/);
});

test('fetchDescription requests the posting url', async () => {
  const http = stubHttp({ text: jobPage });
  await staticAdapter.fetchDescription({ url: 'https://careers.acmedynamics.test/careers/x' }, site(), ctx(http));
  assert.equal(http.calls[0].url, 'https://careers.acmedynamics.test/careers/x');
});

test('fetchDescription returns an empty string rather than throwing on failure', async () => {
  const failing = ctx(stubHttp({ ok: false, status: 404, text: '' }));
  assert.equal(await staticAdapter.fetchDescription({ url: 'https://x.test/j' }, site(), failing), '');

  const throwing = { http: async () => { throw new Error('socket hang up'); }, logger: { warn() {} } };
  assert.equal(await staticAdapter.fetchDescription({ url: 'https://x.test/j' }, site(), throwing), '');
});

test('extraction prefers a semantic main container over the whole page', () => {
  const html = `
    <body>
      <div class="sidebar"><ul><li>Aerodynamics</li><li>Design</li><li>Engineering</li></ul></div>
      <main><p>We need a health and safety adviser for the factory.</p></main>
    </body>`;
  const text = extractDescription(html);
  assert.match(text, /health and safety adviser/i);
  // The category list is page furniture. Left in, it makes a scoring model
  // confident about the wrong things — worse than giving it nothing.
  assert.doesNotMatch(text, /Aerodynamics/);
});

test('extraction drops containers whose class marks them as furniture', () => {
  // The furniture is deliberately LONGER than the advert, and there is no
  // <main>. Without the class blocklist the densest-block fallback would pick
  // the related-jobs list and this test would pass on the wrong mechanism —
  // which is exactly what a shorter furniture block let it do before.
  const furniture = 'Composites Engineer. Aerodynamicist. Design Engineer. '.repeat(20);
  const html = `
    <body>
      <div id="related-jobs"><p>${furniture}</p></div>
      <div class="cookie-consent"><p>We use cookies</p></div>
      <div><p>The advert itself.</p></div>
    </body>`;
  const text = extractDescription(html);
  assert.equal(text, 'The advert itself.');
});

test('extraction drops the empty bullets a stripped nav leaves behind', () => {
  const html = '<main><ul><li></li><li>   </li><li>Real requirement</li></ul></main>';
  const text = extractDescription(html);
  assert.equal(text, '• Real requirement');
});

test('extraction falls back to the densest block when there is no main', () => {
  const html = `
    <body>
      <div><p>Short.</p></div>
      <div><p>${'A much longer advert body. '.repeat(20)}</p></div>
    </body>`;
  const text = extractDescription(html);
  assert.match(text, /A much longer advert body/);
  // Asserting only that the advert is present proves nothing: returning the
  // whole page satisfies it, which is exactly what the reduce did when it was
  // seeded with the document and no candidate could ever be longer.
  assert.doesNotMatch(text, /Short\./);
});

test('extraction keeps a nothing-but-text page when no block dominates it', () => {
  // The densest block must out-weigh the rest of the page, or the page stands.
  const html = '<body><p>The advert body, which is not inside any block at all.</p><div>tiny</div></body>';
  assert.match(extractDescription(html), /not inside any block at all/);
});

test('extraction keeps the header nested inside an article', () => {
  // Stripping chrome before choosing the container destroyed the advert's own
  // header — the title, location, contract type and salary, which is precisely
  // what the exclude rules key on.
  const html = `
    <main><article>
      <header><h1>Aerodynamicist</h1><p>Bicester | Full-time | 45k</p></header>
      <p>You will own the CFD process.</p>
    </article></main>`;
  const text = extractDescription(html);
  assert.match(text, /Aerodynamicist/);
  assert.match(text, /Bicester \| Full-time \| 45k/);
  assert.match(text, /You will own the CFD process/);
});

test('extraction survives a page wrapped in a form', () => {
  // Legacy ASP.NET wraps the whole body in <form runat="server">. `form` was in
  // the strip list, which emptied every such page — and "server-rendered, with
  // no ATS" is the demographic this adapter exists for.
  const html = `
    <body><form runat="server" method="post">
      <main><p>We are hiring a chassis design engineer in Bicester.</p></main>
      <input type="submit" value="Apply">
    </form></body>`;
  assert.match(extractDescription(html), /chassis design engineer in Bicester/);
});

test('extraction takes the longest article, not the first', () => {
  // Related-job cards are commonly <article>, so "first in document order"
  // returned a different job's text.
  const html = `
    <article class="job-card"><h3>Composites Engineer</h3></article>
    <article><p>${'The actual advert body. '.repeat(10)}</p></article>`;
  const text = extractDescription(html);
  assert.match(text, /The actual advert body/);
  assert.doesNotMatch(text, /Composites Engineer/);
});

test('extraction prefers main even when an article comes first', () => {
  const html = '<article class="job-card"><h3>Composites Engineer</h3></article><main><p>The actual advert.</p></main>';
  assert.equal(extractDescription(html), 'The actual advert.');
});

test('a furniture container is removed whole, however deeply it nests', () => {
  // A non-greedy `[\s\S]*?<\/\1>` with a backreference stops at the first inner
  // </div>, so the rest of the sidebar survived.
  const html = `
    <body>
      <div class="sidebar">
        <div><p>Nested furniture</p></div>
        <p>Furniture that outlived the closing tag</p>
      </div>
      <div><p>${'The advert body. '.repeat(10)}</p></div>
    </body>`;
  const text = extractDescription(html);
  assert.match(text, /The advert body/);
  assert.doesNotMatch(text, /Nested furniture/);
  assert.doesNotMatch(text, /outlived the closing tag/);
});

test('a nested furniture container is removed even inside a kept one', () => {
  const html = `
    <body><div class="content">
      <div class="related-jobs"><p>Composites Engineer</p></div>
      <p>${'The advert body. '.repeat(10)}</p>
    </div></body>`;
  const text = extractDescription(html);
  assert.match(text, /The advert body/);
  assert.doesNotMatch(text, /Composites Engineer/);
});

test('the furniture blocklist catches the names real pages actually use', () => {
  for (const name of ['navigation', 'navbar', 'site-navigation', 'mainNav', 'menuWrapper', 'primary-navigation']) {
    const html = `
      <body>
        <div class="${name}"><p>Home About Careers Contact Us Today</p></div>
        <div><p>${'The advert body. '.repeat(10)}</p></div>
      </body>`;
    const text = extractDescription(html);
    assert.doesNotMatch(text, /Home About Careers/, `class="${name}" should be furniture`);
    assert.match(text, /The advert body/, `class="${name}" should not eat the advert`);
  }
});

test('the furniture blocklist reads class and id, not every attribute ending in id', () => {
  // Unanchored, `(?:class|id)` matched inside data-testid and data-uid, and the
  // container it deleted was the advert.
  assert.equal(
    extractDescription('<body><div data-testid="job-banner"><p>The advert body.</p></div></body>'),
    'The advert body.',
  );
  assert.equal(
    extractDescription('<body><div data-uid="related-99"><p>The advert body.</p></div></body>'),
    'The advert body.',
  );
});

test('extraction returns an empty string for junk input', () => {
  assert.equal(extractDescription(''), '');
  assert.equal(extractDescription(null), '');
  assert.equal(extractDescription(42), '');
});

test('fetchDescription caps a runaway page', async () => {
  const huge = `<main>${'word '.repeat(20000)}</main>`;
  const text = await staticAdapter.fetchDescription({ url: 'https://x.test/j' }, site(), ctx(stubHttp({ text: huge })));
  assert.ok(text.length <= 8001, `expected a capped description, got ${text.length} chars`);
});
