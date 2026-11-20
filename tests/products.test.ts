import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { kvGet, kvSet, type Db } from '../src/db/index.ts';
import { startAdmin, setPassword } from '../src/admin/index.ts';
import { activeHandles, brandLogoFile, chooseBrief, listBriefs, ownerBrief, pickBrief, slugHandle, type OwnerProduct } from '../src/shopify/catalog.ts';
import { config, fresh, seedBrief } from './helpers.ts';

const PW = 'correct horse battery';
const NOW = new Date('2026-11-17T17:20:00Z');
const ROOT = path.resolve(import.meta.dirname, '..');
const LOGO = readFileSync(path.join(ROOT, 'config/brand/logo.png'));
let db: Db;
let server: Server;
let port: number;

type R = { status: number; headers: Record<string, string | string[] | undefined>; text: string };
function send(method: string, p: string, o: { cookie?: string; body?: Buffer | string; type?: string } = {}): Promise<R> {
  const headers: Record<string, string> = { host: `127.0.0.1:${port}` };
  if (method === 'POST') {
    headers.origin = `http://${headers.host}`;
    headers['content-type'] = o.type ?? 'application/x-www-form-urlencoded';
  }
  if (o.cookie) headers.cookie = o.cookie;
  if (o.body !== undefined) headers['content-length'] = String(Buffer.byteLength(o.body));
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text }));
    });
    r.on('error', reject);
    r.end(o.body);
  });
}
async function multipart(p: string, cookie: string, fd: FormData): Promise<R> {
  const r = new Request('http://x/', { method: 'POST', body: fd });
  return send('POST', p, { cookie, body: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type')! });
}
async function login(): Promise<{ cookie: string; csrf: string }> {
  const r = await send('POST', '/login', { body: new URLSearchParams({ username: 'admin', password: PW }).toString() });
  assert.equal(r.status, 303);
  const cookie = String(([] as string[]).concat(r.headers['set-cookie'] ?? [])[0]).split(';')[0];
  const page = await send('GET', '/products', { cookie });
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.text)![1];
  return { cookie, csrf };
}

const owner: OwnerProduct = { title: 'Cozy Heated Slippers', type: 'Slippers', price: 34.5, currency: 'CAD', url: '', colors: ['Grey'], facts: ['USB-powered heated slippers', 'Three heat settings'], disclosures: ['Power bank not included'], photos: [{ file: 'assets/own-cozy-heated-slippers/a.png', width: 400, height: 400 }] };

before(async () => {
  db = fresh();
  ({ server, port } = await startAdmin({ db, port: 0, host: '127.0.0.1', now: () => NOW }));
  await setPassword({ db, now: () => NOW, read: async () => PW });
});
after(() => {
  server.close();
  server.closeAllConnections();
});

test('an owner product becomes a brief whose facts are exactly the lines typed', () => {
  assert.equal(slugHandle('Cozy Heated Slippers!'), 'own-cozy-heated-slippers');
  const b = ownerBrief('own-cozy-heated-slippers', owner, { name: 'Giftwell', domain: 'x.myshopify.com', currency: 'CAD', shipsTo: ['CA'] });
  assert.equal(b.product.priceText, '$34.50');
  assert.deepEqual(b.facts.map((f) => f.text), ['Cozy Heated Slippers', 'Slippers', 'Price: $34.50 CAD', 'Color: Grey', 'USB-powered heated slippers', 'Three heat settings', 'Ships to: CA']);
  assert.deepEqual(b.disclosures, ['Power bank not included']);
  assert.deepEqual(b.angles, []);
  assert.deepEqual(b.rules, { discountClaims: false, reviewClaims: false });
  assert.equal(b.shots[0].file, 'assets/own-cozy-heated-slippers/a.png');
});

test('only ticked products take turns; a stale selection falls back to all', () => {
  const s = seedBrief(db);
  const o = ownerBrief('own-x', { ...owner, title: 'X' }, s.shop);
  db.prepare("INSERT INTO products (handle, title, raw_json, fetched_at) VALUES ('own-x','X','{}','t')").run();
  db.prepare("INSERT INTO briefs (handle, source_hash, json, built_at) VALUES ('own-x',?,?,'t')").run(o.sourceHash, JSON.stringify(o));
  assert.deepEqual([0, 1].map((n) => chooseBrief(listBriefs(db), activeHandles(db), [], 0, n)!.product.handle).sort(), ['own-x', s.product.handle].sort());
  kvSet(db, 'products_active', JSON.stringify(['own-x']));
  assert.deepEqual(activeHandles(db), ['own-x']);
  assert.deepEqual([0, 1, 2].map((n) => chooseBrief(listBriefs(db), activeHandles(db), [], 0, n)!.product.handle), ['own-x', 'own-x', 'own-x']);
  db.prepare("DELETE FROM kv WHERE key = 'products_active'").run();
  db.prepare("DELETE FROM briefs WHERE handle = 'own-x'").run();
  db.prepare("DELETE FROM products WHERE handle = 'own-x'").run();
});

test('products page: add, refuse claims, select, remove; photos are re-encoded PNGs', async () => {
  assert.equal((await send('GET', '/products')).status, 303);
  const { cookie, csrf } = await login();
  const fd = (extra: Record<string, string> = {}, photo: Buffer | null = LOGO) => {
    const f = new FormData();
    for (const [k, v] of Object.entries({ csrf, title: 'Cozy Heated Slippers', type: 'Slippers', price: '34.50', currency: 'CAD', url: '', colors: 'Grey, Pink', facts: 'USB-powered heated slippers\nThree heat settings', disclosures: 'Power bank not included', ack: '1', ...extra })) f.set(k, v);
    if (photo) f.append('photos', new File([new Uint8Array(photo)], 'p.png', { type: 'image/png' }));
    return f;
  };
  // Review and ranking words are refused, and so is a file that is not an image.
  const bad = await multipart('/products/save', cookie, fd({ facts: 'Best seller of 2026\nThree heat settings' }));
  assert.equal(bad.status, 422);
  assert.match(bad.text, /Remove reviews, ratings/);
  const notImage = await multipart('/products/save', cookie, fd({}, Buffer.from('#!/bin/sh\n' + 'echo this is not an image\n'.repeat(10))));
  assert.equal(notImage.status, 422);
  assert.match(notImage.text, /not a PNG or JPEG/);
  assert.equal((await multipart('/products/save', cookie, fd({ csrf: 'wrong' }))).status, 403);

  const ok = await multipart('/products/save', cookie, fd());
  assert.equal(ok.status, 303, ok.text);
  const row = db.prepare("SELECT json FROM owner_products WHERE handle = 'own-cozy-heated-slippers'").get() as { json: string };
  const saved = JSON.parse(row.json) as OwnerProduct;
  assert.match(saved.photos[0].file, /^assets\/own-cozy-heated-slippers\/[0-9a-f]{64}\.png$/);
  assert.ok(existsSync(path.join(process.env.DATA_DIR!, saved.photos[0].file)));
  const brief = JSON.parse((db.prepare("SELECT json FROM briefs WHERE handle = 'own-cozy-heated-slippers'").get() as { json: string }).json);
  assert.ok(brief.facts.some((f: { text: string }) => f.text === 'Three heat settings'));
  const photo = await send('GET', '/media/photo?handle=own-cozy-heated-slippers', { cookie });
  assert.equal(photo.status, 200);
  assert.equal(photo.headers['content-type'], 'image/png');
  assert.equal((await send('GET', '/media/photo?handle=../../etc', { cookie })).status, 404);

  // Enter in the select form must save, never remove: each remove is its own form, outside it, with the csrf token.
  const listPage = (await send('GET', '/products', { cookie })).text;
  const selectForm = /<form method="post" action="\/products\/select">[\s\S]*?<\/form>/.exec(listPage)![0];
  assert.doesNotMatch(selectForm, /formaction|\/products\/delete/);
  assert.deepEqual(selectForm.match(/<button[^>]*type="submit"(?! form=)[^>]*>[^<]*/g), ['<button class="primary" type="submit">Save choices']);
  const del = new RegExp(`<form id="(del-\\d+)" method="post" action="/products/delete"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="handle" value="own-cozy-heated-slippers"></form>`).exec(listPage);
  assert.ok(del, 'standalone remove form');
  assert.match(selectForm, new RegExp(`type="submit" form="${del[1]}">Yes, remove`));

  // Selecting nothing is refused; selecting one stores it.
  const sel = (handles: string[]) => send('POST', '/products/select', { cookie, body: new URLSearchParams([['csrf', csrf], ...handles.map((h) => ['sel', h])]).toString() });
  assert.equal((await sel([])).status, 422);
  assert.equal((await sel(['own-cozy-heated-slippers', 'not-a-product'])).status, 303);
  assert.deepEqual(activeHandles(db), ['own-cozy-heated-slippers']);

  // A Shopify product cannot be removed here; an owner product can, and leaves the selection.
  const sh = db.prepare("SELECT handle FROM briefs WHERE handle NOT LIKE 'own-%' LIMIT 1").get() as { handle: string };
  await send('POST', '/products/delete', { cookie, body: new URLSearchParams({ csrf, handle: sh.handle }).toString() });
  assert.ok(db.prepare('SELECT 1 FROM briefs WHERE handle = ?').get(sh.handle));
  assert.equal((await send('POST', '/products/delete', { cookie, body: new URLSearchParams({ csrf, handle: 'own-cozy-heated-slippers' }).toString() })).status, 303);
  assert.equal(db.prepare("SELECT 1 FROM briefs WHERE handle = 'own-cozy-heated-slippers'").get(), undefined);
  assert.deepEqual(activeHandles(db), []);
});

test('logo upload replaces the file logo for the video model, and reset goes back', async () => {
  const { cookie, csrf } = await login();
  const before = brandLogoFile(db, config, ROOT);
  assert.equal(before, path.join(ROOT, 'config/brand/logo.png'));
  const f = new FormData();
  f.set('csrf', csrf);
  f.append('file', new File([new Uint8Array(LOGO)], 'logo.png', { type: 'image/png' }));
  const r = await multipart('/brand/logo', cookie, f);
  assert.equal(r.status, 303, r.text);
  const key = kvGet(db, 'brand_logo')!;
  assert.match(key, /^brand\/logo-[0-9a-f]{64}\.png$/);
  assert.equal(brandLogoFile(db, config, ROOT), path.resolve(process.env.DATA_DIR!, key));
  // A stored key that points elsewhere is ignored.
  kvSet(db, 'brand_logo', '../../etc/passwd');
  assert.equal(brandLogoFile(db, config, ROOT), before);
  kvSet(db, 'brand_logo', key);
  assert.equal((await send('POST', '/brand/logo/reset', { cookie, body: new URLSearchParams({ csrf }).toString() })).status, 303);
  assert.equal(kvGet(db, 'brand_logo'), undefined);
  assert.equal(brandLogoFile(db, config, ROOT), before);
});

test('products page: choose products per daily post, preview matches pickBrief, sync with Shopify now', async () => {
  const { cookie, csrf } = await login();
  for (const h of ['pa', 'pb']) {
    const bb = { ...JSON.parse((db.prepare('SELECT json FROM briefs LIMIT 1').get() as { json: string }).json) };
    bb.product = { ...bb.product, handle: h, title: `Title ${h}` };
    db.prepare("INSERT OR REPLACE INTO products (handle, title, raw_json, fetched_at) VALUES (?, ?, '{}', 't')").run(h, bb.product.title);
    db.prepare("INSERT OR REPLACE INTO briefs (handle, source_hash, json, built_at) VALUES (?, 'h', ?, 't')").run(h, JSON.stringify(bb));
  }
  const page0 = await send('GET', '/products', { cookie });
  // One choice per product; the radios map onto products_active and slot_products.
  assert.match(page0.text, /name="use\.pa" value="1"/);
  assert.match(page0.text, /Post 2 · 19:45/);
  const body = new URLSearchParams([['csrf', csrf], ['use.pa', 'both'], ['use.pb', '2'], ['post2', 'nope']]).toString();
  assert.equal((await send('POST', '/products/select', { cookie, body })).status, 303);
  assert.deepEqual(JSON.parse(kvGet(db, 'slot_products')!), { 1: ['pa'], 2: ['pa', 'pb'] });
  assert.deepEqual(activeHandles(db), []); // no product on "Any post"; pickBrief then uses every product

  const page = await send('GET', '/products', { cookie });
  for (const idx of [1, 2]) {
    const m = new RegExp(`data-post="${idx}" data-date="(\\d{4}-\\d{2}-\\d{2})"><strong>Post ${idx} · \\d\\d:\\d\\d</strong> next on [^,]+, uses: <strong>([^<]+)</strong>`).exec(page.text);
    assert.ok(m, `preview for post ${idx}`);
    assert.equal(m[2].trim(), pickBrief(db, { local_date: m[1], idx, kind: 'planned' }).product.title);
  }
  assert.match(page.text, /Post 1 · 12:15<\/strong> next on [^,]+, uses: <strong>Title pa/);
  assert.match(page.text, /id="u-pa-both" type="radio" name="use\.pa" value="both" checked/);
  assert.match(page.text, /id="u-pb-2" type="radio" name="use\.pb" value="2" checked/);

  // "Any post" fills the pool; "Not used" is in neither list; nothing chosen at all is refused.
  const any = new URLSearchParams([['csrf', csrf], ['use.pa', 'any'], ['use.pb', 'none']]).toString();
  assert.equal((await send('POST', '/products/select', { cookie, body: any })).status, 303);
  assert.deepEqual(activeHandles(db), ['pa']);
  assert.deepEqual(JSON.parse(kvGet(db, 'slot_products')!), { 1: [], 2: [] });
  const none = new URLSearchParams([['csrf', csrf], ['use.pa', 'none'], ['use.pb', 'none']]).toString();
  assert.equal((await send('POST', '/products/select', { cookie, body: none })).status, 422);
  // Legacy fields: an empty pool is accepted when a post has a product.
  const postOnly = new URLSearchParams([['csrf', csrf], ['post1', 'pb']]).toString();
  assert.equal((await send('POST', '/products/select', { cookie, body: postOnly })).status, 303);
  assert.deepEqual(JSON.parse(kvGet(db, 'slot_products')!), { 1: ['pb'], 2: [] });

  // Get latest from Shopify only asks the factory: the admin has no Shopify credentials (D-32).
  const fetched: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => { fetched.push(String(url)); return real(url as string); }) as typeof fetch;
  try {
    const ok = await send('POST', '/products/sync', { cookie, body: new URLSearchParams({ csrf }).toString() });
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.location, '/products?msg=sync_requested');
  } finally {
    globalThis.fetch = real;
  }
  assert.deepEqual(fetched, []);
  assert.equal(kvGet(db, 'ingest_requested'), NOW.toISOString());
  // A second press within 60 s keeps the first request (the server clock is fixed at NOW).
  kvSet(db, 'ingest_requested', new Date(NOW.getTime() - 30_000).toISOString());
  const again = await send('POST', '/products/sync', { cookie, body: new URLSearchParams({ csrf }).toString() });
  assert.equal(again.headers.location, '/products?msg=sync_requested');
  assert.equal(kvGet(db, 'ingest_requested'), new Date(NOW.getTime() - 30_000).toISOString());
  kvSet(db, 'ingest_requested', NOW.toISOString());
  assert.equal((await send('POST', '/products/sync', { cookie, body: new URLSearchParams({ csrf: 'wrong' }).toString() })).status, 403);
  const req = await send('GET', '/products?msg=sync_requested', { cookie });
  assert.match(req.text, /Shopify check requested\./);
  assert.match(req.text, /Check pending…/);

  // The last result, a failure, a cut-short store; bad JSON is ignored.
  kvSet(db, 'shop_sync_result', JSON.stringify({ at: '2026-11-17T17:25:00.000Z', ok: true, added: 1, updated: 0, removed: 2 }));
  const after = await send('GET', '/products', { cookie });
  assert.match(after.text, /Last checked Tue 17 Nov, 12:25: 1 new, 0 updated, 2 gone\./);
  assert.doesNotMatch(after.text, /Check pending/);
  kvSet(db, 'shop_sync_result', JSON.stringify({ at: '2026-11-17T17:26:00.000Z', ok: false, error: 'HTTP 401 <x>' }));
  kvSet(db, 'shop_truncated', JSON.stringify({ at: 't', total: 300, kept: 250 }));
  const failed = await send('GET', '/products', { cookie });
  assert.match(failed.text, /Last check failed \(Tue 17 Nov, 12:26\): Shopify refused the app&#39;s key\./);
  assert.match(failed.text, /<details class="tech"><summary>Technical details<\/summary>HTTP 401 &lt;x&gt;<\/details>/);
  assert.match(failed.text, /Your store has 300 products; only the first 250 are used\./);
  kvSet(db, 'shop_sync_result', '{bad');
  assert.equal((await send('GET', '/products', { cookie })).status, 200);
});

