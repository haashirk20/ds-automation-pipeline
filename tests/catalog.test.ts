import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kvGet, kvSet, type Db } from '../src/db/index.ts';
import { alertStaleSelection, chooseBrief, pickBrief, slotProducts, staleSelections } from '../src/shopify/catalog.ts';
import { ensureIngest, INGEST_EVERY_MS, syncShop, type IngestDeps } from '../src/shopify/index.ts';
import { config, fresh, sampleBrief } from './helpers.ts';

const fx = (n: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/shopify', n), 'utf8'));
const metaJson = fx('meta.json');
const base = fx('products.json').products[0];
const NOW = new Date('2026-11-19T12:00:00Z');

function shop(db: Db, handles: () => string[] | 'fail', title: (h: string) => string = (h) => h) {
  process.env.SHOPIFY_SHOP = 'shop-example.myshopify.com';
  delete process.env.SHOPIFY_CLIENT_ID;
  delete process.env.SHOPIFY_CLIENT_SECRET;
  const f = (async (url: string | URL | Request) => {
    const u = String(url);
    const h = handles();
    if (h === 'fail') return new Response('', { status: 404 });
    if (u.endsWith('/meta.json')) return Response.json(metaJson);
    if (u.includes('/products.json')) return Response.json({ products: h.map((handle) => ({ ...base, handle, title: title(handle) })) });
    if (u.startsWith('https://cdn.shopify.com/')) return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } });
    return new Response('no', { status: 404 });
  }) as typeof fetch;
  const deps: IngestDeps = { fetch: f, sleep: async () => {}, tagsPath: join(mkdtempSync(join(tmpdir(), 'tags-')), 'none.json') };
  return (now = NOW) => syncShop(db, config, now, deps);
}

const stored = (db: Db) => (db.prepare('SELECT handle FROM briefs ORDER BY handle').all() as { handle: string }[]).map((r) => r.handle);

function addOwner(db: Db, handle: string) {
  db.prepare("INSERT INTO products (handle, title, raw_json, fetched_at) VALUES (?, 'x', '{}', 't')").run(handle);
  db.prepare("INSERT INTO briefs (handle, source_hash, json, built_at) VALUES (?, 'h', ?, 't')").run(handle, JSON.stringify({ ...sampleBrief, product: { ...sampleBrief.product, handle } }));
  db.prepare("INSERT INTO owner_products (handle, json, created_at, updated_at) VALUES (?, '{}', 't', 't')").run(handle);
}

test('sync removes Shopify products that left the store, never owner products, never on a failed or empty read', async () => {
  const db = fresh();
  let list: string[] | 'fail' = ['p-a', 'p-b'];
  const sync = shop(db, () => list);
  addOwner(db, 'own-x');
  const first = await sync();
  assert.deepEqual([first.added, first.updated, first.removed], [2, 0, []]);
  assert.deepEqual(stored(db), ['own-x', 'p-a', 'p-b']);
  assert.equal(kvGet(db, 'shop_synced_at'), NOW.toISOString());

  list = 'fail';
  await assert.rejects(sync());
  assert.deepEqual(stored(db), ['own-x', 'p-a', 'p-b']);

  list = [];
  const empty = await sync();
  assert.deepEqual(empty.removed, []);
  assert.deepEqual(stored(db), ['own-x', 'p-a', 'p-b']);

  list = ['p-a'];
  const r = await sync();
  assert.deepEqual(r.removed, ['p-b']);
  assert.deepEqual(stored(db), ['own-x', 'p-a']);
  assert.equal(db.prepare("SELECT 1 FROM products WHERE handle = 'p-b'").get(), undefined);
  assert.ok(db.prepare("SELECT 1 FROM owner_products WHERE handle = 'own-x'").get());
});

test('a slot already made keeps its product after the product leaves the store', async () => {
  const db = fresh();
  let list = ['p-a'];
  const sync = shop(db, () => list);
  await sync();
  db.prepare("INSERT INTO slots (id, local_date, idx, status, product_handle, master_json, created_at, updated_at) VALUES ('2026-11-19#1', '2026-11-19', 1, 'ready', 'p-a', '{}', 't', 't')").run();
  list = ['p-b'];
  await sync();
  assert.deepEqual(stored(db), ['p-b']);
  assert.deepEqual({ ...db.prepare("SELECT status, product_handle, master_json FROM slots").get() }, { status: 'ready', product_handle: 'p-a', master_json: '{}' });
  assert.equal(pickBrief(db, { local_date: '2026-11-20', idx: 1, kind: 'planned' }).product.handle, 'p-b');
});

