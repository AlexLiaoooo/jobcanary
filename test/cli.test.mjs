import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'bin', 'jobcanary.mjs');

function runCli(args, { cwd } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('--help exits 0 and lists the run command', () => {
  const r = runCli(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /jobcanary run/);
});

test('a missing config exits 2', () => {
  const r = runCli(['run', '--config', join(tmpdir(), 'does-not-exist.yaml')]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /could not read config/);
});

test('an invalid config exits 2 with a readable message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jc-'));
  const cfg = join(dir, 'config.yaml');
  writeFileSync(cfg, 'scoring: {provider: none}\n', 'utf8');
  const r = runCli(['run', '--config', cfg]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /needs a non-empty 'sites' list/);
});

test('an unknown adapter type exits 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jc-'));
  const cfg = join(dir, 'config.yaml');
  writeFileSync(cfg, 'sites:\n  - {id: a, company: A, type: nonesuch}\n', 'utf8');
  const r = runCli(['run', '--config', cfg]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown adapter type/);
});

test('--dry writes nothing but reports what it would do', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jc-'));
  const cfg = join(dir, 'config.yaml');
  writeFileSync(cfg, `
output: {dir: ./out}
sites:
  - {id: a, company: Acme, type: greenhouse, board: definitely-not-a-real-board-xyz}
`, 'utf8');
  const r = runCli(['run', '--config', cfg, '--dry']);
  // The board does not exist, so every site fails → exit 3, and nothing is written.
  assert.equal(r.code, 3);
  assert.deepEqual(readdirSync(dir).filter((f) => f === 'out'), []);
});

test('--preset says presets are not bundled yet rather than a missing-file error', () => {
  const r = runCli(['run', '--preset', 'uk-motorsport']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--preset is not available yet: no presets are bundled/);
  assert.doesNotMatch(r.stderr, /could not read config/);
});

test('--help says the preset flag is not available yet', () => {
  const r = runCli(['--help']);
  assert.match(r.stdout, /--preset <name>\s+Not available yet/);
});
