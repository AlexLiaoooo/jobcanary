import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripHtml, makePosting } from '../src/posting.mjs';

test('stripHtml removes tags and collapses whitespace', () => {
  assert.equal(stripHtml('<p>Hello   <b>world</b></p>'), 'Hello world');
});

test('stripHtml turns list items into bullet lines', () => {
  assert.equal(stripHtml('<ul><li>One</li><li>Two</li></ul>'), '• One\n• Two');
});

test('stripHtml decodes the common entities', () => {
  assert.equal(stripHtml('R&amp;D &quot;fast&quot; &#39;work&#39; &lt;x&gt;&nbsp;y'), 'R&D "fast" \'work\' <x> y');
});

test('stripHtml drops script and style content', () => {
  assert.equal(stripHtml('<style>a{}</style>Keep<script>bad()</script>'), 'Keep');
});

test('stripHtml returns an empty string for null or non-string input', () => {
  assert.equal(stripHtml(null), '');
  assert.equal(stripHtml(undefined), '');
  assert.equal(stripHtml(42), '');
});

test('makePosting namespaces the id by site', () => {
  const p = makePosting({
    site: { id: 'acme', company: 'Acme Dynamics' },
    nativeId: '123', title: 'Engineer', url: 'https://example.test/123',
  });
  assert.equal(p.id, 'acme:123');
  assert.equal(p.source, 'acme');
  assert.equal(p.company, 'Acme Dynamics');
});

test('makePosting defaults optional fields', () => {
  const p = makePosting({
    site: { id: 'acme', company: 'Acme Dynamics' },
    nativeId: '1', title: 'Engineer', url: 'https://example.test/1',
  });
  assert.equal(p.location, '');
  assert.equal(p.description, '');
  assert.equal(p.postedAt, null);
  assert.deepEqual(p.notes, []);
});

test('makePosting trims the title', () => {
  const p = makePosting({
    site: { id: 'a', company: 'A' }, nativeId: '1',
    title: '  Graduate Engineer \n', url: 'https://example.test/1',
  });
  assert.equal(p.title, 'Graduate Engineer');
});

test('makePosting throws when a required field is missing', () => {
  assert.throws(() => makePosting({ site: { id: 'a', company: 'A' }, nativeId: '1', title: '' }), /title/);
  assert.throws(() => makePosting({ site: { id: 'a', company: 'A' }, title: 'X', url: 'u' }), /nativeId/);
});

test('stripHtml decodes numeric character references, decimal and hex', () => {
  // Real career pages emit these freely; a live run found a literal "&#xA0;"
  // reaching the scoring model as text.
  assert.equal(stripHtml('<p>Duties:&#xA0;Undertake&#8230;</p>'), 'Duties: Undertake…');
  assert.equal(stripHtml('<p>R&#38;D at 30&#176;C</p>'), 'R&D at 30°C');
});

test('a non-breaking space normalises the same however the page spelled it', () => {
  // &#160; is the decimal spelling of the same character as &#xA0; and &nbsp;.
  // Only the hex form was covered, and the rule that folds it to a plain space
  // used to be written with an invisible literal U+00A0 inside the regex.
  assert.equal(stripHtml('<p>Duties:&#160;Undertake</p>'), 'Duties: Undertake');
  assert.equal(stripHtml('<p>Duties:&#xA0;Undertake</p>'), 'Duties: Undertake');
  assert.equal(stripHtml('<p>Duties:&nbsp;Undertake</p>'), 'Duties: Undertake');
});

test('an out-of-range numeric reference is left as text rather than thrown', () => {
  // String.fromCodePoint throws RangeError above U+10FFFF. stripHtml is shared:
  // in the static adapter it runs inside fetch() with no try/catch, so this
  // used to fail an entire site over one malformed reference in one anchor.
  assert.doesNotThrow(() => stripHtml('<p>a&#99999999;b</p>'));
  assert.doesNotThrow(() => stripHtml('<p>a&#xFFFFFFF;b</p>'));
  assert.equal(stripHtml('<p>a&#99999999;b</p>'), 'a&#99999999;b');
  assert.equal(stripHtml('<p>a&#xFFFFFFF;b</p>'), 'a&#xFFFFFFF;b');
  // The boundary itself still decodes.
  assert.equal(stripHtml('<p>a&#x10FFFF;b</p>'), 'a\u{10FFFF}b');
});

test('stripHtml drops control characters and lone surrogates it decoded', () => {
  // Decoding is what makes these reachable, and neither is caught by the
  // whitespace normalisation, so both used to travel into the digest.
  assert.equal(stripHtml('<p>a&#0;b</p>'), 'ab');
  assert.equal(stripHtml('<p>a&#x1;b&#x1F;c</p>'), 'abc');
  assert.equal(stripHtml('<p>a&#xD800;b</p>'), 'ab');
  // A real astral character is a surrogate pair, not a lone surrogate: it stays.
  assert.equal(stripHtml('<p>a&#x1F680;b</p>'), 'a\u{1F680}b');
});
