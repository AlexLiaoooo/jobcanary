import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'bin', 'jobcanary.mjs');
const listBody = readFileSync(join(here, 'fixtures/workday-list.json'), 'utf8');
const detailBody = readFileSync(join(here, 'fixtures/workday-detail.json'), 'utf8');

/**
 * A local stand-in for a Workday board, so the CLI can be exercised end to end
 * without touching anybody's server. The workday adapter derives every URL
 * from `site.host`, which makes it the one adapter that can be pointed
 * anywhere — and the one that exercises the enrichment path as well.
 *
 * Three tenants, selected by the site config each test writes:
 *   vantor — serves the list and detail fixtures (the happy path)
 *   broken — always 500s, to drive the all-sites-failed exit locally
 *   empty  — a valid but empty board, to drive the zero-postings exit
 */
let boardRequests = 0;
/** How many board requests the server has answered since the last reset. */
function resetBoardRequests() {
  boardRequests = 0;
}

const server = createServer((req, res) => {
  req.resume();
  boardRequests += 1;
  const json = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
  };

  if (req.url.startsWith('/wday/cxs/broken/')) return json(500, '{"error":"upstream exploded"}');
  if (req.url.startsWith('/wday/cxs/empty/')) return json(200, '{"total":0,"jobPostings":[]}');
  if (req.method === 'POST' && req.url === '/wday/cxs/vantor/External/jobs') return json(200, listBody);
  if (req.method === 'GET' && req.url.startsWith('/wday/cxs/vantor/External/job/')) return json(200, detailBody);
  return json(404, '{"error":"not found"}');
});

const { port } = await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address()));
});
const host = `http://127.0.0.1:${port}`;

after(() => server.close());

// execFile, not execFileSync: the fixture server runs in this process, so the
// event loop has to stay free to answer the child process's requests.
async function runCli(args, { cwd, env } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8' });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function workspace(tenant = 'vantor') {
  const dir = mkdtempSync(join(tmpdir(), 'jc-'));
  const cfg = join(dir, 'config.yaml');
  writeFileSync(cfg, [
    'output:',
    '  dir: ./out',
    'scoring:',
    '  provider: none',
    '  keywords: [thermal]',
    'sites:',
    `  - {id: vantor, company: Vantor Propulsion, type: workday, host: "${host}", tenant: ${tenant}, board: External}`,
    '',
  ].join('\n'), 'utf8');
  return { dir, cfg, out: join(dir, 'out') };
}

const digestName = (out) => readdirSync(out).find((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));

/**
 * Write a stand-in for the `claude` binary that runs `body` under this Node,
 * so the claude-cli provider can be driven end to end through the CLI without
 * anybody having Claude Code installed. Windows cannot execute a bare .mjs,
 * hence the .cmd wrapper there and a shebang wrapper everywhere else.
 */
function stubClaude(body) {
  const dir = mkdtempSync(join(tmpdir(), 'jc-stub-'));
  const js = join(dir, 'stub.mjs');
  writeFileSync(js, body, 'utf8');
  if (process.platform === 'win32') {
    const cmd = join(dir, 'stub.cmd');
    writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`, 'utf8');
    return cmd;
  }
  const sh = join(dir, 'stub.sh');
  writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`, 'utf8');
  chmodSync(sh, 0o755);
  return sh;
}

/**
 * A workspace configured for the claude-cli scoring provider, with a profile
 * on disk. `scoringBody` is the stub's behaviour for the `-p` invocation; it
 * always answers `--version`, so the precondition passes and the run reaches
 * scoring.
 */
function scoringWorkspace(scoringBody) {
  const dir = mkdtempSync(join(tmpdir(), 'jc-'));
  const cfg = join(dir, 'config.yaml');
  writeFileSync(join(dir, 'profile.md'), 'Graduate engineer.', 'utf8');
  writeFileSync(cfg, [
    'output:',
    '  dir: ./out',
    'profile: ./profile.md',
    'scoring:',
    '  provider: claude-cli',
    'sites:',
    `  - {id: vantor, company: Vantor Propulsion, type: workday, host: "${host}", tenant: vantor, board: External}`,
    '',
  ].join('\n'), 'utf8');
  const bin = stubClaude(`
    if (process.argv.includes('--version')) { process.stdout.write('1.2.3'); process.exit(0); }
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => {
      const ids = [...buf.matchAll(/<posting id="([^"]+)">/g)].map((m) => m[1]);
      ${scoringBody}
    });
  `);
  return { dir, cfg, out: join(dir, 'out'), bin };
}

