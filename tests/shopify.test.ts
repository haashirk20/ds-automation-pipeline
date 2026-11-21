import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/index.ts';
import { env, normalizeShop, parseConfig } from '../src/config/index.ts';
import raw from '../config/pipeline.config.ts';
import { Brief } from '../src/contracts.ts';
import { buildBrief, descriptionLines, normalize, priceText } from '../src/shopify/brief.ts';
import { getWithRetry, type ShopMeta, type RawProduct } from '../src/shopify/fetch.ts';
import { ingest, listBriefs, type IngestDeps } from '../src/shopify/index.ts';

const config = parseConfig(raw);
const fx = (n: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/shopify', n), 'utf8'));
const metaJson = fx('meta.json');
const productsJson = fx('products.json');
const SHOP = 'shop-example.myshopify.com';
const NOW = new Date('2026-11-12T12:00:00Z');
const meta: ShopMeta = { name: metaJson.name, currency: 'CAD', domain: metaJson.domain, ships_to_countries: ['CA'] };

function setup(products: unknown = productsJson) {
  const dir = mkdtempSync(join(tmpdir(), 'shop-'));
  process.env.DATA_DIR = join(dir, 'data');
  process.env.SHOPIFY_SHOP = SHOP;
  const tagsPath = join(dir, 'photo-tags.json');
  const calls: string[] = [];
  const f = (async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith('/meta.json')) return Response.json(metaJson);
    if (u.includes('/products.json')) return Response.json(products);
    if (u.startsWith('https://cdn.shopify.com/')) return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } });
    return new Response('no', { status: 404 });
  }) as typeof fetch;
  const deps: IngestDeps = { fetch: f, sleep: async () => {}, tagsPath };
  return { db: openDb(process.env.DATA_DIR), deps, calls, tagsPath, dir };
}

const rawProduct = (over: Partial<RawProduct> = {}): RawProduct => ({ ...productsJson.products[0], ...over });
const brief = (over: Partial<RawProduct> = {}, m = meta, tags: string | null = null) => buildBrief(normalize(rawProduct(over), SHOP), m, config, tags);

test('normalizes the fixture product', () => {
  const p = normalize(rawProduct(), SHOP);
  assert.equal(p.url, `https://${SHOP}/products/${p.handle}`);
  assert.equal(p.images.length, 10);
  assert.match(p.images[0].basename, /^[0-9a-f-]+\.jpg$/);
  assert.equal(p.variants[0].price, 49.99);
  assert.ok(p.options.some((o) => o.name === 'Color'));
});

test('description lines: breaks, entities, label drop', () => {
  assert.deepEqual(descriptionLines('<p><b>Product information:</b> <br>A &amp; B&nbsp;&#39;x&#39; &#65;<br></p><p>Packing list: </p><p>Blanket*1pc</p>'), ["A & B 'x' A", 'Blanket*1pc']);
});

test('disclosure, angles, colors, facts, rules', () => {
  const b = brief();
  assert.deepEqual(b.disclosures, ['Power bank not included.']);
  assert.ok(b.facts.some((f) => f.text === 'Power bank not included.'));
  assert.ok(!b.angles.includes('bestseller'));
  assert.deepEqual(b.angles, ['gift', 'new', 'winter']);
  assert.deepEqual(b.product.colors, ['Beige', 'Green', 'Red']);
  assert.equal(b.product.priceText, '$49.99');
  assert.ok(b.facts.some((f) => f.id === 'f-price' && f.text === 'Price: $49.99 CAD'));
  assert.ok(b.facts.some((f) => f.id === 'f-option-color' && f.text === 'Color: Beige, Green, Red'));
  assert.ok(b.facts.some((f) => f.id === 'f-ships' && f.text === 'Ships to: CA'));
  assert.deepEqual(b.rules, { discountClaims: false, reviewClaims: false });
  Brief.parse(b);
});

test('price text: equal, differing, EUR; discount rule', () => {
  const v = (price: string, cmp: string | null) => ({ title: 't', price, compare_at_price: cmp, available: true });
  assert.equal(brief({ variants: [v('10', null), v('10.00', null)] }).product.priceText, '$10.00');
  assert.equal(brief({ variants: [v('12', null), v('9.5', null)] }).product.priceText, 'from $9.50');
  assert.equal(brief({ variants: [v('5', null)] }, { ...meta, currency: 'EUR' }).product.priceText, '€5.00');
  assert.equal(brief({ variants: [v('5', null)] }, { ...meta, currency: 'CHF' }).product.priceText, 'CHF 5.00');
  assert.equal(brief({ variants: [v('5', '8')] }).rules.discountClaims, true);
  assert.equal(brief({ variants: [v('5', '5')] }).rules.discountClaims, false);
});

