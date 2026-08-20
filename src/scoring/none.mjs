const searchText = (p) =>
  [p.title, p.company, p.location, p.description].filter(Boolean).join('\n').toLowerCase();

/**
 * Deterministic keyword ranking. No network, no key, no cost.
 *
 * This is the default provider so the tool is useful and fully testable before
 * anyone configures an LLM. It never omits a posting — omission is a judgement
 * call, and keyword counting is not judgement.
 */
export default {
  id: 'none',

  async score(postings, opts = {}) {
    const keywords = (opts.keywords ?? []).map((k) => k.toLowerCase()).filter(Boolean);

    return postings.map((posting) => {
      const haystack = searchText(posting);
      const matched = [...new Set(keywords)].filter((k) => haystack.includes(k));
      return {
        ...posting,
        score: Math.min(10, 1 + 2 * matched.length),
        rationale: matched.length
          ? `Matched configured keywords: ${matched.join(', ')}.`
          : 'No configured keywords matched.',
        verdict: 'keep',
      };
    });
  },
};
