/**
 * Shared plumbing for HTTP adapters: one JSON fetch with uniform error
 * messages, and one tolerant row mapper.
 *
 * Every adapter repeats the same three failure checks (non-2xx, unparseable
 * body, wrong shape) and the same row-mapping loop. Writing them once keeps
 * the error wording identical across adapters — the wording is a contract the
 * adapter tests assert on — and means the next ten adapters inherit the
 * behaviour instead of re-deriving it.
 */

/**
 * Fetch a URL through `ctx.http` and parse it as JSON.
 *
 * `label` names the thing being fetched in adapter terms, e.g.
 * `greenhouse board 'acmedynamics'`; every message is built from it, so a
 * failure says which site broke without the caller reformatting it.
 *
 * `expect` asks for a shape check, so a 200 with the wrong body becomes a site
 * error rather than a silent zero postings:
 *   - `{ array: true }`      — the body itself must be a JSON array; returns it.
 *   - `{ arrayAt: 'jobs' }`  — the body must be an object whose `jobs` property
 *                              is an array; returns that array.
 *   - `{}` (default)         — no check; returns whatever parsed.
 *
 * @param {{http: Function}} ctx
 * @param {string} url
 * @param {object} [opts]   passed straight to ctx.http
 * @param {string} label
 * @param {{array?: boolean, arrayAt?: string}} [expect]
 */
export async function fetchJson(ctx, url, opts = {}, label = 'request', expect = {}) {
  const res = await ctx.http(url, opts);
  if (!res.ok) {
    throw new Error(`${label} returned HTTP ${res.status}`);
  }

  let data;
  try {
    data = JSON.parse(res.text);
  } catch {
    throw new Error(`${label} returned a body that is not valid JSON`);
  }

  if (expect.array) {
    if (!Array.isArray(data)) {
      throw new Error(`${label}: expected a JSON array of postings`);
    }
    return data;
  }

  if (expect.arrayAt) {
    const rows = data && typeof data === 'object' ? data[expect.arrayAt] : undefined;
    if (!Array.isArray(rows)) {
      throw new Error(`${label}: expected a JSON object with a '${expect.arrayAt}' array`);
    }
    return rows;
  }

  return data;
}

/**
 * Map rows to postings, tolerating a row that cannot be mapped.
 *
 * A single malformed row — a job with no url, say — must not cost the other
 * 199 on the board. The bad row is warned about, naming the site, and skipped;
 * everything else survives. This is the row-level counterpart of the existing
 * site-level tolerance: one broken site never ends the run either.
 *
 * @param {any[]} rows
 * @param {{logger?: object}} ctx
 * @param {{id?: string}} site
 * @param {(row: any) => object} mapRow
 * @returns {object[]}
 */
export function mapRows(rows, ctx, site, mapRow) {
  const out = [];
  rows.forEach((row, index) => {
    try {
      out.push(mapRow(row));
    } catch (err) {
      ctx?.logger?.warn?.(`[${site?.id}] skipped a malformed row at index ${index}: ${err.message}`);
    }
  });
  return out;
}
