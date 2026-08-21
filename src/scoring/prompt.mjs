/**
 * Everything both LLM providers say to the model, in one place.
 *
 * Nothing here touches the network or the clock. `buildPrefix` in particular
 * must stay a pure function of its arguments: its output is the cached prompt
 * prefix, and a single varying byte silently disables prompt caching.
 */

export const DEFAULT_RUBRIC = `
You are scoring a job posting for one candidate, whose profile follows.

Give the posting a fit score from 1 to 10:

- 9-10  Direct hit: the role, the field and the required skills all match the
        profile closely.
- 7-8   Strong fit: clearly the right field and level, most skills match.
- 5-6   Plausible: adjacent field or partially matching skills.
- 3-4   Weak: the discipline or the level is wrong, but not absurd.
- 1-2   Poor: little relation to the profile.

Then give a one-sentence rationale that refers to something specific in the
profile. Say what actually drove the score, including when the reason is a
mismatch.

Judge only what the posting and the profile support. Do not invent
requirements the posting does not state. If the posting text is thin, say so
in the rationale and score conservatively.

Some postings arrive with flags raised by earlier keyword filters. A flag is a
prompt to look, not a verdict — weigh it against the rest of the posting and
explain your reading of it.

Score every posting you are given. It is not your decision whether a posting
reaches the reader.
`.trim();

/**
 * Build the cached prompt prefix: rubric first, then the candidate profile.
 * Pure — output depends only on the arguments.
 */
export function buildPrefix({ rubric, profile }) {
  return `${rubric.trim()}\n\n## Candidate profile\n\n${profile.trim()}`;
}

/**
 * Render one posting as the user-turn content.
 * Notes from `annotate` rules are included deliberately: the keyword layer
 * raises a concern it cannot adjudicate, and the model weighs it in context.
 */
export function buildPostingBlock(posting) {
  const lines = [`Title: ${posting.title}`, `Company: ${posting.company}`];
  if (posting.location) lines.push(`Location: ${posting.location}`);
  if (posting.notes?.length) {
    lines.push(`Flags raised by earlier filters: ${posting.notes.join(' · ')}`);
  }
  lines.push('', 'Description:', posting.description || '(no description captured)');
  return lines.join('\n');
}

/**
 * The structured-output schema. Deliberately has no `verdict` field: the
 * model scores and explains, it does not decide what the reader sees.
 */
export const SCORE_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer', minimum: 1, maximum: 10 },
    rationale: { type: 'string' },
  },
  required: ['score', 'rationale'],
  additionalProperties: false,
};

/**
 * A posting that could not be scored. Still reported, ranked last, with the
 * reason visible — never silently dropped.
 */
export function unscored(posting, reason) {
  return { ...posting, score: null, rationale: `not scored: ${reason}`, verdict: 'keep' };
}