test('photo tags: applied, empty removes, untagged default, duplicate fails', () => {
  const p = normalize(rawProduct(), SHOP);
  const [a, b, c] = p.images.map((i) => i.basename);
  const tags = JSON.stringify({
    _about: 'x',
    [a]: { shots: [{ id: 'one', kind: 'lifestyle', variant: 'Beige', crop: { x: 0, y: 0, w: 0.5, h: 0.5 }, note: 'n' }] },
    [b]: { shots: [] },
  });
  const br = buildBrief(p, meta, config, tags);
  assert.equal(br.shots.length, 1 + 8);
  assert.deepEqual(br.shots[0], { id: 'one', file: `assets/${p.handle}/${a}`, width: p.images[0].width, height: p.images[0].height, kind: 'lifestyle', variant: 'Beige', crop: { x: 0, y: 0, w: 0.5, h: 0.5 }, note: 'n' });
  assert.ok(!br.shots.some((s) => s.file.endsWith(b)));
  assert.equal(br.shots[1].id, 'photo-2');
  assert.equal(br.shots[1].file, `assets/${p.handle}/${c}`);
  const dup = JSON.stringify({ [a]: { shots: [{ id: 'photo-2', kind: 'product', variant: null, crop: null, note: '' }] } });
  assert.throws(() => buildBrief(p, meta, config, dup), /duplicate shot id/);
  assert.throws(() => buildBrief(p, meta, config, JSON.stringify({ [a]: { shots: [{ id: 1 }] } })));
});

test('variant photos tag untagged product photos with their colour; photo-tags.json wins; size suffix and query ignored', () => {
  // The fixture is a real public feed: Beige, Green and Red each have a featured_image that is one of the product photos.
  const raw = rawProduct();
  const key = (u: string) => u.split('?')[0].split('/').pop()!;
  const byColour = Object.fromEntries(raw.variants.map((v) => [v.option1, key(v.featured_image!.src)]));
  const br = buildBrief(normalize(raw, SHOP), meta, config, null);
  for (const c of ['Beige', 'Green', 'Red']) assert.equal(br.shots.find((s) => s.file.endsWith('/' + byColour[c]))?.variant, c, c);
  assert.ok(br.shots.some((s) => s.variant === null)); // photos no variant points at stay untagged
  // A tag in photo-tags.json overrides the variant photo.
  const tags = JSON.stringify({ [byColour.Green]: { shots: [{ id: 'g', kind: 'lifestyle', variant: 'Red', crop: null, note: '' }] } });
  assert.equal(buildBrief(normalize(raw, SHOP), meta, config, tags).shots.find((s) => s.id === 'g')?.variant, 'Red');
  // A variant image URL with a size suffix still matches.
  const sized = { ...raw, variants: raw.variants.map((v) => ({ ...v, featured_image: { src: v.featured_image!.src.replace(/\.jpg/, '_800x800.jpg') } })) };
  assert.equal(buildBrief(normalize(sized, SHOP), meta, config, null).shots.find((s) => s.file.endsWith('/' + byColour.Red))?.variant, 'Red');
});

test('ingest stores a valid brief and downloads photos', async () => {
  const { db, deps, calls } = setup();
  const [b] = await ingest(db, config, NOW, deps);
  Brief.parse(b);
  assert.deepEqual(listBriefs(db), [b]);
  assert.equal(listBriefs(db).length, 1);
  for (const s of b.shots) assert.ok(existsSync(join(process.env.DATA_DIR!, s.file)));
  assert.equal(calls.filter((u) => u.startsWith('https://cdn.')).length, 10);
});

test('existing files are not downloaded again', async () => {
  const { db, deps, calls } = setup();
  const p = productsJson.products[0];
  const dir = join(process.env.DATA_DIR!, 'assets', p.handle);
  mkdirSync(dir, { recursive: true });
  const first = normalize(rawProduct(), SHOP).images[0].basename;
  writeFileSync(join(dir, first), 'x');
  await ingest(db, config, NOW, deps);
  assert.equal(calls.filter((u) => u.startsWith('https://cdn.')).length, 9);
  assert.equal(readFileSync(join(dir, first), 'utf8'), 'x');
});