test('--help exits 0 and lists the run command', async () => {
  const r = await runCli(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /jobcanary run/);
});

test('a missing config exits 2', async () => {
  const r = await runCli(['run', '--config', join(tmpdir(), 'does-not-exist.yaml')]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /could not read config/);
});

test('an invalid config exits 2 with a readable message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jc-'));
  const cfg = join(dir, 'config.yaml');
  writeFileSync(cfg, 'scoring: {provider: none}\n', 'utf8');
  const r = await runCli(['run', '--config', cfg]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /needs a non-empty 'sites' list/);
});

test('an unknown adapter type exits 2', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jc-'));
  const cfg = join(dir, 'config.yaml');
  writeFileSync(cfg, 'sites:\n  - {id: a, company: A, type: nonesuch}\n', 'utf8');
  const r = await runCli(['run', '--config', cfg]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown adapter type/);
});

// No test may invoke a real preset. A bundled preset names live career sites,
// so `--preset uk-motorsport` crawls the internet — the version of this test
// that did took 83 seconds. Every case below fails before any site is fetched,
// and the preset's contents are checked by loading the file rather than running
// it (see test/presets.test.mjs).
test('an unknown preset exits 2 and names the ones that exist', async () => {
  const r = await runCli(['run', '--preset', 'nonesuch']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no preset named 'nonesuch'/);
  assert.match(r.stderr, /available: .*uk-motorsport/);
  assert.doesNotMatch(r.stderr, /could not read config/);
});

test('--preset and --config together exit 2', async () => {
  const { cfg } = workspace();
  const r = await runCli(['run', '--preset', 'nonesuch', '--config', cfg]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /either --preset or --config, not both/);
});

test('--help describes the preset flag as usable', async () => {
  const r = await runCli(['--help']);
  assert.match(r.stdout, /--preset <name>\s+Use a bundled preset/);
});

test('--dry reports the counts and writes nothing at all', async () => {
  const { cfg, dir, out } = workspace();
  const r = await runCli(['run', '--config', cfg, '--dry']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /scanned=2 seen=0 excluded=0 kept=2 enrichmentFetches=2 siteErrors=0/);
  assert.match(r.stdout, /--dry: nothing written/);
  assert.equal(existsSync(out), false, 'the output directory must not be created');
  assert.deepEqual(readdirSync(dir), ['config.yaml']);
});

