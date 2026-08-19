# jobcanary — Design

**Date:** 2026-08-19
**Status:** Approved, pending implementation plan

## Purpose

A config-driven job monitor. It polls company career sites and applicant
tracking systems, filters postings against rules the user owns, scores the
survivors against the user's own profile with an LLM, and writes a ranked
Markdown digest.

It is not an auto-apply bot. The output is a shortlist a person reads.

## Origin and scope boundary

The tool is extracted from a working private pipeline in
`AI_Work\[Job Tracker]`, which contains two independent scrapers:

1. A LinkedIn monitor that drives a logged-in browser session.
2. A career-site poller covering 88 companies across 12 adapter types.

**Only the second ships.** LinkedIn's User Agreement §8.2 prohibits
developing, supporting, or using software to scrape its services, and that
clause covers publication, not merely operation. The LinkedIn scraper stays
private and unpublished. The published tool documents legitimate aggregator
APIs (Adzuna, Reed, Arbeitnow) as the supported route to that coverage.

The private pipeline is **not** migrated onto this codebase. It keeps running
untouched. This repo is a clean extraction; divergence between the two is
accepted in exchange for zero risk to a daily-driver workflow.

## Architecture

Approach: importable ESM library, thin CLI wrapper, GitHub Actions template.
Adapters are internal modules behind one interface — not separate packages.

### Pipeline

```
load config
  → fetch (adapters)
  → normalise
  → dedupe within run
  → filter against seen state
  → apply rules
  → enrich (optional description fetch)
  → score (provider)
  → render (writer)
  → persist state
```

Every stage except `fetch` and `score` is a pure function taking and
returning plain data, so each is unit-testable without network or LLM.

### Flag, don't block

Rules have two verbs, not one:

- `exclude` — drops the posting outright.
- `annotate` — attaches a note and keeps the posting.

This is inherited deliberately from the source pipeline. Keyword matching is
too blunt to decide questions like "is this company actually in the sector I
want?" — the source's own comments record it failing on Veolia, Sureserve,
and Ameresco. Annotations ride into the scoring prompt so the model decides
with real knowledge of the company. A posting is never silently dropped
before the smart layer sees it.

### Adapter interface

```js
export default {
  id: 'workday',
  tier: 'http',                     // 'http' | 'browser'
  async fetch(site, ctx) { }        // → Posting[]
}
```

`ctx` supplies `{ http, logger, timeoutMs, browser }`.

An adapter also declares `yieldsDescription: true|false`. Most ATS APIs
return the full description in the listing response; static sites do not.
The enrich stage runs only for postings from adapters that declare `false`,
and only for postings that survived the rules — so a second page load is
never paid for on a posting that was going to be dropped anyway.

Normalised posting:

```js
{ id, title, company, location, url, postedAt, description, source, notes[] }
```

Adapters ship: `static`, `workday`, `smartrecruiters`, `pinpoint`,
`personio`, `workable`, `oracle`, `recruitee`, `occupop`, `ashby`,
`sfrss`, plus `greenhouse` and `lever` (new — the two most common boards
globally, absent from the source pipeline).

### Two tiers

`http` adapters run by default. `browser` adapters require `--browser`.

The split is not cosmetic. An HTTP adapter that breaks *throws*, is caught
per-site, and the run continues. A browser *hangs*, and a hang kills the
whole run. So the browser tier is opt-in, runs after all HTTP work has been
banked, and each browser site gets its own hard timeout and a fresh context.

### Config

YAML. Regex-valued fields are written as strings and compiled at load, so
config stays data rather than code. Only `static` sites need regexes; the
typed adapters need none.

```yaml
profile: ./profile.md
scoring:
  provider: anthropic          # anthropic | claude-cli | none
  model: claude-opus-5
  effort: high
  batch: true
output:
  dir: ./digests
  format: markdown             # markdown | json | both
dedupe:
  retentionDays: 30
rules:
  exclude:
    - { id: senior, match: ["senior", "principal", "head of"], field: title }
  annotate:
    - id: right-to-work
      field: description
      match: ["no visa sponsorship", "right to work"]
      note: "Mentions right-to-work requirement — verify eligibility"
sites:
  - { id: mclaren-racing, company: McLaren Racing, type: recruitee, url: "https://racingcareers.mclaren.com" }
```

