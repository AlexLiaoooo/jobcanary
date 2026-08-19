import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import greenhouse from '../src/adapters/greenhouse.mjs';
import { getAdapter, listAdapterTypes } from '../src/adapters/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, 'fixtures/greenhouse.json'), 'utf8');

const site = { id: 'acme', company: 'Acme Dynamics', type: 'greenhouse', board: 'acmedynamics' };
const stubHttp = (body, { ok = true, status = 200 } = {}) => {
  const calls = [];
  const http = async (url, opts) => { calls.push({ url, opts }); return { ok, status, text: body }; };
  http.calls = calls;
  return http;
};

test('registry resolves the greenhouse adapter by type', () => {
  assert.equal(getAdapter('greenhouse').id, 'greenhouse');
  assert.ok(listAdapterTypes().includes('greenhouse'));
});

test('registry throws a helpful error for an unknown type', () => {
  assert.throws(() => getAdapter('nonesuch'), /unknown adapter type 'nonesuch'/);
});

test('greenhouse declares it yields descriptions inline', () => {
  assert.equal(greenhouse.yieldsDescription, true);
  assert.equal(greenhouse.tier, 'http');
});

test('greenhouse requests the board endpoint with content=true', async () => {
  const http = stubHttp(fixture);
  await greenhouse.fetch(site, { http, logger: console, timeoutMs: 1000 });
  assert.equal(http.calls.length, 1);
  assert.equal(
    http.calls[0].url,
    'https://boards-api.greenhouse.io/v1/boards/acmedynamics/jobs?content=true'
  );
});

test('greenhouse maps postings to the normalised shape', async () => {
  const http = stubHttp(fixture);
  const out = await greenhouse.fetch(site, { http, logger: console, timeoutMs: 1000 });
  assert.equal(out.length, 2);
  assert.deepEqual(
    { id: out[0].id, title: out[0].title, company: out[0].company, location: out[0].location, url: out[0].url },
    {
      id: 'acme:4001', title: 'Graduate Design Engineer', company: 'Acme Dynamics',
      location: 'Oxford, UK', url: 'https://boards.greenhouse.io/acmedynamics/jobs/4001',
    }
  );
  assert.equal(out[0].postedAt, '2026-08-17');
});

test('greenhouse decodes the double-escaped content field to plain text', async () => {
  const http = stubHttp(fixture);
  const out = await greenhouse.fetch(site, { http, logger: console, timeoutMs: 1000 });
  assert.equal(out[0].description, 'Join our chassis team.\n• CAD\n• FEA');
});

test('greenhouse throws on a non-200 response', async () => {
  const http = stubHttp('', { ok: false, status: 404 });
  await assert.rejects(
    () => greenhouse.fetch(site, { http, logger: console, timeoutMs: 1000 }),
    /greenhouse board 'acmedynamics' returned HTTP 404/
  );
});

test('greenhouse throws on unparseable JSON', async () => {
  const http = stubHttp('<html>nope</html>');
  await assert.rejects(() => greenhouse.fetch(site, { http, logger: console, timeoutMs: 1000 }), /not valid JSON/);
});

test('greenhouse returns an empty array for a board with no jobs', async () => {
  const http = stubHttp(JSON.stringify({ jobs: [] }));
  const out = await greenhouse.fetch(site, { http, logger: console, timeoutMs: 1000 });
  assert.deepEqual(out, []);
});

test('greenhouse requires a board token in site config', async () => {
  await assert.rejects(
    () => greenhouse.fetch({ id: 'a', company: 'A', type: 'greenhouse' }, { http: stubHttp('{}'), logger: console, timeoutMs: 1 }),
    /site 'a' needs 'board'/
  );
});