test('a real run writes the digest and the dedup state', async () => {
  const { cfg, out } = workspace();
  const r = await runCli(['run', '--config', cfg]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /scanned=2 seen=0 excluded=0 kept=2/);

  const digest = digestName(out);
  assert.ok(digest, 'a dated digest should have been written');
  const md = readFileSync(join(out, digest), 'utf8');
  assert.match(md, /^# Job Picks — \d{4}-\d{2}-\d{2}$/m);
  assert.match(md, /\*\*Scanned:\*\* 2 · \*\*New:\*\* 2/);
  assert.match(md, /Thermal Systems Engineer · Vantor Propulsion/);
  assert.match(md, new RegExp(`\\*\\*Link:\\*\\* ${host}/en-US/External/job/`));
  // 'thermal' is nowhere in this posting's title — it only appears in the
  // description, which exists solely because the enrichment pass fetched the
  // detail page. Scoring it proves the whole fetch → enrich → score chain ran.
  assert.match(
    md,
    /Graduate Simulation Engineer · Vantor Propulsion\n[^\n]*\n- \*\*Fit:\*\* Matched configured keywords: thermal\./
  );

  const seen = JSON.parse(readFileSync(join(out, 'seen.json'), 'utf8'));
  assert.deepEqual(Object.keys(seen).sort(), ['vantor:R-1001', 'vantor:R-1002']);
});

test('a second run against the same state reports the postings as already seen', async () => {
  const { cfg, out } = workspace();
  const first = await runCli(['run', '--config', cfg]);
  assert.equal(first.code, 0);

  const second = await runCli(['run', '--config', cfg]);
  assert.equal(second.code, 0);
  assert.match(second.stdout, /scanned=2 seen=2 excluded=0 kept=0/);
  // Nothing new survived the seen filter, so nothing was enriched either.
  assert.match(second.stdout, /enrichmentFetches=0/);
});

test('a second run with nothing new leaves the existing digest untouched', async () => {
  const { cfg, out } = workspace();
  await runCli(['run', '--config', cfg]);
  const name = digestName(out);
  const before = readFileSync(join(out, name), 'utf8');
  assert.match(before, /\*\*New:\*\* 2/, 'the first run should have produced a real digest');

  const second = await runCli(['run', '--config', cfg]);
  assert.equal(second.code, 0);
  assert.match(second.stdout, /left it untouched/);
  assert.doesNotMatch(second.stdout, /^wrote /m);

  // The whole point: the first run's results survive a second run.
  assert.equal(readFileSync(join(out, name), 'utf8'), before);
  assert.deepEqual(readdirSync(out).filter((f) => f.endsWith('.md')), [name]);
});

test('a later run that does find something new writes alongside, never over', async () => {
  const { cfg, out } = workspace();
  await runCli(['run', '--config', cfg]);
  const name = digestName(out);
  const before = readFileSync(join(out, name), 'utf8');

  // Forget what was seen, so this run has genuinely new postings to report
  // while today's digest already exists.
  writeFileSync(join(out, 'seen.json'), '{}', 'utf8');

  const second = await runCli(['run', '--config', cfg]);
  assert.equal(second.code, 0);
  const suffixed = name.replace(/\.md$/, '-2.md');
  assert.ok(second.stdout.includes(suffixed), `expected stdout to name ${suffixed}`);
  assert.equal(readFileSync(join(out, name), 'utf8'), before, 'the earlier digest must be intact');
  assert.match(readFileSync(join(out, suffixed), 'utf8'), /\*\*New:\*\* 2/);
  assert.deepEqual(readdirSync(out).filter((f) => f.endsWith('.md')).sort(), [name, suffixed].sort());
});

test('every site failing exits 3', async () => {
  const { cfg } = workspace('broken');
  const r = await runCli(['run', '--config', cfg]);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /all 1 site\(s\) failed/);
});

test('every site returning zero postings exits 3', async () => {
  const { cfg, out } = workspace('empty');
  const r = await runCli(['run', '--config', cfg]);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /all 1 site\(s\) returned zero postings/);
  assert.match(r.stderr, /adapter has gone stale/);
  assert.equal(existsSync(out), false, 'a systemic break must not write an empty digest');
});

// The binary runs and answers --version, so the precondition passes and the
// run reaches scoring — where every batch comes back as prose instead of JSON.
// Every posting degrades to unscored individually (claude-cli.mjs's own,
// deliberate behaviour — see scoring.claude-cli.test.mjs), and it is
// src/pipeline.mjs's total-failure guard that turns "nothing at all got
// scored" into stats.scoringError and this exit 4.
test('a scoring failure still writes the digest and exits 4', async () => {
  const { dir, cfg, out, bin } = scoringWorkspace("process.stdout.write('I am afraid I cannot do that');");

  const r = await runCli(['run', '--config', cfg], {
    cwd: dir,
    env: { ...process.env, JOBCANARY_CLAUDE_BIN: bin },
  });
  assert.equal(r.code, 4, 'scoring failed but the crawl succeeded');
  const name = readdirSync(out).find((f) => f.endsWith('.md'));
  assert.ok(name, 'the digest must still be written');
  const md = readFileSync(join(out, name), 'utf8');
  assert.match(md, /\[—\]/, 'postings appear unscored rather than vanishing');
  assert.match(r.stderr, /scoring/i);
  // Nothing was scored, so nothing is marked seen. Recording them here would
  // retire every posting of the run on the strength of a failure.
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'seen.json'), 'utf8')), {});
});

