/**
 * Normalise what a provider returned into `{ scored, usage }`.
 *
 * A provider returns `Scored[]` — the contract asserted below — or, when it
 * has something to say about what the scoring cost, `{ scored, usage }`. The
 * second form exists because the cost is otherwise invisible: prompt caching
 * is the whole economic justification for one request per posting, a cache
 * that stops working produces no error at all, and the only symptom is a
 * larger bill. `usage` may carry `requests`, `cacheReadTokens` and
 * `cacheCreationTokens`; a provider that cannot observe one leaves it out,
 * which the pipeline reports as null rather than as a zero it did not measure.
 *
 * Anything else is passed straight through, so `assertScoreContract` produces
 * the error rather than this function.
 */
export function unwrapScoreResult(raw) {
  if (!Array.isArray(raw) && raw && typeof raw === 'object' && Array.isArray(raw.scored)) {
    return { scored: raw.scored, usage: raw.usage ?? null };
  }
  return { scored: raw, usage: null };
}

/**
 * Enforce the scoring provider contract: exactly one result per input
 * posting, matched by id, each one a keep with a renderable score.
 *
 * This is checked rather than trusted because the failure it catches is
 * silent and permanent. The CLI records `seen.json` from the provider's
 * returned array, so a posting the provider quietly drops is never marked
 * seen — it is re-fetched, re-enriched and re-offered on every future run,
 * for ever, with nothing anywhere reporting a problem.
 *
 * @throws {Error} on any mismatch
 */
export function assertScoreContract(input, output) {
  if (!Array.isArray(output)) {
    throw new Error('scoring provider did not return an array');
  }

  const expected = new Set(input.map((p) => p.id));
  for (const result of output) {
    // delete() returns false for an id that was never expected OR that a
    // previous result already claimed, which catches duplicates too.
    if (!expected.delete(result?.id)) {
      throw new Error(`scoring provider returned an unknown posting id '${result?.id}'`);
    }

    // Identity is not enough. A provider returning verdict 'omit' would be
    // filtered out of the digest by renderDigest *and* recorded in seen.json
    // by the CLI — disappeared for ever, unseen, with nothing reported. That
    // is the exact failure this module exists to prevent, and the model has
    // no power to omit by design, so a non-'keep' verdict is a broken
    // provider rather than a judgement to honour.
    if (result.verdict !== 'keep') {
      throw new Error(
        `scoring provider returned verdict '${result.verdict}' for posting id '${result.id}' — ` +
        'providers score and rank, they do not decide what the reader sees'
      );
    }

    // null means "could not be scored" and is reported as such. Anything else
    // has to be a score the digest can render and order: [undefined/10] and a
    // comparator returning NaN are both silent when they happen.
    const { score } = result;
    if (!(score === null || (Number.isInteger(score) && score >= 1 && score <= 10))) {
      throw new Error(
        `scoring provider returned an invalid score ${JSON.stringify(score)} for posting id '${result.id}' ` +
        '— expected null or an integer 1-10'
      );
    }
  }
  if (expected.size > 0) {
    throw new Error(`scoring provider dropped posting id(s): ${[...expected].join(', ')}`);
  }
}
