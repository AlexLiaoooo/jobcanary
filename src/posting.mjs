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