test('a partly failed scoring run records only the postings that were scored', async () => {
  // The stub scores the first posting of the batch and forgets the second,
  // which is what a rate limit looks like from here: exit 0, a digest with one
  // ranked posting and one [—].
  const { dir, cfg, out, bin } = scoringWorkspace(
    "process.stdout.write(JSON.stringify({ scores: [{ id: ids[0], score: 6, rationale: 'scored fine' }] }));"
  );

  const r = await runCli(['run', '--config', cfg], {
    cwd: dir,
    env: { ...process.env, JOBCANARY_CLAUDE_BIN: bin },
  });
  assert.equal(r.code, 0, 'a partial failure is tolerated, not escalated');
  assert.match(r.stdout, /kept=2 /);
  assert.match(r.stdout, /unscored=1 scoring=ok/, 'the summary line has to show the failure');

  const md = readFileSync(join(out, readdirSync(out).find((f) => f.endsWith('.md'))), 'utf8');
  assert.equal((md.match(/### \[—\]/g) ?? []).length, 1);
  assert.equal((md.match(/### \[6\/10\]/g) ?? []).length, 1);

  // The unscored one is deliberately not retired: it gets another chance next
  // run instead of having been shown once, unranked, and never again.
  const seen = JSON.parse(readFileSync(join(out, 'seen.json'), 'utf8'));
  assert.equal(Object.keys(seen).length, 1, `expected one recorded id, got ${JSON.stringify(seen)}`);
});

test('a fully scored run records every posting and reports unscored=0', async () => {
  const { dir, cfg, out, bin } = scoringWorkspace(
    "process.stdout.write(JSON.stringify({ scores: ids.map((id, i) => ({ id, score: i + 2, rationale: 'r' })) }));"
  );

  const r = await runCli(['run', '--config', cfg], {
    cwd: dir,
    env: { ...process.env, JOBCANARY_CLAUDE_BIN: bin },
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /unscored=0 scoring=ok/);
  const seen = JSON.parse(readFileSync(join(out, 'seen.json'), 'utf8'));
  assert.deepEqual(Object.keys(seen).sort(), ['vantor:R-1001', 'vantor:R-1002']);

  // What the scoring cost. claude-cli cannot see inside the process it spawns,
  // so it says so rather than printing a zero it never measured.
  assert.match(r.stdout, /^scoringRequests=1 cache=unreported$/m);
});

test('--dry exits 4 when scoring failed, rather than reporting success', async () => {
  // --dry changes what is written, not what happened. Exit 0 here would tell
  // a script the run was fine.
  const { dir, cfg, out, bin } = scoringWorkspace("process.stdout.write('not json at all');");
  const r = await runCli(['run', '--config', cfg, '--dry'], {
    cwd: dir,
    env: { ...process.env, JOBCANARY_CLAUDE_BIN: bin },
  });
  assert.equal(r.code, 4);
  assert.match(r.stdout, /--dry: nothing written/);
  assert.match(r.stderr, /scoring failed/);
  assert.equal(existsSync(out), false, 'a dry run still writes nothing');
});

test('a run that scores nothing prints no cost line at all', async () => {
  // The `none` provider issues no requests; a line of zeroes would be noise.
  const { cfg } = workspace();
  const r = await runCli(['run', '--config', cfg]);
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.stdout, /scoringRequests=/);
});

// The three precondition failures the spec requires to be caught before any
// site is fetched. Each is a config error (exit 2), and the fixture server
// must not have been asked for a single thing.

test('a claude-cli binary that is not there exits 2 before any site is fetched', async () => {
  const { dir, cfg } = scoringWorkspace('process.stdout.write("{}");');
  resetBoardRequests();
  const r = await runCli(['run', '--config', cfg], {
    cwd: dir,
    env: { ...process.env, JOBCANARY_CLAUDE_BIN: 'jobcanary-claude-does-not-exist' },
  });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /config error/);
  assert.match(r.stderr, /could not run 'jobcanary-claude-does-not-exist'/);
  assert.equal(boardRequests, 0, 'the crawl must not have been paid for');
});

test('a profile that cannot be read exits 2 before any site is fetched', async () => {
  const { dir, cfg, out, bin } = scoringWorkspace('process.stdout.write("{}");');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('./profile.md', './does-not-exist.md'), 'utf8');
  resetBoardRequests();
  const r = await runCli(['run', '--config', cfg], {
    cwd: dir,
    env: { ...process.env, JOBCANARY_CLAUDE_BIN: bin },
  });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /could not read profile at/);
  assert.equal(boardRequests, 0, 'the crawl must not have been paid for');
  assert.equal(existsSync(out), false, 'nothing is written when the config never validated');
});

// The optional peer dependency is deliberately absent from this repo’s install
// (`npm ls` shows one dependency), so the test below runs the real path.
//
// Guarded for the checkout where someone has followed the README and installed
// it, because there the failure is not a red test: the precondition would pass,
// the crawl would proceed, and the anthropic provider would issue real outbound
// requests to api.anthropic.com — up to six, with maxRetries 2 across two
// postings — before the assertion below caught it. This suite promises in the
// README and in CI that it touches no third-party host, and that promise has to
// hold on a contributor’s machine too, not only on one where the SDK is absent.
const sdkInstalled = await import('@anthropic-ai/sdk').then(() => true, () => false);

test('a missing @anthropic-ai/sdk exits 2 before any site is fetched', {
  skip: sdkInstalled ? '@anthropic-ai/sdk is installed in this checkout' : false,
}, async () => {
  // The optional peer dependency is not installed in this repo, so this is
  // the real path: it used to throw out of score(), after the whole crawl.
  const { dir } = workspace();
  const cfg = join(dir, 'anthropic.yaml');
  writeFileSync(join(dir, 'profile.md'), 'Graduate engineer.', 'utf8');
  writeFileSync(cfg, [
    'output:',
    '  dir: ./out',
    'profile: ./profile.md',
    'scoring:',
    '  provider: anthropic',
    'sites:',
    `  - {id: vantor, company: Vantor Propulsion, type: workday, host: "${host}", tenant: vantor, board: External}`,
    '',
  ].join('\n'), 'utf8');
  resetBoardRequests();

  const r = await runCli(['run', '--config', cfg], {
    cwd: dir,
    env: { ...process.env, ANTHROPIC_API_KEY: 'sk-test-not-used' },
  });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /@anthropic-ai\/sdk/);
  assert.equal(boardRequests, 0, 'the crawl must not have been paid for');
});

test('a missing ANTHROPIC_API_KEY exits 2 before any site is fetched', async () => {
  const { dir } = workspace();
  const cfg = join(dir, 'anthropic.yaml');
  writeFileSync(join(dir, 'profile.md'), 'Graduate engineer.', 'utf8');
  writeFileSync(cfg, [
    'output:',
    '  dir: ./out',
    'profile: ./profile.md',
    'scoring:',
    '  provider: anthropic',
    'sites:',
    `  - {id: vantor, company: Vantor Propulsion, type: workday, host: "${host}", tenant: vantor, board: External}`,
    '',
  ].join('\n'), 'utf8');
  resetBoardRequests();

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  const r = await runCli(['run', '--config', cfg], { cwd: dir, env });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /ANTHROPIC_API_KEY/);
  assert.equal(boardRequests, 0, 'the crawl must not have been paid for');
});

test('an LLM provider without a profile exits 2 before any fetch', async () => {
  const { dir } = workspace();
  const cfg = join(dir, 'noprofile.yaml');
  writeFileSync(cfg, [
    'output:',
    '  dir: ./out',
    'scoring:',
    '  provider: anthropic',
    'sites:',
    `  - {id: vantor, company: Vantor Propulsion, type: workday, host: "${host}", tenant: vantor, board: External}`,
    '',
  ].join('\n'), 'utf8');

  const r = await runCli(['run', '--config', cfg]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /needs 'profile'/);
});