test('unsafe basenames and non-CDN urls are skipped', async () => {
  const cdn = 'https://cdn.shopify.com/s/files/';
  const img = (src: string) => ({ src, width: 10, height: 10 });
  const prod = { ...productsJson.products[0], images: [img(cdn + 'ok.jpg?v=1'), img(cdn + 'a%20b.jpg'), img(cdn + '..'), img('https://evil.example/x.jpg'), img('http://cdn.shopify.com/x.jpg'), img(cdn + 'x/..%2F..%2Fy.jpg')] };
  const { db, deps, calls } = setup({ products: [prod] });
  const [b] = await ingest(db, config, NOW, deps);
  assert.deepEqual(b.shots.map((s) => s.file), [`assets/${prod.handle}/ok.jpg`]);
  assert.equal(calls.filter((u) => !u.includes('/products.json') && !u.endsWith('meta.json')).length, 1);
});

test('non-image and oversize responses are rejected', async () => {
  const { db, deps } = setup();
  const inner = deps.fetch;
  deps.fetch = (async (url: string) => (String(url).startsWith('https://cdn.') ? new Response('<html>', { headers: { 'content-type': 'text/html' } }) : inner(url))) as typeof fetch;
  const [b] = await ingest(db, config, NOW, deps);
  assert.equal(b.shots.length, 0);
  deps.fetch = (async (url: string) => (String(url).startsWith('https://cdn.') ? new Response('x', { headers: { 'content-type': 'image/png', 'content-length': String(26 * 1024 * 1024) } }) : inner(url))) as typeof fetch;
  assert.equal((await ingest(db, config, NOW, deps))[0].shots.length, 0);
});

test('retry honours Retry-After, backs off, gives up after 4 tries', async () => {
  const waits: number[] = [];
  const sleep = async (ms: number) => void waits.push(ms);
  let n = 0;
  const f = (async () => (++n === 1 ? new Response('', { status: 429, headers: { 'retry-after': '7' } }) : n === 2 ? new Response('', { status: 503 }) : n === 3 ? new Response('', { status: 429, headers: { 'retry-after': '500' } }) : new Response('ok'))) as typeof fetch;
  assert.equal(await (await getWithRetry('https://x/', f, sleep)).text(), 'ok');
  assert.deepEqual(waits, [7000, 15000, 90000]);
  waits.length = 0;
  n = -10;
  const bad = (async () => { n++; return new Response('', { status: 429 }); }) as typeof fetch;
  await assert.rejects(getWithRetry('https://x/', bad, sleep), /429 after 4 tries/);
  assert.equal(n, -6);
  assert.deepEqual(waits, [5000, 15000, 45000]);
});

test('ingest fails when the fetch fails or the shop is unset', async () => {
  const { db, deps } = setup();
  deps.fetch = (async () => new Response('', { status: 500 })) as typeof fetch;
  await assert.rejects(ingest(db, config, NOW, deps), /HTTP 500/);
  delete process.env.SHOPIFY_SHOP;
  await assert.rejects(ingest(db, config, NOW, deps), /SHOPIFY_SHOP/);
});

test('brief is rewritten only when its source changed', async () => {
  const { db, deps, tagsPath } = setup();
  await ingest(db, config, NOW, deps);
  const built = () => (db.prepare('SELECT built_at FROM briefs').get() as { built_at: string }).built_at;
  assert.equal(built(), NOW.toISOString());
  await ingest(db, config, new Date('2026-11-13T00:00:00Z'), deps);
  assert.equal(built(), NOW.toISOString());
  writeFileSync(tagsPath, JSON.stringify({ 'nope.jpg': { shots: [] } }));
  await ingest(db, config, new Date('2026-11-14T00:00:00Z'), deps);
  assert.equal(built(), '2026-11-14T00:00:00.000Z');
});

test('malformed photo-tags file fails loudly', async () => {
  const { db, deps, tagsPath } = setup();
  writeFileSync(tagsPath, '{"a.jpg": {"shots": "no"}}');
  await assert.rejects(ingest(db, config, NOW, deps));
});

test('priceText helper uses lowest price', () => {
  assert.equal(priceText(normalize(rawProduct(), SHOP), 'USD'), '$49.99');
});

