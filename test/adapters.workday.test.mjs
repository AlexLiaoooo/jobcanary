import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import workday from '../src/adapters/workday.mjs';
import { getAdapter } from '../src/adapters/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const listBody = readFileSync(join(here, 'fixtures/workday-list.json'), 'utf8');
const detailBody = readFileSync(join(here, 'fixtures/workday-detail.json'), 'utf8');

const site = {
  id: 'vantor', company: 'Vantor Propulsion', type: 'workday',
  host: 'https://vantor.wd3.myworkdayjobs.com', tenant: 'vantor', board: 'External',
};

// Serves the list fixture on the first call and an empty page on the second,
// so pagination terminates.
function listHttp() {
  const calls = [];
  let n = 0;
  const http = async (url, opts) => {
    calls.push({ url, opts });
    n += 1;
    return { ok: true, status: 200, text: n === 1 ? listBody : JSON.stringify({ jobPostings: [] }) };
  };
  http.calls = calls;
  return http;
}
const ctx = (http) => ({ http, logger: console, timeoutMs: 1000 });

test('registry resolves the workday adapter', () => {
  assert.equal(getAdapter('workday').id, 'workday');
});

test('workday declares that it does not yield descriptions inline', () => {
  assert.equal(workday.yieldsDescription, false);
});

test('workday POSTs to the CXS jobs endpoint', async () => {
  const http = listHttp();
  await workday.fetch(site, ctx(http));
  assert.equal(http.calls[0].url, 'https://vantor.wd3.myworkdayjobs.com/wday/cxs/vantor/External/jobs');
  assert.equal(http.calls[0].opts.method, 'POST');
  assert.deepEqual(JSON.parse(http.calls[0].opts.body), { appliedFacets: {}, limit: 20, offset: 0, searchText: '' });
});

test('workday maps postings, deriving the id from bulletFields', async () => {
  const out = await workday.fetch(site, ctx(listHttp()));
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'vantor:R-1001');
  assert.equal(out[0].title, 'Thermal Systems Engineer');
  assert.equal(out[0].location, 'Bicester, United Kingdom');
  assert.equal(
    out[0].url,
    'https://vantor.wd3.myworkdayjobs.com/en-US/External/job/Bicester/Thermal-Systems-Engineer_R-1001'
  );
});

test('workday falls back to the externalPath slug when bulletFields is absent', async () => {
  const body = JSON.stringify({
    jobPostings: [{ title: 'Engineer', externalPath: '/job/Site/Engineer_R-9', locationsText: '' }],
  });
  let n = 0;
  const http = async () => { n += 1; return { ok: true, status: 200, text: n === 1 ? body : '{"jobPostings":[]}' }; };
  const out = await workday.fetch(site, ctx(http));
  assert.equal(out[0].id, 'vantor:Engineer_R-9');
});

test('workday leaves description empty in the listing pass', async () => {
  const out = await workday.fetch(site, ctx(listHttp()));
  assert.equal(out[0].description, '');
});

test('workday stops paginating on a short page', async () => {
  const http = listHttp();
  await workday.fetch(site, ctx(http));
  assert.equal(http.calls.length, 1); // 2 postings < 20, so no second request
});

test('workday paginates while pages are full', async () => {
  const full = JSON.stringify({
    jobPostings: Array.from({ length: 20 }, (_, i) => ({
      title: `Role ${i}`, externalPath: `/job/S/Role-${i}_R-${i}`, locationsText: '', bulletFields: [`R-${i}`],
    })),
  });
  const calls = [];
  let n = 0;
  const http = async (url, opts) => {
    calls.push(JSON.parse(opts.body).offset);
    n += 1;
    return { ok: true, status: 200, text: n === 1 ? full : '{"jobPostings":[]}' };
  };
  await workday.fetch(site, ctx(http));
  assert.deepEqual(calls, [0, 20]);
});

test('workday throws when the first page fails', async () => {
  const http = async () => ({ ok: false, status: 500, text: '' });
  await assert.rejects(() => workday.fetch(site, ctx(http)), /workday tenant 'vantor' returned HTTP 500/);
});

test('workday requires host, tenant and board', async () => {
  await assert.rejects(
    () => workday.fetch({ id: 'a', company: 'A', type: 'workday' }, ctx(listHttp())),
    /site 'a' needs 'host', 'tenant' and 'board'/
  );
});

test('fetchDescription retrieves and cleans the detail description', async () => {
  const calls = [];
  const http = async (url) => { calls.push(url); return { ok: true, status: 200, text: detailBody }; };
  const posting = {
    id: 'vantor:R-1001',
    url: 'https://vantor.wd3.myworkdayjobs.com/en-US/External/job/Bicester/Thermal-Systems-Engineer_R-1001',
  };
  const text = await workday.fetchDescription(posting, site, ctx(http));
  assert.equal(
    calls[0],
    'https://vantor.wd3.myworkdayjobs.com/wday/cxs/vantor/External/job/Bicester/Thermal-Systems-Engineer_R-1001'
  );
  assert.equal(text, 'Own thermal management for the hybrid system.\n• GT-SUITE\n• 1D modelling');
});

test('fetchDescription returns an empty string rather than throwing on failure', async () => {
  const http = async () => ({ ok: false, status: 404, text: '' });
  const posting = { id: 'vantor:R-1', url: 'https://vantor.wd3.myworkdayjobs.com/en-US/External/job/S/X_R-1' };
  assert.equal(await workday.fetchDescription(posting, site, ctx(http)), '');
});
