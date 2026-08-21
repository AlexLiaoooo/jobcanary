# jobcanary — LLM scoring providers

**Date:** 2026-08-20
**Status:** Approved, pending implementation plan
**Follows:** `2026-08-19-jobcanary-design.md` (Plan 1, shipped)

## Purpose

Give jobcanary the judgement it currently lacks. Plan 1 ranks postings by
counting configured keywords. This adds two providers that score each posting
against the user's own profile with an LLM, and explain the score in a line.

Without this the tool is another ATS scraper. With it, the digest is a
shortlist someone can act on.

## Sequencing note

The parent spec listed the adapter fleet as Plan 2 and this as Plan 3. That
order was wrong. The motorsport preset depends on adapters that do not exist
yet, but these providers depend on nothing: they plug into the `scoring`
interface Plan 1 already ships and already exercises with `none`. They also
force two contract decisions that get more expensive to make later, so they
come first.

## What the model is allowed to decide

**Score and rank only. It never omits a posting.**

Every posting that survives the rules appears in the digest. The model's
judgement is expressed as position and rationale, never as a deletion. A bad
score is visible and correctable; a silent omission is not — a user cannot
question what they never saw.

This also keeps the whole pipeline consistent. The rules engine already
refuses to drop on a keyword guess, annotating instead so a later stage can
judge with context. Handing the later stage a deletion power the earlier stage
deliberately declined would be incoherent.

The `verdict` field stays in the `Scored` shape and is always `'keep'`. The
Markdown writer's `omit` filter stays where it is; nothing produces one today.

## The provider contract

`score(postings, opts) → Scored[]` must return **exactly one `Scored` per
input posting**, matched by id.

This is enforced in `run()`, not merely documented: after the call, the
pipeline compares count and id set, and throws on a mismatch. The failure it
prevents is specific and silent. The CLI writes `seen.json` from the
provider's returned array, so a provider that drops a posting instead of
scoring it makes that posting immortal — re-fetched, re-enriched, and
re-offered on every future run, with no error anywhere.

`Scored` = `Posting & { score: number|null, rationale: string, verdict: 'keep' }`.

`score: null` means the posting could not be scored. It is still reported,
ranked last, with the reason in its rationale.

## The `anthropic` provider

One request per posting, concurrency-capped.

```js
client.messages.parse({
  model,                                   // config; default claude-opus-5
  max_tokens: 1024,
  system: [{ type: 'text', text: PREFIX, cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: postingBlock }],
  thinking: { type: 'adaptive' },
  output_config: { format: { type: 'json_schema', schema: SCORE_SCHEMA }, effort },
})
```

### Why one request per posting

Not cost — correctness. Batching N postings into one request introduces a
pairing step, and the failure mode is a response carrying nine scores for ten
postings, silently attaching the wrong rationale to the wrong job. One in, one
out has no pairing step to get wrong, isolates a failure to a single posting,
and matches the row-level tolerance the adapters already have.

The cost objection is answered by caching, below.

### Caching

`PREFIX` is the rubric followed by the profile, and is byte-identical across
every call in a run. That makes it exactly the stable prefix prompt caching
wants, and it is what makes per-posting requests economical rather than
wasteful. Nothing volatile — no timestamp, no per-posting id, no run counter —
may enter `PREFIX`; a single byte of drift silently costs the cache.

A test asserts the prefix is identical across calls, because a cache that
stops working produces no error, only a larger bill.

### The posting block carries its notes

The user message contains the posting's title, company, location, description
and **its `notes`** — the annotations attached by `annotate` rules.

This closes the loop the rules engine was designed for. A blunt keyword match
flags "no visa sponsorship" as a concern it is not competent to adjudicate;
the model receives that flag and weighs it against everything else it knows
about the role. Neither layer decides alone.

### Structured output

`output_config.format` with a raw JSON schema. TypeScript supports the
`{ type: 'json_schema', schema }` form directly, so this needs no `zod`
dependency.

`SCORE_SCHEMA` is `{ score: integer 1-10, rationale: string }`. The provider
supplies `verdict: 'keep'` itself; it is not the model's to set.

### Failure paths

Both isolate to one posting rather than the run:

- `parsed_output` comes back `null` — the response did not satisfy the schema.
- `stop_reason === 'refusal'` — a safety classifier declined.

Either yields that posting with `score: null` and a stated reason. It appears
in the digest, ranked last.