test('plain words for a failed store read', async () => {
  const { plainSyncError } = await import('../src/admin/products.ts');
  assert.equal(plainSyncError('Error: ingest: HTTP 401 for https://x'), "Shopify refused the app's key. Check the Shopify app connection.");
  assert.equal(plainSyncError('admin api: 403 Forbidden'), "Shopify refused the app's key. Check the Shopify app connection.");
  for (const e of ['TypeError: fetch failed', 'Error: ingest deadline exceeded', 'AbortError: This operation was aborted', 'getaddrinfo ENOTFOUND x', 'request timeout']) {
    assert.equal(plainSyncError(e), 'Shopify could not be reached. It tries again within the hour.', e);
  }
  const empty = 'the store returned no products; the stored products were kept';
  assert.equal(plainSyncError(empty), empty);
  assert.equal(plainSyncError('SyntaxError: Unexpected token < in JSON'), 'Shopify could not be read.');
  assert.equal(plainSyncError(''), 'Shopify could not be read.');
});

test('"Any post" products are flagged when every post has its own product', async () => {
  const { cookie } = await login();
  const trap = /set to &quot;Any post&quot;, but every post already has its own product/;
  kvSet(db, 'products_active', JSON.stringify(['pa']));
  kvSet(db, 'slot_products', JSON.stringify({ 1: ['pb'], 2: ['pb'] }));
  const flagged = (await send('GET', '/products?msg=selected', { cookie })).text;
  assert.match(flagged, trap);
  assert.match(flagged, /Title pa is set to/);
  kvSet(db, 'slot_products', JSON.stringify({ 1: ['pb'], 2: [] }));
  assert.doesNotMatch((await send('GET', '/products', { cookie })).text, trap);
  kvSet(db, 'slot_products', JSON.stringify({ 1: ['pb'], 2: ['gone'] })); // a stale post list falls back to the pool
  assert.doesNotMatch((await send('GET', '/products', { cookie })).text, trap);
});