test('ingest runs at most hourly; a failure alerts and waits an hour', async () => {
  const db = fresh();
  let calls = 0;
  let fail = false;
  const d = { ingest: async () => { calls++; if (fail) throw new Error('boom'); }, ingestDeadlineMs: 1000 };
  const at = (min: number) => new Date(NOW.getTime() + min * 60000);
  await ensureIngest(db, at(0), d);
  await ensureIngest(db, at(59), d);
  assert.equal(calls, 1);
  fail = true;
  await ensureIngest(db, at(60), d);
  assert.equal(calls, 2);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'ingest_failed'").get() as { n: number }).n, 1);
  await ensureIngest(db, at(100), d);
  assert.equal(calls, 2);
  fail = false;
  await ensureIngest(db, at(120), d);
  assert.equal(calls, 3);
  assert.equal(kvGet(db, 'ingest_at'), at(120).toISOString());
  assert.equal(INGEST_EVERY_MS, 3600_000);
});

const b = (handle: string) => ({ product: { handle } });
const hs = (xs: ({ product: { handle: string } } | undefined)[]) => xs.map((x) => x?.product.handle);

test('chooseBrief: per-post lists rotate by turn; empty or stale lists use the pool', () => {
  const all = [b('a'), b('b'), b('c')];
  assert.deepEqual(hs([0, 1, 2, 3].map((t) => chooseBrief(all, null, ['a', 'c'], t, 99))), ['a', 'c', 'a', 'c']);
  assert.deepEqual(hs([0, 1].map((t) => chooseBrief(all, null, ['b'], t, 0))), ['b', 'b']);
  assert.deepEqual(hs([0, 1, 2].map((o) => chooseBrief(all, ['b', 'c'], [], 7, o))), ['b', 'c', 'b']);
  assert.deepEqual(hs([0, 1].map((o) => chooseBrief(all, ['b', 'c'], ['gone'], 0, o))), ['b', 'c']);
  assert.deepEqual(hs([0, 1, 2].map((o) => chooseBrief(all, null, [], 0, o))), ['a', 'b', 'c']);
  assert.equal(chooseBrief([], null, ['a'], 0, 0), undefined);
  // No "Any post" products: an unchosen post uses the products chosen for other posts, never a "Not used" one.
  assert.deepEqual(hs([0, 1, 2].map((o) => chooseBrief(all, [], [], 0, o, ['b']))), ['b', 'b', 'b']);
  assert.deepEqual(hs([0, 1].map((o) => chooseBrief(all, [], [], 0, o, ['gone']))), ['a', 'b']);
});

test('pickBrief: each daily post uses its own products, day by day; manual slots and bad settings use the pool', async () => {
  const db = fresh();
  await shop(db, () => ['p-a', 'p-b', 'p-c'])();
  const slot = (d: string, idx: number, kind = 'planned') => ({ local_date: d, idx, kind });
  const days = ['2026-11-19', '2026-11-20', '2026-11-21'];
  const ins = db.prepare("INSERT INTO slots (id, local_date, idx, created_at, updated_at, kind) VALUES (?, ?, ?, 't', 't', ?)");
  for (const d of days) for (const i of [1, 2]) ins.run(`${d}#${i}`, d, i, 'planned');
  const run = (idx: number) => days.map((d) => pickBrief(db, slot(d, idx)).product.handle);

  // Both posts the same product.
  kvSet(db, 'slot_products', JSON.stringify({ 1: ['p-a'], 2: ['p-a'] }));
  assert.deepEqual([run(1), run(2)], [['p-a', 'p-a', 'p-a'], ['p-a', 'p-a', 'p-a']]);
  // Post 1 = A; post 2 takes turns between B and C, one day each.
  kvSet(db, 'slot_products', JSON.stringify({ 1: ['p-a'], 2: ['p-b', 'p-c'] }));
  assert.deepEqual([run(1), run(2)], [['p-a', 'p-a', 'p-a'], ['p-b', 'p-c', 'p-b']]);
  // Post 2 empty: the ticked pool by global ordinal (slots 1, 3, 5 of the line).
  kvSet(db, 'slot_products', JSON.stringify({ 1: ['p-a'] }));
  kvSet(db, 'products_active', JSON.stringify(['p-b', 'p-c']));
  assert.deepEqual(run(2), ['p-c', 'p-c', 'p-c']);
  // Every handle on a post gone: the pool.
  kvSet(db, 'slot_products', JSON.stringify({ 1: ['gone'] }));
  assert.deepEqual(run(1), ['p-b', 'p-b', 'p-b']);
  // A manual slot ignores the per-post list.
  kvSet(db, 'slot_products', JSON.stringify({ 101: ['p-a'], 1: ['p-a'] }));
  assert.equal(pickBrief(db, slot('2026-11-22', 101, 'manual')).product.handle, 'p-b');
  // Malformed settings are ignored.
  for (const v of ['not json', '[1]', '{"1": "p-a"}', '{"x": ["p-a"]}', '{"1": [3]}']) {
    kvSet(db, 'slot_products', v);
    assert.deepEqual(slotProducts(db), {});
  }
  assert.deepEqual(run(1), ['p-b', 'p-b', 'p-b']);
});