test('a body over the byte limit leaves no partial file, even without content-length', async () => {
  const { db, deps } = setup();
  const inner = deps.fetch;
  deps.maxImageBytes = 50;
  deps.fetch = (async (url: string) => (String(url).startsWith('https://cdn.') ? new Response(new Uint8Array(500), { headers: { 'content-type': 'image/jpeg' } }) : inner(url))) as typeof fetch;
  const [b] = await ingest(db, config, NOW, deps);
  assert.equal(b.shots.length, 0);
  const dir = join(process.env.DATA_DIR!, 'assets', productsJson.products[0].handle);
  assert.deepEqual(existsSync(dir) ? readdirSync(dir) : [], []);
});

test('limits: 20 products, 20 photos each, 40 description lines of 300 characters', async () => {
  const cdn = 'https://cdn.shopify.com/s/files/';
  const lines = Array.from({ length: 50 }, (_, i) => `<p>Line ${i}</p>`).join('') + `<p>${'x'.repeat(301)}</p>`;
  const prod = (i: number) => ({ ...productsJson.products[0], handle: `p${i}`, body_html: lines, images: Array.from({ length: 25 }, (_, k) => ({ src: `${cdn}p${i}-${k}.jpg`, width: 10, height: 10 })) });
  const { db, deps, calls } = setup({ products: Array.from({ length: 25 }, (_, i) => prod(i)) });
  const briefs = await ingest(db, config, NOW, deps);
  assert.equal(briefs.length, 20);
  assert.equal(briefs[0].shots.length, 20);
  assert.equal(briefs[0].facts.filter((f) => f.id.startsWith('f-desc-')).length, 40);
  assert.equal(calls.filter((u) => u.startsWith('https://cdn.')).length, 20 * 20);
});

test('SHOPIFY_SHOP: full URL, bare host and bare label normalize; hostile values are rejected', () => {
  for (const v of ['https://Name.myshopify.com/', 'name.myshopify.com', 'http://name.myshopify.com/admin?x=1#y', 'name']) assert.equal(normalizeShop(v), 'name.myshopify.com', v);
  assert.equal(normalizeShop(''), undefined);
  for (const v of ['evil.com', 'https://evil.com/.myshopify.com', 'name.myshopify.com@evil.com', 'evil.com#.myshopify.com', 'a.myshopify.com:8080', 'x.myshopify.com.evil.com', '-a.myshopify.com', 'a b.myshopify.com']) {
    assert.throws(() => normalizeShop(v), /myshopify\.com host/, v);
  }
  process.env.SHOPIFY_SHOP = 'https://name.myshopify.com/';
  assert.equal(env.shop(), 'name.myshopify.com');
});

const SECRET = 'shpss_client_secret_value';
const TOKEN = 'shpat_access_token_value';
const gqlProduct = {
  title: 'Lamp', handle: 'lamp', descriptionHtml: '<p>A lamp</p>', updatedAt: '2026-11-01T00:00:00Z', vendor: 'V', productType: 'Lighting', tags: ['a'],
  options: [{ name: 'Color', values: ['Red'] }],
  variants: { nodes: [{ title: 'Red', price: '10.00', compareAtPrice: null, availableForSale: true, selectedOptions: [{ value: 'Red' }], media: { nodes: [{ image: { url: 'https://cdn.shopify.com/s/files/a.jpg?v=2' } }] } }] },
  images: { nodes: [{ url: 'https://cdn.shopify.com/s/files/a.jpg', width: 100, height: 200 }, { url: 'https://cdn.shopify.com/s/files/b.jpg', width: null, height: null }] },
};

function adminSetup(admin: (u: string, init: RequestInit) => Response) {
  const s = setup();
  process.env.SHOPIFY_CLIENT_ID = 'client-id-1';
  process.env.SHOPIFY_CLIENT_SECRET = SECRET;
  const reqs: { url: string; init: RequestInit }[] = [];
  const pub = s.deps.fetch;
  s.deps.fetch = (async (url: string, init: RequestInit = {}) => {
    if (String(url).includes('/admin/')) { reqs.push({ url: String(url), init }); return admin(String(url), init); }
    return pub(url, init);
  }) as typeof fetch;
  return { ...s, reqs };
}
const adminOk = (u: string, init: RequestInit) => u.endsWith('/oauth/access_token')
  ? Response.json({ access_token: TOKEN, expires_in: 86399 })
  : String(init.body).includes('pageInfo') ? Response.json({ data: { products: { nodes: [{ handle: 'lamp' }], pageInfo: { hasNextPage: false } } } })
  : Response.json({ data: { shop: { name: 'Merry Marts', currencyCode: 'CAD', primaryDomain: { host: 'x.myshopify.com' }, shipsToCountries: ['CA'] }, products: { nodes: [gqlProduct] } } });