test('a Shopify product whose photos failed to download says why it has none', async () => {
  const { cookie } = await login();
  const bb = { ...JSON.parse((db.prepare("SELECT json FROM briefs WHERE handle = 'pa'").get() as { json: string }).json) };
  bb.product = { ...bb.product, handle: 'pc', title: 'Title pc' };
  bb.shots = bb.shots.map((s: { file: string }) => ({ ...s, file: 'assets/pc/missing.jpg' }));
  db.prepare("INSERT OR REPLACE INTO products (handle, title, raw_json, fetched_at) VALUES ('pc', 'Title pc', ?, 't')").run(JSON.stringify({ imagesSkipped: 2 }));
  db.prepare("INSERT OR REPLACE INTO briefs (handle, source_hash, json, built_at) VALUES ('pc', 'h', ?, 't')").run(JSON.stringify(bb));
  const why = /No photo\. Photos could not be downloaded from Shopify; they are tried again at the next check\./;
  assert.match((await send('GET', '/products', { cookie })).text, why);
  db.prepare("UPDATE products SET raw_json = '{}' WHERE handle = 'pc'").run();
  assert.doesNotMatch((await send('GET', '/products', { cookie })).text, why);
  db.prepare("UPDATE products SET raw_json = 'not json' WHERE handle = 'pc'").run();
  assert.equal((await send('GET', '/products', { cookie })).status, 200);
  db.prepare("DELETE FROM briefs WHERE handle = 'pc'").run();
  db.prepare("DELETE FROM products WHERE handle = 'pc'").run();
});