**Server-side refusal fallbacks are deliberately not enabled.** The general
guidance is to include them by default on Opus 5, but they are a beta surface
aimed at content that trips safety classifiers, and scoring an engineering job
advert will not. Checking `stop_reason` is simpler and sufficient. Revisit if
a refusal is ever actually observed.

## The `claude-cli` provider

Same interface, different cost model. Each call is a process spawn of one to
two seconds, not an HTTP request, so forty spawns is a minute of dead time.
This provider batches ten postings per invocation.

Batching reintroduces the pairing risk the `anthropic` provider avoids, so it
is handled explicitly: each item must echo the posting id it refers to, and
the provider matches on that id and never on position. Any posting missing
from the response comes back `score: null` rather than being silently dropped
— the contract assertion in `run()` would reject a short array anyway.

It exists because it is free for anyone who already has Claude Code, which is
a real audience for a tool like this.

## Changes to existing code

### `run()` returns a scoring error instead of throwing

Today the `score` call is unguarded, so a provider throw propagates out of
`run` and the run's entire fetch work is discarded. That contradicts the
parent spec, which requires a failing scoring call to still write an unscored
digest.

`run` now catches, falls back to unscored postings, and reports
`stats.scoringError`. The CLI writes the digest anyway, prints the error, and
exits 4 — making that exit code reachable for the first time.

This is a change to `run`'s return contract, which is the second reason these
providers come before the adapter fleet: ten more adapters built against the
current shape would make it costly to change.

### `renderDigest` handles a null score

Renders `[—]` rather than `[9/10]`, and sorts null scores last. Ties among
nulls keep the existing alphabetical-by-company rule.

## Config

```yaml
profile: ./profile.md      # already exists; now required for LLM providers
scoring:
  provider: anthropic      # none | anthropic | claude-cli
  model: claude-opus-5
  effort: high
  concurrency: 5
  batch: false
  rubric: ./rubric.md      # optional; overrides the built-in
```

`none` remains the default. A fresh clone must not cost money until someone
opts in.

### Fail fast, before the crawl

A missing or unreadable `profile` is a `ConfigError` at exit 2 for either LLM
provider. Each provider also declares its own precondition, checked at the
same point: `anthropic` requires `ANTHROPIC_API_KEY` in the environment,
`claude-cli` requires the `claude` binary on `PATH`. Neither is the other's
concern — a `claude-cli` user needs no API key.

All of these fail **before any site is fetched**. Plan 1 already fixed
the equivalent bug for provider resolution; this holds the same line. Paying
for a full crawl and every enrichment request before discovering a missing
API key is the exact failure that fix existed to prevent.

### The Batch API is opt-in, never default

`batch: true` uses the Message Batches API at half the cost. It is off by
default because its SLA is up to 24 hours, and a *daily* digest that may
arrive a day late fails at the one thing the tool exists to do. It suits a
large one-off backfill, not the scheduled path.

## The rubric

The repo ships one neutral built-in: score fit 1–10 against the supplied
profile, justify in a line. `rubric:` points at a file that replaces it.

Deliberately generic. The author's own rubric — the experience-gap cap,
right-to-work flagging, seniority down-scoring — stays in a local file, out of
the public repo, for the same reason the target-company roster does.

## Dependencies

The core keeps its single runtime dependency. `@anthropic-ai/sdk` is an
optional peer, loaded by dynamic `import()` inside the provider, with a clear
install message when absent. Someone scoring by keyword installs `yaml` and
nothing else.

"One dependency" is a real feature of this tool and worth a little
indirection to keep.

## Testing

The provider takes an injectable client, exactly as adapters take `ctx.http`.
No test spends money or touches the network.

Tests assert what cannot be eyeballed:

- the cached prefix is byte-identical across calls in a run
- a contract violation (short array, wrong ids) throws
- a null `parsed_output` degrades to one unscored posting, not a failed run
- a refusal `stop_reason` does the same
- the concurrency cap holds
- a posting's `notes` reach the prompt
- `run` returns `scoringError` and unscored postings when the provider throws
- the CLI exits 4 and still writes a digest in that case
- `renderDigest` places null scores last and renders them as `[—]`

One live smoke test exists behind an env var. Skipped by default, never in CI.

## Out of scope

- Any power for the model to omit postings
- Scoring providers beyond `anthropic` and `claude-cli`
- The motorsport preset and the adapter fleet (they follow this)
- The GitHub Actions daily workflow
- Caching scores across runs
