// An unscored posting sorts below every scored one: -1 is lower than the
// schema's minimum of 1, so nulls fall to the bottom without a special case.
function byScoreThenCompany(a, b) {
  const left = a.score ?? -1;
  const right = b.score ?? -1;
  if (right !== left) return right - left;
  return a.company.localeCompare(b.company);
}

function renderPosting(p) {
  const lines = [
    `### [${p.score === null ? '—' : `${p.score}/10`}] ${p.title} · ${p.company}`,
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
  const kept = scored.filter((p) => p.verdict !== 'omit').sort(byScoreThenCompany);

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
