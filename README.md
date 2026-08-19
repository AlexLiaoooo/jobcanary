# jobcanary

A config-driven job monitor: it polls career sites and ATS job boards, filters and scores the postings against rules you define, and writes a ranked Markdown (or JSON) digest.

## What it does

- Fetches job listings from a small set of ATS adapters (Greenhouse, Lever, Workday) using their public, unauthenticated JSON APIs.
- Filters postings against `exclude` and `annotate` rules you write (regex or plain-text matching on title, company, location, or description).
- Scores the survivors and ranks them.
- Deduplicates against a `seen.json` file so the same posting is not reported twice.
- Writes a ranked digest to disk as Markdown, JSON, or both.

## What it does not do

- **It does not apply to jobs.** jobcanary only reads and reports; it never submits an application, fills a form, or sends anything on your behalf.
- **It has no LinkedIn adapter**, and none is planned — LinkedIn's terms prohibit this kind of automated access. See [Sources and terms](#sources-and-terms).
- It does not (yet) call an LLM to score postings. See [Scoring providers](#scoring-providers).

## Install

Requires Node.js 20 or later.

```bash
git clone <repository-url>
cd jobcanary
npm install
```

This installs the single runtime dependency (`yaml`) and nothing else — job fetching uses the platform `fetch`, and argument parsing uses `node:util`'s `parseArgs`, so there is no CLI framework to pull in.

Run the CLI directly with Node:

```bash
node bin/jobcanary.mjs run --config examples/config.yaml
```

Or link it so the `jobcanary` command is on your `PATH`:

```bash
npm link
jobcanary run --config examples/config.yaml
```

## Quickstart

[`examples/config.yaml`](examples/config.yaml) is a complete, runnable configuration against three fictional companies. Copy it as a starting point:

```bash
cp examples/config.yaml jobcanary.yaml
# edit jobcanary.yaml: replace the example sites with real boards, adjust keywords and rules
jobcanary run --config jobcanary.yaml
```

A first run creates the output directory (`./digests` by default) and writes a dated digest, e.g. `digests/2026-08-19.md`, plus a `digests/seen.json` dedup file. Re-running the same command later only reports postings that are new since the last run.

Add `--dry` to fetch and see the counts without writing anything:

```bash
jobcanary run --config jobcanary.yaml --dry
```

## Config reference

A config file is YAML. Every key below is optional except `sites`.

```yaml
profile: ./profile.md        # optional; a free-text file describing you, passed to scoring providers that use it (default: none)

output:
  dir: ./digests              # where digests and seen.json are written (default: ./digests)
  format: markdown            # markdown | json | both (default: markdown)

dedupe:
  retentionDays: 30           # positive integer; how long a posting id is remembered in seen.json (default: 30)

scoring:
  provider: none               # none | anthropic | claude-cli (default: none)
  keywords: [graduate, cfd]     # used only by the 'none' provider (default: [])
  model: claude-opus-5           # reserved for the 'anthropic'/'claude-cli' providers (default: claude-opus-5)
  effort: high                    # reserved for the 'anthropic'/'claude-cli' providers (default: high)
  batch: true                      # reserved for the 'anthropic' provider's Batch API (default: true)

rules:                        # optional; both lists default to empty (no filtering, nothing excluded)
  exclude:                     # postings matching any exclude rule are dropped entirely
    - id: senior                # required (any truthy value); identifies the rule in the internal verdict, not surfaced in the digest or logs — not required to be unique
      field: title               # title | company | location | description | all (default: all)
      match: ["senior", "/^head of/i"]   # plain strings match case-insensitively as literals;
                                          # a /regex/flags string compiles as a real regex
  annotate:                    # postings matching an annotate rule are kept, with a note attached
    - id: right-to-work
      field: description
      match: ["no visa sponsorship"]
      note: "Mentions a sponsorship restriction — verify eligibility"   # required for annotate rules

sites:                         # required, at least one entry
  - id: acme                    # required, unique within the config
    company: Acme Dynamics       # required — shown in the digest
    type: greenhouse              # required — see the adapter table below
    enabled: true                  # optional (default: true) — set false to keep a site configured but skip it
    board: acmedynamics             # adapter-specific fields go here; see below
```

`scoring.model`, `scoring.effort`, and `scoring.batch` are parsed and defaulted by the config loader today, but nothing reads them yet — the `none` provider ignores all three. They exist so that a config file written against the `anthropic`/`claude-cli` providers arriving in a later release will already validate; setting them now is harmless but has no effect on a run.

Each `match` entry is either a plain string (matched case-insensitively as a literal substring/word) or a `/pattern/flags` string, which compiles to a real `RegExp` with the flags given — so `/PhD/` is case-sensitive while `/PhD/i` is not.

The `g` and `y` flags are accepted but ignored: they make a `RegExp` stateful (`.test()` advances `lastIndex`), and a rule is compiled once and reused for every posting, so honouring them would make a rule match every *other* posting. `/senior/gi` therefore behaves exactly like `/senior/i`.

### Postings excluded on their description are re-fetched every run

`seen.json` records only the postings that reached a digest. A posting dropped by an `exclude` rule is never recorded — so for a `workday` site, whose descriptions cost a second request per posting, that detail page is fetched again on the next run, and on every run after that.

This is deliberate. Recording exclusions would stop the repeat fetch, at the price of a worse failure: your rules are live and editable, and a posting excluded under yesterday's rules has to be able to surface once you loosen them. State that outlives the rule which produced it silently contradicts your config.

The cost is reported rather than hidden. The run summary's `enrichmentFetches=` count is the number of detail requests the run actually performed; `stats.enrichmentFetches` carries the same number to library callers and into the JSON digest, alongside `stats.excludedIds`. If that count is high and `kept` is low, prefer rules that match on `title` (no detail request needed) over rules that match on `description`.

A later release will make this converge properly — a separate excluded-id map, invalidated by a hash of the rules, so an exclusion is remembered only for as long as the rules that produced it are unchanged.

## Adapters

Every adapter reads a site's public, unauthenticated job API — no login, no API key. The `type` you choose determines which extra fields the site entry needs:

| `type`       | Required fields              | Notes |
|--------------|-------------------------------|-------|
| `greenhouse` | `board`                       | Greenhouse board token, e.g. the `xyz` in `boards.greenhouse.io/xyz`. Descriptions ship with the listing. |
| `lever`      | `board`                       | Lever account slug, e.g. the `xyz` in `jobs.lever.co/xyz`. Descriptions ship with the listing. |
| `workday`    | `host`, `tenant`, `board`     | `host` is the tenant's Workday origin (e.g. `https://acme.wd3.myworkdayjobs.com`), `tenant` the CXS tenant name, `board` the career site name (often `External`). Descriptions require a second request per posting, done automatically for postings that survive the rules. |

Only these three adapters exist today. A larger adapter fleet (static career pages, and ATS platforms including Ashby, SmartRecruiters, Personio, Recruitee, Occupop, and others) is planned for a later release, along with a browser-driven tier for sites with no JSON API.

## Scoring providers

- **`none`** (the default) — a deterministic, offline keyword scorer. It counts matches against `scoring.keywords` and never omits a posting; it exists so the tool is fully useful and testable without any API key or network call beyond fetching the listings themselves.
- **`anthropic`** and **`claude-cli`** — LLM-backed scoring against your `profile`, giving a rationale and a fit judgement per posting. These are planned for a later release and are not implemented yet; setting `scoring.provider` to either one today passes config validation, but `jobcanary run` then stops with a config error (exit 2) before it fetches a single site, so no crawling work is done and discarded.

## Exit codes

| Code | Meaning |
|------|---------|
| 0    | Success |
| 1    | Unexpected error |
| 2    | Config invalid (missing file, bad YAML, unknown adapter type, failed validation) |
| 3    | Every configured site failed to fetch, or every site returned zero postings (a systemic break: network down, or an adapter gone stale) |
| 4    | Reserved for scoring failures — not used yet; the `none` provider is pure and cannot fail. Introduced when the LLM providers arrive. |

## Sources and terms

jobcanary reads **public career pages and unauthenticated ATS endpoints only**. It does not log in, does not use private or scraped credentials, and does not bypass any access control.

You are responsible for the terms of service of any site you configure jobcanary to poll. Automated access is not universally permitted — check before you add a site, and keep your request rate reasonable.

No adapter will be accepted into this project for a site whose terms of service prohibit automated access. This is why there is no LinkedIn adapter and none is planned.
