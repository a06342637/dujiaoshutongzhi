import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { DujiaoAdapter, FetchError } from '../src/adapter.js';
import { defaults } from '../src/config.js';
import { rawProduct } from './fixtures.js';

const json = (data: unknown, status = 200, headers?: Record<string, string>) =>
  new Response(JSON.stringify(data), { status, headers });
const preflight = (url: string) =>
  url.includes('/config')
    ? json({ status_code: 0, data: { currency: 'CNY', site_name: '测试店' } })
    : url.includes('/categories')
      ? json({ status_code: 0, data: [] })
      : null;
test('adapter reads all pages with real HTTP without writing to website', async () => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url!);
    res.setHeader('content-type', 'application/json');
    const path = req.url!;
    let body: unknown;
    if (path.includes('/config'))
      body = { status_code: 0, data: { currency: 'USD', site_name: '本地测试' } };
    else if (path.includes('/categories')) body = { status_code: 0, data: [] };
    else {
      const page = Number(new URL(path, 'http://localhost').searchParams.get('page'));
      body = {
        status_code: 0,
        data:
          page === 1
            ? Array.from({ length: 100 }, (_, i) => rawProduct(8, i + 1))
            : [rawProduct(9, 101)],
        pagination: { total: 101 },
      };
    }
    res.end(JSON.stringify(body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as { port: number };
    const c = defaults();
    c.siteUrl = `http://127.0.0.1:${address.port}`;
    const result = await new DujiaoAdapter().scan(c);
    assert.equal(result.products.length, 101);
    assert.equal(result.pages, 2);
    assert.equal(result.currency, 'USD');
    assert.ok(requests.every((x) => x.startsWith('/api/v1/public/')));
  } finally {
    server.close();
    await once(server, 'close');
  }
});
test('adapter rejects inconsistent and duplicated pagination', async () => {
  const c = defaults();
  c.siteUrl = 'https://example.com';
  c.timing.retries = 0;
  let page = 0;
  const fake = (async (input: RequestInfo | URL) => {
    const url = String(input);
    return (
      preflight(url) ??
      json({
        status_code: 0,
        data: [rawProduct(8, 1)],
        pagination: { total: ++page === 1 ? 2 : 3 },
      })
    );
  }) as typeof fetch;
  await assert.rejects(new DujiaoAdapter(fake).scan(c), /总数变化/);
  const duplicate = (async (input: RequestInfo | URL) =>
    preflight(String(input)) ??
    json({
      status_code: 0,
      data: [rawProduct(), rawProduct()],
      pagination: { total: 2 },
    })) as typeof fetch;
  await assert.rejects(new DujiaoAdapter(duplicate).scan(c), /重复/);
});
test('adapter rejects a failed page rather than returning a partial catalog', async () => {
  const c = defaults();
  c.siteUrl = 'https://example.com';
  c.timing.retries = 0;
  const fake = (async (input: RequestInfo | URL) => {
    const url = String(input);
    return (
      preflight(url) ??
      (url.includes('page=2')
        ? json({}, 503)
        : json({ status_code: 0, data: [rawProduct()], pagination: { total: 2 } }))
    );
  }) as typeof fetch;
  await assert.rejects(new DujiaoAdapter(fake).scan(c), /503/);
});
test('Retry-After is respected and long waits return to scheduler', async () => {
  const c = defaults();
  c.siteUrl = 'https://example.com';
  const waits: number[] = [];
  let attempts = 0;
  const fake = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/products') && attempts++ === 0) return json({}, 429, { 'Retry-After': '3' });
    return preflight(url) ?? json({ status_code: 0, data: [], pagination: { total: 0 } });
  }) as typeof fetch;
  await new DujiaoAdapter(fake, async (ms) => {
    waits.push(ms);
  }).scan(c);
  assert.deepEqual(waits, [3000]);
  const blocked = (async () => json({}, 429, { 'Retry-After': '120' })) as typeof fetch;
  await assert.rejects(
    new DujiaoAdapter(blocked).scan(c),
    (e: unknown) => e instanceof FetchError && e.retryAfter === 120000,
  );
});
test('firewall HTML and malformed data are diagnosed', async () => {
  const c = defaults();
  c.siteUrl = 'https://example.com';
  c.timing.retries = 0;
  await assert.rejects(
    new DujiaoAdapter((async () => new Response('<html>challenge</html>')) as typeof fetch).scan(c),
    /未返回 JSON/,
  );
});