Presets resolve by name: `--preset uk-motorsport` loads
`presets/uk-motorsport.yaml`, shipping the 88-company motorsport,
automotive, and aerospace roster as a working out-of-box demo. Disabled
sites stay in the preset with `enabled: false` and a reason, so an
unscrapable board is visible rather than forgotten.

## Scoring

### Provider interface

```js
export default {
  id: 'anthropic',
  async score(postings, { profile, rubric, model, effort }) { }  // → Scored[]
}
```

`Scored` = `{ ...posting, score, rationale, verdict }`.

Three providers:

- **`anthropic`** (default) — `@anthropic-ai/sdk`, portable, CI-capable.
- **`claude-cli`** — shells out to `claude -p`; free for Claude Code users.
- **`none`** — deterministic keyword ranking. No key, no network, no cost.

### The LLM returns data, never writes files

The source pipeline asks the model to score, write three files, and prune
dedup state in one call. That is why its orchestrator carries a six-minute
timeout, a process-tree kill, two attempts, and a fallback unscored digest:
LLM file-writing fails in ways the caller cannot verify.

Here the model returns structured output only — validated against a JSON
schema via `output_config.format` — and the tool performs all I/O. The
elaborate retry apparatus reduces to ordinary HTTP retry, which the SDK
already provides.

### Cost controls

- **Prompt caching.** Profile and rubric are byte-identical across every
  request in a run. They are the stable prefix; cache them once.
- **Batch API by default.** A daily digest is not latency-sensitive; batch
  costs 50% of sync. `--sync` opts out.
- **Model is config.** Default `claude-opus-5`; `claude-haiku-4-5` is the
  documented cheap option.

Estimated cost at ~40 postings/day with caching: under $10/month on Opus 5,
nearer $2 on Haiku 4.5, roughly halved again by the Batch API. To be
replaced with a measured figure once a real run exists.

Credentials come from `ANTHROPIC_API_KEY` in the environment only. No key
is ever read from a config file.

## Output

Writers are pluggable: `markdown` (ranked digest, score-descending, ties
alphabetical by company) and `json`. Output path is templated on `{date}`.

The Markdown schema carries per-posting Role, Requirements, Company,
Location, Fit, any annotations, and the link.

## Runners

1. **Local** — `npx jobcanary run --preset uk-motorsport`
2. **GitHub Actions** — `.github/workflows/daily.yml` template. Fork, add
   `ANTHROPIC_API_KEY` as a secret, receive a digest committed daily. No
   install. Dedup state commits back to the user's own fork.
3. **Docs recipes** — Windows Task Scheduler and cron.

The Actions path is the headline route, because it is the only one with no
install step and it works on every platform.

## Error handling

- A failing site is caught, logged, and skipped; the run continues.
- Zero postings across *all* sites is an error, not an empty digest — it
  means a systemic break (network, or every adapter stale).
- A failing scoring call falls back to writing an unscored digest rather
  than losing the run's fetch work.
- Exit codes: `0` ok, `1` unexpected, `2` config invalid, `3` all sites
  failed, `4` scoring failed (digest still written, unscored).

## Testing

`node --test`. The 364 lines of existing tests for extraction, dedup, and
filtering port over — they already test pure functions against fixtures.

Per-adapter tests run against **synthetic fixtures only**: hand-written
JSON and HTML mimicking each ATS response shape, using fictional companies.
No captured third-party markup enters the repo, which also resolves the
copyright question hanging over the source pipeline's stored LinkedIn page.

CI runs the suite on push.

## Data hygiene

- No state committed: `seen.json`, digests, and logs are gitignored.
- No personal data: the profile is a user-supplied file, never a default.
- Application-history annotations in the source roster are stripped from the
  shipped preset.
- No absolute paths from the author's machine anywhere in the tree.

## Distribution

Public GitHub repo under `AlexLiaoooo`. MIT. Node 20+, ESM.

**Not published to npm** in v1. The name is unclaimed and stays available;
publishing requires the author's explicit decision.

## Build order

1. Config loader and schema validation
2. Rules engine (exclude + annotate)
3. Dedup and state
4. Adapters — typed first, then static, then browser tier
5. Scoring providers — `none`, then `anthropic`, then `claude-cli`
6. Output writers
7. CLI
8. Actions workflow
9. README, preset, docs

The deterministic core (1–4) lands first so every later stage has something
real to run against.

## Explicitly out of scope

- Auto-applying to jobs
- A hosted service or web UI
- Adapters as separately published packages
- Migrating the private pipeline onto this codebase
- Any LinkedIn adapter
