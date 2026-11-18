import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { kvGet, kvSet, type Db } from '../src/db/index.ts';
import { startAdmin, setPassword } from '../src/admin/index.ts';
import { SETTINGS_JS } from '../src/admin/server.ts';
import { activeHandles, brandLogoFile, ownerBrief, selectBriefs, slugHandle, type OwnerProduct } from '../src/shopify/catalog.ts';
import { pickBrief } from '../src/render/produce.ts';
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
  const a = { product: { handle: 'a' } };
  const b = { product: { handle: 'b' } };
  assert.deepEqual(selectBriefs([a, b], null), [a, b]);
  assert.deepEqual(selectBriefs([a, b], ['b']), [b]);
  assert.deepEqual(selectBriefs([a, b], ['gone']), [a, b]);
  const s = seedBrief(db);
  const o = ownerBrief('own-x', { ...owner, title: 'X' }, s.shop);
  db.prepare("INSERT INTO products (handle, title, raw_json, fetched_at) VALUES ('own-x','X','{}','t')").run();
  db.prepare("INSERT INTO briefs (handle, source_hash, json, built_at) VALUES ('own-x',?,?,'t')").run(o.sourceHash, JSON.stringify(o));
  assert.deepEqual([0, 1].map((n) => pickBrief(db, n).product.handle).sort(), ['own-x', s.product.handle].sort());
  kvSet(db, 'products_active', JSON.stringify(['own-x']));
  assert.deepEqual(activeHandles(db), ['own-x']);
  assert.deepEqual([0, 1, 2].map((n) => pickBrief(db, n).product.handle), ['own-x', 'own-x', 'own-x']);
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

test('the settings script never builds markup from strings and makes no requests', () => {
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(SETTINGS_JS));
  assert.ok(!/fetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource/.test(SETTINGS_JS));
});
