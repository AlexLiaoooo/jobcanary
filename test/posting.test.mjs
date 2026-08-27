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
