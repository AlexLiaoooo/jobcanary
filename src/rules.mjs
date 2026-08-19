/**
 * Resolve the text a rule should search. 'all' concatenates every text field,
 * which is why it is the default: a rule author who does not say where to look
 * means "anywhere".
 */
function fieldText(posting, field) {
  if (field === 'all') {
    return [posting.title, posting.company, posting.location, posting.description]
      .filter(Boolean).join('\n');
  }
  return posting[field] ?? '';
}

function matches(posting, rule) {
  const text = fieldText(posting, rule.field);
  if (!text) return false;
  return rule.match.some((re) => re.test(text));
}

/**
 * Apply exclude and annotate rules to one posting.
 *
 * Exclude rules short-circuit: the first match drops the posting and no
 * annotations are computed. Annotate rules never drop anything — they attach a
 * note so a later scoring stage can judge with full context instead of a
 * keyword guess.
 *
 * @param {object} posting
 * @param {{exclude: object[], annotate: object[]}} rules
 * @returns {{keep: boolean, excludedBy: string|null, notes: string[]}}
 */
export function applyRules(posting, rules) {
  for (const rule of rules.exclude ?? []) {
    if (matches(posting, rule)) {
      return { keep: false, excludedBy: rule.id, notes: [] };
    }
  }
  const notes = [];
  for (const rule of rules.annotate ?? []) {
    if (matches(posting, rule)) notes.push(rule.note);
  }
  return { keep: true, excludedBy: null, notes };
}
