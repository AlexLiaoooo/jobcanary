import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { getAdapter } from '../src/adapters/index.mjs';

// Presets are checked by loading them, never by running them: a preset names
// live career sites, so running one crawls the internet. Loading proves what
// actually breaks — a preset that no longer parses, or that names an adapter
// this release does not have, is a file the user cannot use at all.
const presetDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'presets');
const presets = readdirSync(presetDir).filter((f) => f.endsWith('.yaml'));

test('at least one preset is bundled', () => {
  assert.ok(presets.length > 0, 'the --preset flag promises presets that exist');
});

for (const file of presets) {
  const name = file.replace(/\.yaml$/, '');
  const path = join(presetDir, file);

  test(`preset ${name} parses and validates`, () => {
    const config = loadConfig(path);
    assert.ok(config.sites.length > 0);
    assert.ok(config.rules.exclude.length > 0, 'a preset with no rules would report everything');
  });

  test(`preset ${name} only enables sites whose adapter exists`, () => {
    const orphans = loadConfig(path)
      .sites.filter((s) => s.enabled)
      .filter((s) => {
        try {
          getAdapter(s.type);
          return false;
        } catch {
          return true;
        }
      })
      .map((s) => `${s.id} (${s.type})`);
    // One enabled site naming a missing adapter fails the entire run with
    // "unknown adapter type" before a single board is fetched.
    assert.deepEqual(orphans, [], `enabled sites with no adapter: ${orphans.join(', ')}`);
  });

  test(`preset ${name} explains every site it ships disabled`, () => {
    // Shipping a site disabled is only worth doing if the reason travels with
    // it — otherwise it is indistinguishable from an oversight, and the point
    // of keeping it in the roster is that the gap stays visible.
    const lines = readFileSync(path, 'utf8').split('\n');
    const unexplained = lines.flatMap((line, i) =>
      line.trim() === 'enabled: false' && !(lines[i + 1] ?? '').trim().startsWith('#') ? [i + 1] : []
    );
    assert.deepEqual(unexplained, [], `enabled: false with no reason at line(s) ${unexplained.join(', ')}`);
  });

  test(`preset ${name} carries nothing personal`, () => {
    // The roster was ported from a private tool whose entries carried
    // application-history notes. Nothing personal may reach a published preset.
    const content = readFileSync(path, 'utf8');
    for (const word of ['Alex', 'Lingfeng', 'already applied', 'OneDrive']) {
      assert.ok(!content.includes(word), `preset mentions ${word}`);
    }
  });

  test(`preset ${name} gives every site an id, company and type`, () => {
    const bad = loadConfig(path)
      .sites.filter((s) => !s.id || !s.company || !s.type)
      .map((s) => s.id ?? '(no id)');
    assert.deepEqual(bad, []);
  });
}