test('saving an owner product never deletes a photo it still uses', async () => {
  const { cookie, csrf } = await login();
  const form = (handle: string, photos: Buffer[], keep: string[] = []) => {
    const f = new FormData();
    for (const [k, v] of Object.entries({ csrf, handle, title: 'Photo Keeper', type: '', price: '10', currency: 'CAD', url: '', colors: '', facts: 'A plain test product', disclosures: '', ack: '1' })) f.set(k, v);
    for (const k of keep) f.append('keep', k);
    for (const p of photos) f.append('photos', new File([new Uint8Array(p)], 'p.png', { type: 'image/png' }));
    return f;
  };
  const h = 'own-photo-keeper';
  const photosOf = () => (JSON.parse((db.prepare('SELECT json FROM owner_products WHERE handle = ?').get(h) as { json: string }).json) as OwnerProduct).photos.map((p) => p.file);
  assert.equal((await multipart('/products/save', cookie, form('', [LOGO, LOGO]))).status, 303);
  const [a] = photosOf();
  assert.deepEqual(photosOf(), [a]); // the same picture twice is one photo
  const file = path.join(process.env.DATA_DIR!, a);
  // Case 1: Keep unticked, the same picture uploaded again.
  assert.equal((await multipart('/products/save', cookie, form(h, [LOGO]))).status, 303);
  assert.deepEqual(photosOf(), [a]);
  assert.ok(existsSync(file));
  // Case 2: kept, uploaded again, and a broken second file fails the save.
  const broken = Buffer.from('#!/bin/sh\n' + 'echo this is not an image\n'.repeat(10));
  assert.equal((await multipart('/products/save', cookie, form(h, [LOGO, broken], [a]))).status, 422);
  assert.ok(existsSync(file));
  assert.equal((await send('POST', '/products/delete', { cookie, body: new URLSearchParams({ csrf, handle: h }).toString() })).status, 303);
});

test('"Next posts" names the product already made for a slot', async () => {
  const { cookie } = await login();
  const page = await send('GET', '/products', { cookie });
  const date = /data-post="1" data-date="(\d{4}-\d{2}-\d{2})"/.exec(page.text)![1];
  const h = (db.prepare("SELECT handle FROM briefs WHERE handle NOT LIKE 'own-%' ORDER BY handle LIMIT 1").get() as { handle: string }).handle;
  const title = (db.prepare('SELECT title FROM products WHERE handle = ?').get(h) as { title: string }).title;
  db.prepare("INSERT INTO slots (id, local_date, idx, status, created_at, updated_at, kind, product_handle) VALUES (?, ?, 1, 'ready', 't', 't', 'planned', ?)").run(`${date}#1`, date, h);
  try {
    const after = await send('GET', '/products', { cookie });
    assert.match(after.text, new RegExp(`data-post="1" data-date="${date}"><strong>Post 1 · \\d\\d:\\d\\d</strong> next on [^,]+, uses: <strong>${title} \\(already made\\)</strong>`));
  } finally {
    db.prepare('DELETE FROM slots WHERE id = ?').run(`${date}#1`);
  }
});
