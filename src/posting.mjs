/**
 * Decode one numeric character reference, or leave it as written.
 *
 * `String.fromCodePoint` throws RangeError above U+10FFFF, and a career page is
 * free to emit `&#99999999;`. This helper is shared by every adapter — in
 * `static` it runs inside `fetch()` with no try/catch, so one malformed
 * reference in one anchor would fail the whole site; in `greenhouse` it runs
 * inside the row mapper, where the posting is dropped with a "malformed row"
 * warning. Neither is an acceptable price for a typo in someone's CMS, so an
 * out-of-range reference stays literal text.
 */
function decodeCodePoint(raw, code) {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return raw;
  return String.fromCodePoint(code);
}

/**
 * Convert description HTML into readable plain text.
 * Block-level closers and <br> become newlines, <li> becomes a bullet, so the
 * result keeps the shape a human (and a scoring model) needs to read it.
 */
export function stripHtml(html) {
  if (!html || typeof html !== 'string') return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|ul|ol|li|h[1-6]|section|tr)>/gi, '\n')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    // Numeric character references, decimal and hex. Real career pages emit
    // these freely — a live run against a real board turned up a literal
    // "&#xA0;" surviving into a description and on to the scoring model.
    .replace(/&#(\d+);/g, (raw, n) => decodeCodePoint(raw, Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (raw, h) => decodeCodePoint(raw, parseInt(h, 16)))
    // &nbsp; is normalised to a plain space above, so its numeric spellings
    // must be too — otherwise the same character behaves differently depending
    // on how the page happened to encode it, and a keyword match silently
    // depends on that. Written as an escape on purpose: as a literal U+00A0 in
    // the source this line is invisible, and any formatter or normalising
    // copy-paste turns it into a silent no-op.
    .replace(/\u00A0/g, ' ')
    // Decoding is what makes these reachable: `&#0;` is a legal reference to a
    // character no page means to display, and neither a C0 control nor a lone
    // surrogate is touched by the whitespace rules below, so both would travel
    // into the digest and the scoring prompt as invisible junk. Tab, newline
    // and carriage return are deliberately not in the class.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/[\uD800-\uDFFF]/gu, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * Build a normalised Posting. Every adapter goes through here so the shape is
 * defined once. Ids are namespaced by site so two boards cannot collide on a
 * bare numeric id.
 */
export function makePosting({ site, nativeId, title, url, location, postedAt, description }) {
  if (nativeId === undefined || nativeId === null || `${nativeId}` === '') {
    throw new Error(`posting from site '${site?.id}' is missing nativeId`);
  }
  const cleanTitle = (title ?? '').trim();
  if (!cleanTitle) throw new Error(`posting ${site?.id}:${nativeId} is missing a title`);
  if (!url) throw new Error(`posting ${site?.id}:${nativeId} is missing a url`);

  return {
    id: `${site.id}:${nativeId}`,
    title: cleanTitle,
    company: site.company,
    location: (location ?? '').trim(),
    url,
    postedAt: postedAt ?? null,
    description: description ?? '',
    source: site.id,
    notes: [],
  };
}