test('the scheduler tick reads the store hourly even when nothing is produced', async () => {
  const { tick } = await import('../src/scheduler/loop.ts');
  const { stubProducer } = await import('./helpers.ts');
  const db = fresh();
  let calls = 0;
  const deps = { db, config, publishers: {}, producer: stubProducer(db), ingest: async () => { calls++; } };
  await tick(deps, NOW);
  await tick(deps, new Date(NOW.getTime() + 60000));
  assert.equal(calls, 1);
  await tick(deps, new Date(NOW.getTime() + INGEST_EVERY_MS));
  assert.equal(calls, 2);
});

const events = (db: Db, kind: string) => (db.prepare('SELECT message FROM events WHERE kind = ?').all(kind) as { message: string }[]).map((r) => r.message);
const syncResult = (db: Db) => JSON.parse(kvGet(db, 'shop_sync_result') ?? 'null');

test('the tick does not wait for a slow store read, and never starts a second one meanwhile', async () => {
  const { tick } = await import('../src/scheduler/loop.ts');
  const { stubProducer } = await import('./helpers.ts');
  const db = fresh();
  let calls = 0;
  let finish!: () => void;
  const deps = { db, config, publishers: {}, producer: stubProducer(db), ingest: () => { calls++; return new Promise<void>((r) => (finish = r)); } };
  const slow = new Promise((_, rej) => setTimeout(() => rej(new Error('tick waited for the read')), 2000));
  await Promise.race([tick(deps, NOW), slow]);
  assert.equal(calls, 1);
  kvSet(db, 'ingest_requested', new Date(NOW.getTime() + 30_000).toISOString()); // due again, but one read is still running
  await Promise.race([tick(deps, new Date(NOW.getTime() + 60_000)), slow]);
  assert.equal(calls, 1);
  finish();
  await new Promise((r) => setImmediate(r));
  await tick(deps, new Date(NOW.getTime() + 120_000));
  assert.equal(calls, 2);
  finish();
  await new Promise((r) => setImmediate(r));
});

test('the deadline aborts the read: the fetch signal fires and nothing is stored', async () => {
  const db = fresh();
  process.env.SHOPIFY_SHOP = 'shop-example.myshopify.com';
  delete process.env.SHOPIFY_CLIENT_ID;
  delete process.env.SHOPIFY_CLIENT_SECRET;
  const signals: AbortSignal[] = [];
  const hang = ((_u: string, init: RequestInit = {}) => new Promise<Response>((_, rej) => {
    signals.push(init.signal!);
    init.signal!.addEventListener('abort', () => rej(init.signal!.reason));
  })) as typeof fetch;
  const deps: IngestDeps = { fetch: hang, sleep: async () => {}, tagsPath: '/nonexistent' };
  await ensureIngest(db, NOW, { ingest: (n, signal) => syncShop(db, config, n, { ...deps, signal }), ingestDeadlineMs: 50 });
  await new Promise((r) => setImmediate(r));
  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, true);
  assert.equal(events(db, 'ingest_failed').length, 1);
  assert.match(events(db, 'ingest_failed')[0], /deadline/);
  assert.deepEqual(stored(db), []);
  assert.equal(syncResult(db).ok, false);
});

test('ingest_requested from the admin makes the read due before the hour is up, once', async () => {
  const db = fresh();
  let calls = 0;
  const d = { ingest: async () => { calls++; }, ingestDeadlineMs: 1000 };
  const at = (min: number) => new Date(NOW.getTime() + min * 60000);
  await ensureIngest(db, at(0), d);
  await ensureIngest(db, at(5), d);
  assert.equal(calls, 1);
  kvSet(db, 'ingest_requested', at(4).toISOString());
  await ensureIngest(db, at(5), d);
  await ensureIngest(db, at(6), d);
  assert.equal(calls, 2);
});

