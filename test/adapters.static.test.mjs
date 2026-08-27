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
  const html = `
    <body>
      <div id="related-jobs"><p>Composites Engineer</p></div>
      <div class="cookie-consent"><p>We use cookies</p></div>
      <div><p>The advert itself, which is much longer than the other blocks on this page.</p></div>
    </body>`;
  const text = extractDescription(html);
  assert.match(text, /The advert itself/);
  assert.doesNotMatch(text, /Composites Engineer/);
  assert.doesNotMatch(text, /cookies/i);
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
  assert.match(extractDescription(html), /A much longer advert body/);
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
