import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import lever from '../src/adapters/lever.mjs';
import { getAdapter } from '../src/adapters/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, 'fixtures/lever.json'), 'utf8');

const site = { id: 'nordholt', company: 'Nordholt Racing', type: 'lever', board: 'nordholt' };
const stubHttp = (body, { ok = true, status = 200 } = {}) => {
  const calls = [];
  const http = async (url, opts) => { calls.push({ url, opts }); return { ok, status, text: body }; };
  http.calls = calls;
  return http;
};
const ctx = (http) => ({ http, logger: console, timeoutMs: 1000 });

test('registry resolves the lever adapter', () => {
  assert.equal(getAdapter('lever').id, 'lever');
});

test('lever requests the postings endpoint in json mode', async () => {
  const http = stubHttp(fixture);
  await lever.fetch(site, ctx(http));
  assert.equal(http.calls[0].url, 'https://api.lever.co/v0/postings/nordholt?mode=json');
});

test('lever maps postings to the normalised shape', async () => {
  const out = await lever.fetch(site, ctx(stubHttp(fixture)));
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'nordholt:b1e7c2a4-0000-4000-8000-000000000001');
  assert.equal(out[0].title, 'Powertrain Systems Engineer');
  assert.equal(out[0].company, 'Nordholt Racing');
  assert.equal(out[0].location, 'Bicester, UK');
  assert.equal(out[0].url, 'https://jobs.lever.co/nordholt/b1e7c2a4');
});

test('lever converts the epoch-millisecond createdAt to an ISO date', async () => {
  const out = await lever.fetch(site, ctx(stubHttp(fixture)));
  assert.equal(out[0].postedAt, '2026-08-17');
});

test('lever carries descriptionPlain through unchanged', async () => {
  const out = await lever.fetch(site, ctx(stubHttp(fixture)));
  assert.equal(out[0].description, 'Own the hybrid control strategy.\nRequires MATLAB.');
});

test('lever tolerates a posting with no categories', async () => {
  const body = JSON.stringify([{ id: 'x', text: 'Engineer', hostedUrl: 'https://jobs.lever.co/n/x' }]);
  const out = await lever.fetch(site, ctx(stubHttp(body)));
  assert.equal(out[0].location, '');
  assert.equal(out[0].postedAt, null);
});

test('lever throws on a non-200 response', async () => {
  await assert.rejects(
    () => lever.fetch(site, ctx(stubHttp('', { ok: false, status: 403 }))),
    /lever board 'nordholt' returned HTTP 403/
  );
});

test('lever throws when the body is not a JSON array', async () => {
  await assert.rejects(() => lever.fetch(site, ctx(stubHttp('{"jobs":[]}'))), /expected a JSON array/);
});

test('lever requires a board in site config', async () => {
  await assert.rejects(
    () => lever.fetch({ id: 'a', company: 'A', type: 'lever' }, ctx(stubHttp('[]'))),
    /site 'a' needs 'board'/
  );
});