test('shop_sync_result records every read; an empty read alerts and keeps the products', async () => {
  const db = fresh();
  let list: string[] | 'fail' = ['p-a', 'p-b'];
  const sync = shop(db, () => list);
  await sync();
  assert.deepEqual(syncResult(db), { at: NOW.toISOString(), ok: true, added: 2, updated: 0, removed: 0 });
  list = ['p-a'];
  await sync(new Date(NOW.getTime() + 1000));
  assert.deepEqual({ ...syncResult(db), at: 0 }, { at: 0, ok: true, added: 0, updated: 0, removed: 1 });
  list = 'fail';
  await assert.rejects(sync());
  assert.equal(syncResult(db).ok, false);
  assert.match(syncResult(db).error, /HTTP 404/);
  list = [];
  await sync();
  await sync();
  assert.equal(syncResult(db).ok, false);
  assert.deepEqual(stored(db), ['p-a']);
  assert.equal(events(db, 'shop_empty').length, 1); // rate-limited
});

test('more than MAX_PRODUCTS: removal uses the full handle list; shop_truncated is set, alerted and cleared', async () => {
  const db = fresh();
  const all = Array.from({ length: 25 }, (_, i) => `p-${String(i).padStart(2, '0')}`);
  let list = all;
  const sync = shop(db, () => list);
  await sync();
  assert.equal(stored(db).length, 20);
  assert.deepEqual({ ...JSON.parse(kvGet(db, 'shop_truncated')!) }, { at: NOW.toISOString(), total: 25, kept: 20 });
  assert.equal(events(db, 'shop_truncated').length, 1);
  list = all.filter((h) => h !== 'p-03');
  const r = await sync();
  assert.deepEqual(r.removed, ['p-03']);
  assert.equal(stored(db).length, 20); // p-20 moves up into the kept 20
  list = ['p-00', 'p-01'];
  await sync();
  assert.equal(kvGet(db, 'shop_truncated'), undefined);
  assert.deepEqual(stored(db), ['p-00', 'p-01']);
});

test('admin mode: a handle list with another page removes nothing', async () => {
  const db = fresh();
  await shop(db, () => ['p-a', 'p-b'])();
  process.env.SHOPIFY_CLIENT_ID = 'id';
  process.env.SHOPIFY_CLIENT_SECRET = 'secret';
  const gp = (handle: string) => ({ title: handle, handle, descriptionHtml: '<p>A lamp</p>', updatedAt: '2026-11-01T00:00:00Z', vendor: 'V', productType: 'T', tags: [], options: [], variants: { nodes: [{ title: 'Default', price: '10.00', compareAtPrice: null, availableForSale: true }] }, images: { nodes: [] } });
  let more = true;
  const f = (async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/oauth/access_token')) return Response.json({ access_token: 't' });
    if (String(init.body).includes('pageInfo')) return Response.json({ data: { products: { nodes: [{ handle: 'p-a' }], pageInfo: { hasNextPage: more } } } });
    return Response.json({ data: { shop: { name: 'S', currencyCode: 'CAD', primaryDomain: { host: 'x' }, shipsToCountries: [] }, products: { nodes: [gp('p-a')] } } });
  }) as typeof fetch;
  const deps: IngestDeps = { fetch: f, sleep: async () => {}, tagsPath: '/nonexistent' };
  try {
    assert.deepEqual((await syncShop(db, config, NOW, deps)).removed, []);
    assert.deepEqual(stored(db), ['p-a', 'p-b']);
    more = false;
    assert.deepEqual((await syncShop(db, config, NOW, deps)).removed, ['p-b']);
  } finally {
    delete process.env.SHOPIFY_CLIENT_ID;
    delete process.env.SHOPIFY_CLIENT_SECRET;
  }
});

test('a changed brief retires the hooks that cite a reworded or dropped fact', async () => {
  const db = fresh();
  let title = 'Lamp';
  const sync = shop(db, () => ['p-a'], () => title);
  await sync();
  const ins = db.prepare("INSERT INTO hooks (product_handle, framework, headline, say, fact_ids_json, created_at) VALUES ('p-a', 'f', ?, 's', ?, 't')");
  ins.run('title hook', JSON.stringify(['f-title']));
  ins.run('price hook', JSON.stringify(['f-price']));
  ins.run('gone hook', JSON.stringify(['f-nope']));
  ins.run('no facts', JSON.stringify([]));
  const status = () => Object.fromEntries((db.prepare('SELECT headline, status FROM hooks').all() as { headline: string; status: string }[]).map((r) => [r.headline, r.status]));
  await sync(); // unchanged brief: nothing retired
  assert.deepEqual(status(), { 'title hook': 'active', 'price hook': 'active', 'gone hook': 'active', 'no facts': 'active' });
  title = 'Lamp Deluxe';
  assert.equal((await sync()).updated, 1);
  assert.deepEqual(status(), { 'title hook': 'retired', 'price hook': 'active', 'gone hook': 'retired', 'no facts': 'active' });
});

