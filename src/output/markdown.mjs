/**
 * One definition of "this posting has no score", used by both the comparator
 * and the heading. They used to disagree — `?? -1` tolerated `undefined` while
 * the heading tested `=== null` — so an undefined score sorted last and then
 * rendered as `[undefined/10]`.
 */
const isUnscored = (p) => p.score === null || p.score === undefined;

/**
 * Rank: score descending, then newest first, then company.
 *
 * An unscored posting sorts below every scored one (-1 is lower than the
 * schema's minimum of 1, so no special case is needed). Ties break on
 * postedAt descending rather than alphabetically, because a tie in score is
 * common and alphabetical order carries no information at all — of two
 * equally-good postings the fresher one is the one worth acting on first, and
 * it is likelier still to be open. Company remains the last resort, for
 * postings whose board did not state a date.
 */
function byScoreThenRecency(a, b) {
  const left = isUnscored(a) ? -1 : a.score;
  const right = isUnscored(b) ? -1 : b.score;
  if (right !== left) return right - left;

  // ISO dates, so a string comparison is a date comparison. A posting with no
  // date sorts after every posting that has one: it cannot be shown to be
  // fresh, and guessing in its favour would push undated boards to the top.
  if (a.postedAt && b.postedAt && a.postedAt !== b.postedAt) {
    return a.postedAt < b.postedAt ? 1 : -1;
  }
  if (a.postedAt && !b.postedAt) return -1;
  if (!a.postedAt && b.postedAt) return 1;

  return a.company.localeCompare(b.company);
}

function renderPosting(p) {
  const lines = [
    `### [${isUnscored(p) ? '—' : `${p.score}/10`}] ${p.title} · ${p.company}`,
    `- **Location:** ${p.location || 'Not stated'}${p.postedAt ? ` · **Posted:** ${p.postedAt}` : ''}`,
    `- **Fit:** ${p.rationale}`,
  ];
  if (p.notes?.length) lines.push(`- **Notes:** ${p.notes.join(' · ')}`);
  lines.push(`- **Link:** ${p.url}`);
  return lines.join('\n');
}

/**
 * Render the ranked digest.
 * @param {object[]} scored
 * @param {{date: string, scanned: number, siteErrors: {site: string, error: string}[]}} meta
 * @returns {string}
 */
export function renderDigest(scored, meta) {
  const kept = scored.filter((p) => p.verdict !== 'omit').sort(byScoreThenRecency);

  const out = [
    `# Job Picks — ${meta.date}`,
    `**Scanned:** ${meta.scanned} · **New:** ${kept.length}`,
    '',
  ];

  if (kept.length === 0) {
    out.push(`No new postings today. Scanned ${meta.scanned}.`);
  } else {
    out.push(kept.map(renderPosting).join('\n\n'));
  }

  if (meta.siteErrors?.length) {
    out.push('', '## Site errors', '');
    out.push(meta.siteErrors.map((e) => `- ${e.site} — ${e.error}`).join('\n'));
  }

  return `${out.join('\n')}\n`;
}
