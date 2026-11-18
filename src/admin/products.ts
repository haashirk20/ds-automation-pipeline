// Products and brand. Shopify products arrive with the daily store read; the owner can add more here, tick
// which products get videos, and upload the logo the video model sees. Each product's brief is the only
// source of what an ad may claim.
import type { IncomingMessage } from 'node:http';
import { closeSync, openSync, readSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { Brief } from '../contracts.ts';
import { audit, loadEffectiveConfig } from '../config/overrides.ts';
import { env } from '../config/index.ts';
import { kvGet, kvSet, type Db } from '../db/index.ts';
import { MAX_IMAGE, MAX_PHOTOS } from './upload.ts';
import { log } from '../ops/log.ts';
import { activeHandles, brandLogoFile, isLogoKey, LOGO_DIR, OwnerProduct, ownerBrief, OWN_PREFIX, SAFE_HANDLE, shopOf, slugHandle } from '../shopify/catalog.ts';
import { safeEqual } from './auth.ts';
import { html, raw, type Raw } from './html.ts';
import { inside } from './media.ts';
import { csrfField, layout, redirect, type Ctx, type Res } from './pages.ts';
import { ImageError, imageKind, readMultipart, saveImage } from './upload.ts';

export const MAX_PRODUCT_BODY = 64 * 1024 * 1024;
export const MAX_LOGO_BODY = MAX_IMAGE + 64 * 1024;
const ROOT = path.resolve(import.meta.dirname, '../..');
const CURRENCIES = ['CAD', 'USD', 'EUR', 'GBP', 'AUD'];

type Row = { handle: string; json: string; own: number };
type Item = { handle: string; brief: Brief; own: boolean };

function items(db: Db): Item[] {
  const rows = db.prepare('SELECT b.handle, b.json, (o.handle IS NOT NULL) AS own FROM briefs b LEFT JOIN owner_products o ON o.handle = b.handle ORDER BY own, b.handle').all() as Row[];
  const out: Item[] = [];
  for (const r of rows) {
    try { out.push({ handle: r.handle, brief: Brief.parse(JSON.parse(r.json)), own: !!r.own }); } catch { /* an unreadable brief is skipped */ }
  }
  return out;
}

const dataRoot = () => path.resolve(env.dataDir());
const plain = (status: number, text: string): Res => ({ status, body: text, type: 'text/plain; charset=utf-8' });
const notFound = plain(404, 'Not found');

// ---------- images ----------

const TYPES: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
function sendImage(file: string): Res {
  const head = Buffer.alloc(12);
  const fh = openSync(file, 'r');
  try { readSync(fh, head, 0, 12, 0); } finally { closeSync(fh); }
  const d = imageKind(head);
  if (!d) return notFound;
  const { size } = statSync(file);
  return { status: 200, headers: { 'cache-control': 'private, max-age=300' }, file: { path: file, start: 0, end: size - 1, size, type: TYPES[d] } };
}

// The first photo of a product, or photo `i`.
export function mediaPhoto(ctx: Ctx): Res {
  const handle = ctx.query.get('handle') ?? '';
  const i = Number(ctx.query.get('i') ?? 0);
  if (!SAFE_HANDLE.test(handle) || !Number.isInteger(i) || i < 0 || i > 50) return notFound;
  const r = ctx.db.prepare('SELECT json FROM briefs WHERE handle = ?').get(handle) as { json: string } | undefined;
  if (!r) return notFound;
  let shot: { file: string } | undefined;
  try { shot = Brief.parse(JSON.parse(r.json)).shots[i]; } catch { return notFound; }
  if (!shot) return notFound;
  const f = inside(path.resolve(dataRoot(), shot.file), path.join(dataRoot(), 'assets'));
  return f ? sendImage(f) : notFound;
}

export async function mediaLogo(ctx: Ctx): Promise<Res> {
  const cfg = await loadEffectiveConfig(ctx.db, ctx.now);
  const f = brandLogoFile(ctx.db, cfg, ROOT);
  if (!f) return notFound;
  const ok = inside(f, path.join(dataRoot(), LOGO_DIR)) ?? inside(f, path.join(ROOT, 'config'));
  return ok ? sendImage(ok) : notFound;
}

// ---------- the page ----------

const MSG: Record<string, string> = {
  saved: 'Product saved. It is in the rotation from the next video made.',
  selected: 'Selection saved. The next video uses it.',
  deleted: 'Product removed.',
  logo: 'Logo uploaded. The next video made uses it.',
  logofile: 'Back to the logo from the config file.',
};

export async function productsPage(ctx: Ctx, error: string | null = null, status = 200): Promise<Res> {
  const cfg = await loadEffectiveConfig(ctx.db, ctx.now);
  const list = items(ctx.db);
  const active = activeHandles(ctx.db);
  const on = (h: string) => (active ? active.includes(h) : true);
  const nOn = list.filter((x) => on(x.handle)).length;
  const m = ctx.query.get('msg');
  const uploaded = kvGet(ctx.db, 'brand_logo');
  const hasLogo = !!brandLogoFile(ctx.db, cfg, ROOT);
  const card = (x: Item) => html`<li class="pcard${on(x.handle) ? ' on' : ''}">
<label class="pcard-pick"><input type="checkbox" name="sel" value="${x.handle}"${on(x.handle) ? raw(' checked') : ''}> <span>Make videos</span></label>
<div class="pcard-img">${x.brief.shots.length ? html`<img src="/media/photo?handle=${x.handle}" alt="" loading="lazy" width="160" height="160">` : html`<span class="muted">No photo</span>`}</div>
<div class="pcard-body"><span class="tag ${x.own ? 'own' : 'shop'}">${x.own ? 'Added by you' : 'Shopify'}</span>
<strong>${x.brief.product.title}</strong><span class="pcard-price">${x.brief.product.priceText}</span>
<span class="muted">${x.brief.facts.length} facts · ${x.brief.shots.length} photos</span>
${x.own ? html`<span class="pcard-act"><a href="/products/edit?handle=${x.handle}">Edit</a> <button class="link danger" type="submit" formaction="/products/delete" name="handle" value="${x.handle}">Remove</button></span>` : html`<span class="pcard-act"><a href="/prompts/edit?key=${encodeURIComponent('note:' + x.handle)}">What it looks like</a></span>`}</div></li>`;
  return {
    ...layout(ctx, 'Products', '/products', html`${error ? html`<p class="error-box" role="alert">${error}</p>` : m && MSG[m] ? html`<p class="notice" role="status">${MSG[m]}</p>` : ''}
<div class="steps"><div><b>1</b><span>Tick the products you want videos for.</span></div><div><b>2</b><span>Press <em>Save selection</em>.</span></div><div><b>3</b><span>Ticked products take turns, one per video.</span></div></div>
<h2>Your products <small class="muted">${nOn} of ${list.length} get videos</small></h2>
${list.length ? html`<form method="post" action="/products/select">${csrfField(ctx)}<ul class="pgrid">${list.map(card)}
<li class="pcard add"><a href="/products/new"><span class="plus">+</span>Add your own product</a></li></ul>
<div class="actions"><button class="primary" type="submit">Save selection</button></div></form>`
      : html`<div class="panel"><p>No products yet. Shopify products appear after the pipeline's next store read (once a day, or when it starts). You can also add one yourself.</p><p><a class="btn primary" href="/products/new">+ Add your own product</a></p></div>`}
<h2>Logo</h2>
<div class="panel logo-panel"><div class="logo-box">${hasLogo ? html`<img src="/media/logo?v=${uploaded && isLogoKey(uploaded) ? uploaded.slice(11, 23) : 'file'}" alt="Current logo" width="160" height="160">` : html`<span class="muted">No logo</span>`}</div>
<div><p>The logo is sent to the video model with the product photos, so a gift box or label in the scene can carry it. ${uploaded && isLogoKey(uploaded) ? 'Using the logo uploaded here.' : cfg.brand.logo ? 'Using the logo from the config file.' : 'No logo is set.'}</p>
<form method="post" action="/brand/logo" enctype="multipart/form-data">${csrfField(ctx)}
<div class="field"><label for="logo">New logo</label><div><input id="logo" type="file" name="file" accept="image/png,image/jpeg" required><span class="hint">PNG or JPEG, up to 15 MB. A transparent PNG works best. It is resized to at most 1024 pixels.</span></div></div>
<div class="actions"><button class="primary" type="submit">Upload logo</button></div></form>
${uploaded ? html`<form method="post" action="/brand/logo/reset">${csrfField(ctx)}<button type="submit">Use the config file's logo</button></form>` : ''}</div></div>`),
    status,
  };
}

export async function productsSelect(ctx: Ctx): Promise<Res> {
  const known = new Set(items(ctx.db).map((x) => x.handle));
  const sel = [...new Set(ctx.form.getAll('sel'))].filter((h) => known.has(h));
  if (!sel.length) return productsPage(ctx, 'Tick at least one product. With none ticked there is nothing to make videos for.', 422);
  kvSet(ctx.db, 'products_active', JSON.stringify(sel.sort()));
  audit(ctx.db, 'admin', 'products.select', 'products', { selected: sel }, ctx.now);
  return redirect('/products?msg=selected');
}

export function productsDelete(ctx: Ctx): Res {
  const handle = ctx.form.get('handle') ?? '';
  if (!handle.startsWith(OWN_PREFIX) || !SAFE_HANDLE.test(handle) || !ctx.db.prepare('SELECT 1 FROM owner_products WHERE handle = ?').get(handle)) return redirect('/products');
  ctx.db.exec('BEGIN IMMEDIATE');
  try {
    ctx.db.prepare('DELETE FROM briefs WHERE handle = ?').run(handle);
    ctx.db.prepare('DELETE FROM owner_products WHERE handle = ?').run(handle);
    ctx.db.prepare('DELETE FROM products WHERE handle = ?').run(handle);
    const a = activeHandles(ctx.db);
    if (a) kvSet(ctx.db, 'products_active', JSON.stringify(a.filter((h) => h !== handle)));
    audit(ctx.db, 'admin', 'products.delete', handle, {}, ctx.now);
    ctx.db.exec('COMMIT');
  } catch (e) {
    ctx.db.exec('ROLLBACK');
    throw e;
  }
  const dir = path.join(dataRoot(), 'assets', handle);
  if (dir.startsWith(path.join(dataRoot(), 'assets') + path.sep)) try { rmSync(dir, { recursive: true, force: true }); } catch { /* left on disk */ }
  return redirect('/products?msg=deleted');
}

// ---------- the product form ----------

type FormVals = { handle: string; title: string; type: string; price: string; currency: string; url: string; colors: string; facts: string; disclosures: string };
const empty = (cur: string): FormVals => ({ handle: '', title: '', type: '', price: '', currency: cur, url: '', colors: '', facts: '', disclosures: '' });

function storeCurrency(db: Db): string {
  const r = db.prepare(`SELECT json FROM briefs WHERE handle NOT LIKE '${OWN_PREFIX}%' ORDER BY built_at DESC LIMIT 1`).get() as { json: string } | undefined;
  try { return r ? Brief.parse(JSON.parse(r.json)).shop.currency : 'CAD'; } catch { return 'CAD'; }
}

function ownerRow(db: Db, handle: string): OwnerProduct | null {
  const r = db.prepare('SELECT json FROM owner_products WHERE handle = ?').get(handle) as { json: string } | undefined;
  if (!r) return null;
  try { return OwnerProduct.parse(JSON.parse(r.json)); } catch { return null; }
}

export function productForm(ctx: Ctx, v: FormVals | null = null, errors: string[] = [], status = 200): Res {
  const editing = ctx.query.get('handle') ?? v?.handle ?? '';
  const existing = editing ? ownerRow(ctx.db, editing) : null;
  if (editing && !existing) return { ...layout(ctx, 'Not found', '/products', html`<p>No such product. <a href="/products">Back to products</a></p>`), status: 404 };
  const vals: FormVals = v ?? (existing ? { handle: editing, title: existing.title, type: existing.type, price: String(existing.price), currency: existing.currency, url: existing.url, colors: existing.colors.join(', '), facts: existing.facts.join('\n'), disclosures: existing.disclosures.join('\n') } : empty(storeCurrency(ctx.db)));
  const f = (id: string, label: string, input: Raw, hint: string) => html`<div class="field"><label for="${id}">${label}</label><div>${input}<span class="hint">${hint}</span></div></div>`;
  return {
    ...layout(ctx, existing ? `Edit ${existing.title}` : 'Add a product', '/products', html`${errors.length ? html`<div class="error-box" role="alert"><strong>Not saved.</strong><ul>${errors.map((e) => html`<li>${e}</li>`)}</ul>${v ? html`<p>Choose the photos again: a browser does not keep them after an error.</p>` : ''}</div>` : ''}
<p>Add a product that is not in your Shopify store. Videos may say <strong>only</strong> what you write under <em>Facts</em>, so write each true statement on its own line.</p>
<form method="post" action="/products/save" enctype="multipart/form-data">${csrfField(ctx)}<input type="hidden" name="handle" value="${vals.handle}">
<fieldset><legend>The basics</legend>
${f('title', 'Product name', html`<input id="title" type="text" name="title" value="${vals.title}" maxlength="120" required>`, 'As it should appear in a video, for example: Heated Shawl Wrap.')}
${f('type', 'Kind of product (optional)', html`<input id="type" type="text" name="type" value="${vals.type}" maxlength="60">`, 'For example: Wearable blanket.')}
${f('price', 'Price', html`<span class="price-row"><input id="price" type="text" inputmode="decimal" name="price" value="${vals.price}" required><select name="currency" aria-label="Currency">${CURRENCIES.map((c) => html`<option${c === vals.currency ? raw(' selected') : ''}>${c}</option>`)}</select></span>`, 'The regular price. Videos never mention discounts for products added here.')}
${f('url', 'Link (optional)', html`<input id="url" type="text" name="url" value="${vals.url}" maxlength="300" placeholder="https://">`, 'Where a viewer can buy it. Must start with https://.')}
${f('colors', 'Colours (optional)', html`<input id="colors" type="text" name="colors" value="${vals.colors}" maxlength="400">`, 'Comma separated, for example: Beige, Green, Red.')}</fieldset>
<fieldset><legend>Facts the videos may use</legend>
${f('facts', 'Facts, one per line', html`<textarea id="facts" name="facts" class="short" rows="8" required>${vals.facts}</textarea>`, 'Only true statements you can stand behind: what it is, what it is made of, what it does, size, what is in the box. No reviews, ratings or "best seller". Up to 40 lines.')}
${f('disclosures', 'Disclosures, one per line (optional)', html`<textarea id="disclosures" name="disclosures" class="short" rows="3">${vals.disclosures}</textarea>`, 'Shown in every caption, for example: Power bank not included.')}</fieldset>
<fieldset><legend>Photos</legend>
${existing ? html`<div class="field"><span class="lbl">Keep these photos</span><div class="thumbs">${existing.photos.map((p, i) => html`<label class="thumb"><img src="/media/photo?handle=${editing}&i=${i}" alt="" width="96" height="96"><span><input type="checkbox" name="keep" value="${p.file}" checked> Keep</span></label>`)}</div></div>` : ''}
${f('photos', existing ? 'Add photos' : 'Photos', html`<input id="photos" type="file" name="photos" accept="image/png,image/jpeg" multiple${existing ? '' : raw(' required')}>`, `1 to ${MAX_PHOTOS} photos of the product itself, PNG or JPEG, up to 15 MB each. Photos with no printed text work best; the video model copies what it sees.`)}</fieldset>
<div class="field"><label for="ack">Check</label><div><input id="ack" type="checkbox" name="ack" value="1" required> Every fact above is true, and I may use these photos in ads.</div></div>
<div class="actions"><button class="primary" type="submit">${existing ? 'Save product' : 'Add product'}</button><a href="/products">Cancel</a></div></form>`),
    status,
  };
}

const lines = (s: string) => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const CLAIM_WORDS = /best.?sell|top.?rated|award|#\s?1\b|number one|guarantee|\bsale\b|% off|\bdiscount|\breviews?\b|\bstars?\b/i;
let busy = false;

// POST /products/save (multipart). The caller has checked the session, Origin and Sec-Fetch-Site.
export async function productSave(ctx: Ctx, req: IncomingMessage): Promise<Res> {
  if (busy) return plain(429, 'Another upload is running');
  busy = true;
  const written: string[] = [];
  try {
    const r = await readMultipart(req, MAX_PRODUCT_BODY);
    if ('why' in r) return { ...productForm(ctx, null, [r.why === 'large' ? 'The upload is over 64 MB in all. Use fewer or smaller photos.' : 'The upload could not be read.'], r.why === 'large' ? 413 : 400), headers: { connection: 'close' } };
    const fd = r.fd;
    if (!safeEqual(String(fd.get('csrf') ?? ''), ctx.csrf ?? '')) return { ...plain(403, 'Forbidden'), headers: { connection: 'close' } };
    const s = (k: string) => String(fd.get(k) ?? '');
    const vals: FormVals = { handle: s('handle'), title: s('title').trim(), type: s('type').trim(), price: s('price').trim(), currency: s('currency'), url: s('url').trim(), colors: s('colors'), facts: s('facts'), disclosures: s('disclosures') };
    const editing = vals.handle ? ownerRow(ctx.db, vals.handle) : null;
    if (vals.handle && !editing) return redirect('/products');
    const errors: string[] = [];
    if (fd.get('ack') !== '1') errors.push('Tick the box to confirm the facts are true and the photos may be used.');
    if (!CURRENCIES.includes(vals.currency)) errors.push('Choose a currency.');
    const facts = lines(vals.facts);
    const claimy = facts.filter((l) => CLAIM_WORDS.test(l));
    if (claimy.length) errors.push(`Remove reviews, ratings, sales and "best" claims from the facts: ${claimy.slice(0, 3).join(' / ')}`);
    const keep = new Set(fd.getAll('keep').map(String));
    const kept = editing ? editing.photos.filter((p) => keep.has(p.file)) : [];
    const files = fd.getAll('photos').filter((x): x is File => x instanceof File && x.size > 0);
    if (kept.length + files.length < 1) errors.push('Add at least one photo.');
    if (kept.length + files.length > MAX_PHOTOS) errors.push(`At most ${MAX_PHOTOS} photos in all.`);
    const draft = { title: vals.title, type: vals.type, price: Number(vals.price.replace(/[$,\s]/g, '')), currency: vals.currency, url: vals.url, colors: vals.colors.split(',').map((c) => c.trim()).filter(Boolean), facts, disclosures: lines(vals.disclosures), photos: [{ file: 'x', width: 1, height: 1 }] };
    const check = OwnerProduct.safeParse(draft);
    if (!check.success) for (const i of check.error.issues) errors.push(`${{ title: 'Product name', type: 'Kind of product', price: 'Price', currency: 'Currency', url: 'Link', colors: 'Colours', facts: 'Facts', disclosures: 'Disclosures' }[String(i.path[0])] ?? String(i.path[0])}${i.path.length > 1 ? ` line ${Number(i.path[1]) + 1}` : ''}: ${i.message}`);
    if (errors.length) return productForm(ctx, vals, errors, 422);

    let handle = editing ? vals.handle : slugHandle(vals.title);
    if (!editing) for (let k = 2; ctx.db.prepare('SELECT 1 FROM products WHERE handle = ?').get(handle); k++) handle = `${slugHandle(vals.title)}-${k}`;
    const dir = path.join(dataRoot(), 'assets', handle);
    const photos = [...kept];
    try {
      for (const file of files) {
        const img = await saveImage(file, dir, '', 1600);
        written.push(path.join(dir, img.name));
        photos.push({ file: `assets/${handle}/${img.name}`, width: img.width, height: img.height });
      }
    } catch (e) {
      if (e instanceof ImageError) return productForm(ctx, vals, [e.message], 422);
      log.warn('product photo refused', { error: (e as Error).message.slice(0, 200) });
      return productForm(ctx, vals, ['A photo could not be read.'], 422);
    }
    const p = OwnerProduct.parse({ ...draft, photos });
    const cfg = await loadEffectiveConfig(ctx.db, ctx.now);
    const brief = ownerBrief(handle, p, shopOf(ctx.db, cfg, p.currency));
    const at = ctx.now.toISOString();
    ctx.db.exec('BEGIN IMMEDIATE');
    try {
      ctx.db.prepare('INSERT INTO products (handle, title, updated_at, raw_json, fetched_at) VALUES (?,?,?,?,?) ON CONFLICT(handle) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at, raw_json = excluded.raw_json, fetched_at = excluded.fetched_at').run(handle, p.title, at, JSON.stringify({ owner: true, ...p }), at);
      ctx.db.prepare('INSERT INTO briefs (handle, source_hash, json, built_at) VALUES (?,?,?,?) ON CONFLICT(handle) DO UPDATE SET source_hash = excluded.source_hash, json = excluded.json, built_at = excluded.built_at').run(handle, brief.sourceHash, JSON.stringify(brief), at);
      ctx.db.prepare('INSERT INTO owner_products (handle, json, created_at, updated_at) VALUES (?,?,?,?) ON CONFLICT(handle) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at').run(handle, JSON.stringify(p), at, at);
      const a = activeHandles(ctx.db);
      if (a && !editing && !a.includes(handle)) kvSet(ctx.db, 'products_active', JSON.stringify([...a, handle].sort()));
      audit(ctx.db, 'admin', editing ? 'products.edit' : 'products.add', handle, { title: p.title, facts: p.facts.length, photos: p.photos.length }, ctx.now);
      ctx.db.exec('COMMIT');
    } catch (e) {
      ctx.db.exec('ROLLBACK');
      throw e;
    }
    written.length = 0;
    // Photos that were not kept are removed.
    if (editing) for (const old of editing.photos) if (!keep.has(old.file)) { const f = inside(path.resolve(dataRoot(), old.file), path.join(dataRoot(), 'assets')); if (f) try { rmSync(f, { force: true }); } catch { /* sweep */ } }
    return redirect('/products?msg=saved');
  } finally {
    busy = false;
    for (const f of written) try { rmSync(f, { force: true }); } catch { /* sweep */ }
  }
}

// POST /brand/logo (multipart).
export async function logoUpload(ctx: Ctx, req: IncomingMessage): Promise<Res> {
  if (busy) return plain(429, 'Another upload is running');
  busy = true;
  try {
    const r = await readMultipart(req, MAX_LOGO_BODY);
    if ('why' in r) return { ...(await productsPage(ctx, r.why === 'large' ? 'The logo is over 15 MB.' : 'The upload could not be read.', r.why === 'large' ? 413 : 400)), headers: { connection: 'close' } };
    if (!safeEqual(String(r.fd.get('csrf') ?? ''), ctx.csrf ?? '')) return { ...plain(403, 'Forbidden'), headers: { connection: 'close' } };
    const file = r.fd.get('file');
    if (!(file instanceof File) || file.size === 0) return productsPage(ctx, 'Choose a logo file.', 422);
    let img: { name: string };
    try {
      img = await saveImage(file, path.join(dataRoot(), LOGO_DIR), 'logo-', 1024);
    } catch (e) {
      if (e instanceof ImageError) return productsPage(ctx, e.message, 422);
      log.warn('logo refused', { error: (e as Error).message.slice(0, 200) });
      return productsPage(ctx, 'The logo could not be read.', 422);
    }
    const key = `${LOGO_DIR}/${img.name}`;
    const old = kvGet(ctx.db, 'brand_logo');
    kvSet(ctx.db, 'brand_logo', key);
    audit(ctx.db, 'admin', 'brand.logo', key, {}, ctx.now);
    if (old && old !== key && isLogoKey(old)) try { rmSync(path.join(dataRoot(), old), { force: true }); } catch { /* sweep */ }
    return redirect('/products?msg=logo');
  } finally {
    busy = false;
  }
}

export function logoReset(ctx: Ctx): Res {
  const old = kvGet(ctx.db, 'brand_logo');
  ctx.db.prepare("DELETE FROM kv WHERE key = 'brand_logo'").run();
  audit(ctx.db, 'admin', 'brand.logo', 'file', {}, ctx.now);
  if (old && isLogoKey(old)) try { rmSync(path.join(dataRoot(), old), { force: true }); } catch { /* sweep */ }
  return redirect('/products?msg=logofile');
}