test('staleSelections names each post list and the ticked products that match no stored brief; the producer alert is rate-limited', async () => {
  const db = fresh();
  await shop(db, () => ['p-a', 'p-b'])();
  kvSet(db, 'slot_products', JSON.stringify({ 1: ['gone'], 2: ['p-a', 'gone'], 3: [] }));
  kvSet(db, 'products_active', JSON.stringify(['old-1', 'old-2']));
  assert.deepEqual(staleSelections(db), [{ post: 1, handles: ['gone'] }, { post: null, handles: ['old-1', 'old-2'] }]);
  const slot = { id: '2026-11-20#1', local_date: '2026-11-20', idx: 1, kind: 'planned' };
  const picked = pickBrief(db, slot).product.handle;
  await alertStaleSelection(db, slot, picked, NOW);
  await alertStaleSelection(db, slot, picked, NOW);
  await alertStaleSelection(db, { ...slot, id: '2026-11-20#2', idx: 2 }, picked, NOW); // post 2 is fine; 'active' is already alerted
  const msgs = events(db, 'selection_stale');
  assert.equal(msgs.length, 2);
  assert.ok(msgs.some((m) => /daily post 1 names .*gone.*2026-11-20#1 uses p-/.test(m)));
  assert.ok(msgs.some((m) => /the ticked products .*old-1/.test(m)));
  kvSet(db, 'slot_products', JSON.stringify({ 1: ['p-b'] }));
  kvSet(db, 'products_active', JSON.stringify(['p-a']));
  assert.deepEqual(staleSelections(db), []);
});

test('a Shopify product with the owner-product prefix is skipped', async () => {
  const db = fresh();
  addOwner(db, 'own-x');
  const r = await shop(db, () => ['p-a', 'own-x'], (h) => `Shop ${h}`)();
  assert.deepEqual(r.briefs.map((b) => b.product.handle), ['p-a']);
  assert.equal(JSON.parse((db.prepare("SELECT raw_json FROM products WHERE handle = 'p-a'").get() as { raw_json: string }).raw_json).imagesSkipped, 0);
  assert.deepEqual(stored(db), ['own-x', 'p-a']);
  assert.equal(JSON.parse((db.prepare("SELECT json FROM briefs WHERE handle = 'own-x'").get() as { json: string }).json).product.title, sampleBrief.product.title);
  assert.ok(db.prepare("SELECT 1 FROM owner_products WHERE handle = 'own-x'").get());
});

test('an admin request still waits 60 s after the last attempt', async () => {
  const db = fresh();
  let calls = 0;
  const d = { ingest: async () => { calls++; }, ingestDeadlineMs: 1000 };
  const s = (sec: number) => new Date(NOW.getTime() + sec * 1000);
  await ensureIngest(db, s(0), d);
  kvSet(db, 'ingest_requested', s(10).toISOString());
  await ensureIngest(db, s(30), d);
  assert.equal(calls, 1);
  await ensureIngest(db, s(60), d);
  assert.equal(calls, 2);
});

test('the read is claimed atomically: a process holding a stale ingest_at loses', async () => {
  const db = fresh();
  let calls = 0;
  const d = { ingest: async () => { calls++; }, ingestDeadlineMs: 1000 };
  kvSet(db, 'ingest_at', NOW.toISOString());
  const later = new Date(NOW.getTime() + INGEST_EVERY_MS);
  // The other process claims between this one's read of ingest_at and its write: replay that by moving the
  // value after kvGet has run, through a one-shot wrapper on the first prepare of the claim.
  const prepare = db.prepare.bind(db);
  let raced = false;
  (db as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
    if (!raced && sql.startsWith('UPDATE kv SET value = ?')) { raced = true; kvSet(db, 'ingest_at', new Date(later.getTime() - 1).toISOString()); }
    return prepare(sql);
  }) as typeof db.prepare;
  await ensureIngest(db, later, d);
  assert.ok(raced);
  assert.equal(calls, 0);
  assert.equal(kvGet(db, 'ingest_at'), new Date(later.getTime() - 1).toISOString());
  // With no ingest_at yet, the first insert wins and a second one does nothing.
  const db2 = fresh();
  await ensureIngest(db2, NOW, d);
  assert.equal(calls, 1);
  assert.equal(db2.prepare("INSERT INTO kv (key, value) VALUES ('ingest_at', ?) ON CONFLICT(key) DO NOTHING").run('x').changes, 0);
});
