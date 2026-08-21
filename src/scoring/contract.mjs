/**
 * Enforce the scoring provider contract: exactly one result per input
 * posting, matched by id.
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
  }
  if (expected.size > 0) {
    throw new Error(`scoring provider dropped posting id(s): ${[...expected].join(', ')}`);
  }
}
