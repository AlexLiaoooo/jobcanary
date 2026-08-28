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
 * Apply include, exclude and annotate rules to one posting, in that order.
 *
 * `include` is the gate: when the list is non-empty a posting must match at
 * least one rule to survive at all. Without it the only postings dropped are
 * the ones a rule names explicitly, so anything unanticipated gets through — a
 * roster of 51 employers produced a digest of 546 postings including network
 * administrators and tooling engineers, because no rule thought to exclude
 * them. An empty include list keeps the old behaviour, which is why it is the
 * default: naming what you want is a decision, not a requirement.
 *
 * `exclude` still wins over `include`, so a rule that names something
 * unwanted overrides a broad include that happened to catch it.
 *
 * Annotate rules never drop anything — they attach a note so a later scoring
 * stage can judge with full context instead of a keyword guess.
 *
 * A rule matches when ANY of its `match` entries hits. To require two terms at
 * once — "graduate" and an engineering discipline, say — use one lookahead
 * regex: `/^(?=.*\bgraduate\b)(?=.*\bengineer\b)/i`.
 *
 * @param {object} posting
 * @param {{include?: object[], exclude?: object[], annotate?: object[]}} rules
 * @returns {{keep: boolean, excludedBy: string|null, notes: string[]}}
 *   `excludedBy` is the id of the exclude rule that dropped it, or the literal
 *   'not-included' when it matched no include rule.
 */
export function applyRules(posting, rules) {
  const include = rules.include ?? [];
  if (include.length > 0 && !include.some((rule) => matches(posting, rule))) {
    return { keep: false, excludedBy: 'not-included', notes: [] };
  }

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
