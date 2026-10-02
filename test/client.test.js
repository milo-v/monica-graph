import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, AuthError, NetworkError, mapLimit, loadAll } from '../monica.js';

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const noSleep = async () => {};

function client(fetchImpl, opts = {}) {
  return createClient({ baseUrl: 'https://monica.test/', token: 'tok', fetch: fetchImpl, sleep: noSleep, ...opts });
}

test('sends the personal access token as a Bearer header to {baseUrl}/api/{path}', async () => {
  let seen;
  const c = client(async (url, init) => { seen = { url, init }; return json({ data: [] }); });
  await c.get('/contacts');
  assert.equal(seen.url, 'https://monica.test/api/contacts');
  assert.equal(seen.init.headers.Authorization, 'Bearer tok');
});

test('401 and 403 raise AuthError', async () => {
  for (const status of [401, 403]) {
    const c = client(async () => json({}, status));
    await assert.rejects(c.get('/contacts'), AuthError);
  }
});

test('a thrown fetch (network or CORS failure) raises NetworkError', async () => {
  const c = client(async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(c.get('/contacts'), NetworkError);
});

test('429 is retried and then succeeds', async () => {
  let calls = 0;
  const c = client(async () => (++calls < 3 ? json({}, 429) : json({ data: 'ok' })));
  assert.deepEqual(await c.get('/x'), { data: 'ok' });
  assert.equal(calls, 3);
});

test('429 gives up after the retry limit', async () => {
  const c = client(async () => json({}, 429));
  await assert.rejects(c.get('/x'), /429/);
});

test('429 waits for the Retry-After seconds when the header is readable', async () => {
  const waits = [];
  let calls = 0;
  const c = client(
    async () => (++calls === 1
      ? { ok: false, status: 429, headers: { get: (h) => (h.toLowerCase() === 'retry-after' ? '7' : null) }, json: async () => ({}) }
      : json({ data: 'ok' })),
    { sleep: async (ms) => { waits.push(ms); } },
  );
  await c.get('/x');
  assert.deepEqual(waits, [7000]);
});

test('429 without a readable Retry-After waits long enough for a per-minute window to reset', async () => {
  const waits = [];
  const c = client(async () => json({}, 429), { sleep: async (ms) => { waits.push(ms); } });
  await assert.rejects(c.get('/x'), /429/);
  assert.ok(waits.reduce((a, b) => a + b, 0) >= 60000, `total wait was only ${waits.reduce((a, b) => a + b, 0)}ms`);
});

test('onRateLimit is told how long the client is waiting', async () => {
  const told = [];
  let calls = 0;
  const c = client(async () => (++calls === 1 ? json({}, 429) : json({ data: 'ok' })), { onRateLimit: (ms) => told.push(ms) });
  await c.get('/x');
  assert.equal(told.length, 1);
  assert.ok(told[0] > 0);
});

test('while one request is waiting out a 429, other requests do not hit the server', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let fetchCalls = 0;
  const c = client(async () => (++fetchCalls === 1 ? json({}, 429) : json({ data: 'ok' })), { sleep: () => gate });

  const a = c.get('/a');
  await new Promise((r) => setImmediate(r)); // a has now received its 429 and is waiting
  const b = c.get('/b');
  await new Promise((r) => setImmediate(r));
  assert.equal(fetchCalls, 1, 'b must wait for the rate-limit pause');

  release();
  await Promise.all([a, b]);
  assert.equal(fetchCalls, 3);
});

test('getAllPages follows meta.last_page and concatenates data', async () => {
  const urls = [];
  const c = client(async (url) => {
    urls.push(url);
    const page = Number(new URL(url).searchParams.get('page'));
    return json({ data: [`item${page}`], meta: { current_page: page, last_page: 3 } });
  });
  assert.deepEqual(await c.getAllPages('/contacts'), ['item1', 'item2', 'item3']);
  assert.match(urls[0], /limit=100/);
});

test('getAllPages falls back to a smaller limit when the server rejects limit=100 with 400', async () => {
  const c = client(async (url) => {
    const u = new URL(url);
    if (u.searchParams.get('limit') === '100') return json({ error: { error_code: 30 } }, 400);
    return json({ data: ['a'], meta: { current_page: 1, last_page: 1 } });
  });
  assert.deepEqual(await c.getAllPages('/contacts'), ['a']);
});

test('getAllPages omits limit as a last resort when the server rejects every explicit limit', async () => {
  const urls = [];
  const c = client(async (url) => {
    urls.push(url);
    const u = new URL(url);
    if (u.searchParams.has('limit')) return json({ error: { error_code: 30 } }, 400);
    return json({ data: ['a'], meta: { current_page: 1, last_page: 1 } });
  });
  assert.deepEqual(await c.getAllPages('/contacts'), ['a']);
  assert.equal(new URL(urls.at(-1)).searchParams.has('limit'), false);
});

test('mapLimit never runs more than n tasks at once and preserves order', async () => {
  let active = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
    active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return x * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
  assert.equal(peak, 3);
});

function monicaFake({ failFor = [] } = {}) {
  const contacts = [{ id: 1, complete_name: 'Me', is_me: true }, { id: 2, complete_name: 'Ann' }];
  return async (url) => {
    const { pathname } = new URL(url);
    if (pathname === '/api/relationshiptypegroups') return json({ data: [{ id: 3, name: 'friend' }], meta: { current_page: 1, last_page: 1 } });
    if (pathname === '/api/contacts') return json({ data: contacts, meta: { current_page: 1, last_page: 1 } });
    const m = pathname.match(/^\/api\/contacts\/(\d+)\/relationships$/);
    if (m) {
      if (failFor.includes(Number(m[1]))) return json({}, 500);
      if (m[1] === '1') return json({ data: [{ contact_is: contacts[0], of_contact: contacts[1], relationship_type: { name: 'friend', name_reverse_relationship: 'friend', relationship_type_group_id: 3 } }] });
      return json({ data: [] });
    }
    return json({}, 404);
  };
}

test('loadAll returns contacts, relationships and groups, reporting progress', async () => {
  const progress = [];
  const r = await loadAll(client(monicaFake()), { onProgress: (done, total) => progress.push([done, total]) });
  assert.equal(r.contacts.length, 2);
  assert.equal(r.relationships.length, 1);
  assert.equal(r.groups[0].name, 'friend');
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(progress.at(-1), [2, 2]);
});

test('loadAll skips a contact whose relationships fail and lists it in warnings', async () => {
  const r = await loadAll(client(monicaFake({ failFor: [2] })));
  assert.equal(r.relationships.length, 1);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /Ann/);
});

test('loadAll aborts on AuthError instead of treating it as a per-contact failure', async () => {
  const fake = monicaFake();
  const c = client(async (url, init) => (new URL(url).pathname.endsWith('/relationships') ? json({}, 401) : fake(url, init)));
  await assert.rejects(loadAll(c), AuthError);
});