async function captureStderr<T>(fn: () => Promise<T>): Promise<{ out: T; err: string }> {
  const orig = process.stderr.write;
  let err = '';
  process.stderr.write = ((c: string | Uint8Array) => { err += String(c); return true; }) as typeof process.stderr.write;
  try { return { out: await fn(), err }; } finally { process.stderr.write = orig; }
}

test('admin mode: token request, GraphQL mapping to RawProduct, no secret in logs', async () => {
  const { db, deps, reqs } = adminSetup(adminOk);
  const { fetchShopAdmin } = await import('../src/shopify/admin.ts');
  const r = await fetchShopAdmin(SHOP, 'client-id-1', SECRET, deps.fetch);
  assert.equal(reqs[0].url, `https://${SHOP}/admin/oauth/access_token`);
  assert.equal(reqs[0].init.method, 'POST');
  const form = new URLSearchParams(String(reqs[0].init.body));
  assert.deepEqual([...form.keys()].sort(), ['client_id', 'client_secret', 'grant_type']);
  assert.equal(form.get('grant_type'), 'client_credentials');
  assert.equal(reqs[1].url, `https://${SHOP}/admin/api/2026-10/graphql.json`);
  assert.equal((reqs[1].init.headers as Record<string, string>)['x-shopify-access-token'], TOKEN);
  assert.match(String(reqs[1].init.body), /status:active/);
  assert.deepEqual(r.meta, { name: 'Merry Marts', currency: 'CAD', domain: 'x.myshopify.com', ships_to_countries: ['CA'] });
  assert.deepEqual(r.products[0], {
    title: 'Lamp', handle: 'lamp', body_html: '<p>A lamp</p>', updated_at: '2026-11-01T00:00:00Z', vendor: 'V', product_type: 'Lighting', tags: ['a'],
    options: [{ name: 'Color', values: ['Red'] }],
    variants: [{ title: 'Red', price: '10.00', compare_at_price: null, available: true, option1: 'Red', option2: null, option3: null, featured_image: { src: 'https://cdn.shopify.com/s/files/a.jpg?v=2' } }],
    images: [{ src: 'https://cdn.shopify.com/s/files/a.jpg', width: 100, height: 200 }],
  });
  assert.match(String(reqs[1].init.body), /selectedOptions \{ value \} media\(first: 1\) \{ nodes \{ \.\.\. on MediaImage \{ image \{ url \} \} \} \}/);
  // The variant photo tags the matching product photo with the variant's colour (D-47).
  assert.equal(buildBrief(normalize(r.products[0], SHOP), r.meta, config, null).shots[0].variant, 'Red');
  const { out, err } = await captureStderr(() => ingest(db, config, NOW, deps));
  assert.equal(out.length, 1);
  assert.ok(!err.includes(SECRET) && !err.includes(TOKEN));
});

test('admin failure falls back to the public feed with a warning; secret and token never leak', async () => {
  for (const bad of [
    () => new Response(`denied ${SECRET} ${TOKEN}`, { status: 401 }),
    (u: string) => (u.endsWith('/oauth/access_token') ? Response.json({ access_token: TOKEN }) : Response.json({ errors: [{ message: `no read_products ${TOKEN}` }] })),
  ]) {
    const { db, deps, calls } = adminSetup(bad);
    const { out, err } = await captureStderr(() => ingest(db, config, NOW, deps));
    assert.ok(out.length > 0);
    assert.ok(calls.some((u) => u.endsWith('/products.json') || u.includes('/products.json')));
    assert.match(err, /admin api failed, using the public feed/);
    assert.ok(!err.includes(SECRET) && !err.includes(TOKEN));
  }
});

test('without client credentials ingest never calls the admin api', async () => {
  delete process.env.SHOPIFY_CLIENT_ID;
  delete process.env.SHOPIFY_CLIENT_SECRET;
  const { db, deps, calls } = setup();
  await ingest(db, config, NOW, deps);
  assert.ok(!calls.some((u) => u.includes('/admin/')));
});
