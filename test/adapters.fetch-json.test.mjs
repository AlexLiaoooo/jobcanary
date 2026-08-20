import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchJson, mapRows } from '../src/adapters/fetch-json.mjs';

const stubHttp = (body, { ok = true, status = 200 } = {}) => {
  const calls = [];
  const http = async (url, opts) => { calls.push({ url, opts }); return { ok, status, text: body }; };
  http.calls = calls;
  return http;
};
const collectingLogger = () => {
  const warnings = [];
  return { warnings, log() {}, warn(msg) { warnings.push(msg); }, error() {} };
};

test('fetchJson returns the parsed body when no shape is requested', async () => {
  const data = await fetchJson({ http: stubHttp('{"a":1}') }, 'https://example.test/x', {}, 'label');
  assert.deepEqual(data, { a: 1 });
});

test('fetchJson passes the url and request options straight through to ctx.http', async () => {
  const http = stubHttp('{}');
  await fetchJson({ http }, 'https://example.test/x', { method: 'POST', body: 'b' }, 'label');
  assert.equal(http.calls[0].url, 'https://example.test/x');
  assert.equal(http.calls[0].opts.method, 'POST');
  assert.equal(http.calls[0].opts.body, 'b');
});

test('fetchJson reports a non-2xx response with the label and status', async () => {
  await assert.rejects(
    () => fetchJson({ http: stubHttp('', { ok: false, status: 503 }) }, 'u', {}, "acme board 'x'"),
    /^Error: acme board 'x' returned HTTP 503$/
  );
});

test('fetchJson reports an unparseable body', async () => {
  await assert.rejects(
    () => fetchJson({ http: stubHttp('<html>nope</html>') }, 'u', {}, "acme board 'x'"),
    /^Error: acme board 'x' returned a body that is not valid JSON$/
  );
});

test('fetchJson with expect.array returns the array and rejects anything else', async () => {
  assert.deepEqual(await fetchJson({ http: stubHttp('[1,2]') }, 'u', {}, 'l', { array: true }), [1, 2]);
  await assert.rejects(
    () => fetchJson({ http: stubHttp('{"jobs":[]}') }, 'u', {}, "acme board 'x'", { array: true }),
    /acme board 'x': expected a JSON array of postings/
  );
});

test('fetchJson with expect.arrayAt returns the named array', async () => {
  const rows = await fetchJson({ http: stubHttp('{"jobs":[{"id":1}]}') }, 'u', {}, 'l', { arrayAt: 'jobs' });
  assert.deepEqual(rows, [{ id: 1 }]);
});

test('fetchJson with expect.arrayAt rejects a body missing that key', async () => {
  await assert.rejects(
    () => fetchJson({ http: stubHttp('{"results":[]}') }, 'u', {}, "acme board 'x'", { arrayAt: 'jobs' }),
    /acme board 'x': expected a JSON object with a 'jobs' array/
  );
});

test('fetchJson with expect.arrayAt rejects a null or scalar body', async () => {
  for (const body of ['null', '7', '"text"', '[]']) {
    await assert.rejects(
      () => fetchJson({ http: stubHttp(body) }, 'u', {}, 'l', { arrayAt: 'jobs' }),
      /expected a JSON object with a 'jobs' array/
    );
  }
});

test('mapRows maps every row when none throw', () => {
  const out = mapRows([1, 2, 3], { logger: collectingLogger() }, { id: 's1' }, (n) => n * 2);
  assert.deepEqual(out, [2, 4, 6]);
});

test('mapRows skips a throwing row, keeps the rest, and warns naming the site', () => {
  const logger = collectingLogger();
  const out = mapRows(['ok', 'bad', 'ok'], { logger }, { id: 'acme' }, (row) => {
    if (row === 'bad') throw new Error('missing a url');
    return row.toUpperCase();
  });
  assert.deepEqual(out, ['OK', 'OK']);
  assert.equal(logger.warnings.length, 1);
  assert.match(logger.warnings[0], /\[acme\]/);
  assert.match(logger.warnings[0], /index 1/);
  assert.match(logger.warnings[0], /missing a url/);
});

test('mapRows does not require a logger', () => {
  const out = mapRows([1, 2], {}, { id: 's1' }, (n) => {
    if (n === 1) throw new Error('nope');
    return n;
  });
  assert.deepEqual(out, [2]);
});
