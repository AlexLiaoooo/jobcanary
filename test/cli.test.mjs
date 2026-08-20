import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
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
const server = createServer((req, res) => {
  req.resume();
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
async function runCli(args, { cwd } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
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

test('--preset says presets are not bundled yet rather than a missing-file error', async () => {
  const r = await runCli(['run', '--preset', 'uk-motorsport']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--preset is not available yet: no presets are bundled/);
  assert.doesNotMatch(r.stderr, /could not read config/);
});

test('--help says the preset flag is not available yet', async () => {
  const r = await runCli(['--help']);
  assert.match(r.stdout, /--preset <name>\s+Not available yet/);
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
