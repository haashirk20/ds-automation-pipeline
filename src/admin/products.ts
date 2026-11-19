// Products and brand. Shopify products arrive with the hourly store read; the owner can add more here, tick
// which products get videos, and upload the logo the video model sees. Each product's brief is the only
// source of what an ad may claim.
import type { IncomingMessage } from 'node:http';
import { closeSync, existsSync, openSync, readdirSync, readSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { Brief } from '../contracts.ts';
import { audit, loadEffectiveConfig } from '../config/overrides.ts';
import { env } from '../config/index.ts';
import { kvGet, kvSet, type Db } from '../db/index.ts';
import { MAX_IMAGE, MAX_PHOTOS } from './upload.ts';
import { log } from '../ops/log.ts';
import { activeHandles, brandLogoFile, isLogoKey, LOGO_DIR, NoBriefError, OwnerProduct, ownerBrief, OWN_PREFIX, pickBrief, SAFE_HANDLE, shopOf, slotProducts, slugHandle, staleSelections } from '../shopify/catalog.ts';
import { enabledPlatforms } from '../scheduler/planner.ts';
import { addDays, localDateOf, localToUtc } from '../scheduler/time.ts';
import type { Config } from '../config/index.ts';
import { safeEqual } from './auth.ts';
import { html, raw, type Raw } from './html.ts';
import { inside } from './media.ts';
import { csrfField, layout, redirect, type Ctx, type Res } from './pages.ts';
import { badge, confirmRemove, empty, errSummary, flash, fmtDate, fmtLocal, formRow } from './ui.ts';
import { ImageError, imageKind, readMultipart, saveImage } from './upload.ts';

export const MAX_PRODUCT_BODY = 64 * 1024 * 1024;
export const MAX_LOGO_BODY = MAX_IMAGE + 64 * 1024;
const ROOT = path.resolve(import.meta.dirname, '../..');
const CURRENCIES = ['CAD', 'USD', 'EUR', 'GBP', 'AUD'];

type Row = { handle: string; json: string; own: number; skipped: number | null };
type Item = { handle: string; brief: Brief; own: boolean; skipped: number };

function items(db: Db): Item[] {
  // skipped: Shopify photos the last store read could not download (products.raw_json, written by ingest).
  const rows = db.prepare("SELECT b.handle, b.json, (o.handle IS NOT NULL) AS own, CASE WHEN json_valid(p.raw_json) THEN json_extract(p.raw_json, '$.imagesSkipped') END AS skipped FROM briefs b LEFT JOIN owner_products o ON o.handle = b.handle LEFT JOIN products p ON p.handle = b.handle ORDER BY own, b.handle").all() as Row[];
  const out: Item[] = [];
  for (const r of rows) {
    try { out.push({ handle: r.handle, brief: Brief.parse(JSON.parse(r.json)), own: !!r.own, skipped: Number(r.skipped) || 0 }); } catch { /* an unreadable brief is skipped */ }
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

const MSG: Record<string, [string, string]> = {
  saved: ['Product saved.', 'It can be used from the next video made.'],
  selected: ['Choices saved.', 'The next video made uses them.'],
  deleted: ['Product removed.', 'Videos already made are not changed.'],
  logo: ['Logo uploaded.', 'The next video made uses it.'],
  logofile: ['Back to the default logo.', 'The next video made uses it.'],
  sync_requested: ['Shopify check requested.', 'The factory reads your store within a minute; refresh to see the result.'],
};

// The daily post times, from the first enabled platform (the planner uses the same one).
function postTimes(cfg: Config): string[] {
  const p = enabledPlatforms(cfg)[0];
  return p ? cfg.platforms[p as keyof Config['platforms']].slots : [];
}

// The next time each daily post goes out, and its product: the one already made for that slot, else the one pickBrief gives it.
function nextPosts(db: Db, cfg: Config, now: Date): { idx: number; date: string; time: string; title: string }[] {
  const today = localDateOf(now, cfg.timezone);
  return postTimes(cfg).map((time, i) => {
    const date = localToUtc(today, time, cfg.timezone) > now ? today : addDays(today, 1);
    let title = 'no product yet';
    const made = db.prepare("SELECT p.title, s.product_handle AS handle FROM slots s LEFT JOIN products p ON p.handle = s.product_handle WHERE s.local_date = ? AND s.idx = ? AND s.kind = 'planned' AND s.product_handle IS NOT NULL").get(date, i + 1) as { title: string | null; handle: string } | undefined;
    if (made) title = `${made.title ?? made.handle} (already made)`;
    else try { title = pickBrief(db, { local_date: date, idx: i + 1, kind: 'planned' }).product.title; } catch (e) { if (!(e instanceof NoBriefError)) throw e; }
    return { idx: i + 1, date, time, title };
  });
}

// The one choice per product. It maps onto the stored kv (D-40) in productsSelect: a post choice puts the
// handle in slot_products, 'any' puts it in the products_active pool, 'none' in neither.
type Use = 'none' | '1' | '2' | 'both' | 'any';
function useOf(h: string, pool: string[] | null, perPost: Record<string, string[]>): Use {
  const p1 = (perPost['1'] ?? []).includes(h);
  const p2 = (perPost['2'] ?? []).includes(h);
  if (p1 && p2) return 'both';
  if (p1) return '1';
  if (p2) return '2';
  return !pool || pool.includes(h) ? 'any' : 'none';
}

const parseJson = <T>(s: string | undefined): T | null => { try { return s ? (JSON.parse(s) as T) : null; } catch { return null; } };
type SyncResult = { at?: string; ok?: boolean; added?: number; updated?: number; removed?: number; error?: string };
type Stale = { post: number | null; handles: string[] };
const staleOf = (db: Db): Stale[] => staleSelections(db);

// A failed store read in plain words; the raw (already scrubbed) text goes under Technical details.
export function plainSyncError(e: string): string {
  if (/\b40[13]\b/.test(e)) return "Shopify refused the app's key. Check the Shopify app connection.";
  if (/network|fetch failed|timeout|timed out|abort|deadline|ECONN|ENOTFOUND|EAI_AGAIN/i.test(e)) return 'Shopify could not be reached. It tries again within the hour.';
  if (/returned no products/.test(e)) return e;
  return 'Shopify could not be read.';
}

function shopStatus(db: Db, tz: string): Raw {
  const res = parseJson<SyncResult>(kvGet(db, 'shop_sync_result'));
  const r = res && typeof res === 'object' && typeof res.at === 'string' ? res : null;
  const requested = kvGet(db, 'ingest_requested');
  const pending = requested && (!r || requested > r.at!);
  const fallback = kvGet(db, 'shop_synced_at');
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const line = r
    ? r.ok === false ? html`<span class="err">Last check failed (${fmtLocal(r.at, tz)}): ${plainSyncError(String(r.error ?? ''))}</span>` : html`Last checked ${fmtLocal(r.at, tz)}: ${n(r.added)} new, ${n(r.updated)} updated, ${n(r.removed)} gone.`
    : fallback ? html`Last checked ${fmtLocal(fallback, tz)}.` : html`Not checked yet.`;
  const trunc = parseJson<{ total?: number; kept?: number }>(kvGet(db, 'shop_truncated'));
  const tech = r && r.ok === false && r.error ? html`<details class="tech"><summary>Technical details</summary>${String(r.error)}</details>` : '';
  return html`<span class="hint">${line}${pending ? html` <strong>Check pending…</strong>` : ''} Shopify is also checked every hour.</span>${tech}${trunc && typeof trunc === 'object' && trunc.total ? html`<span class="hint"><strong>Your store has ${n(trunc.total)} products; only the first ${n(trunc.kept)} are used.</strong></span>` : ''}`;
}

export async function productsPage(ctx: Ctx, error: string | null = null, status = 200): Promise<Res> {
  const cfg = await loadEffectiveConfig(ctx.db, ctx.now);
  const tz = cfg.timezone;
  const list = items(ctx.db);
  const pool = activeHandles(ctx.db);
  const times = postTimes(cfg).slice(0, 2);
  const perPost = slotProducts(ctx.db);
  const next = nextPosts(ctx.db, cfg, ctx.now);
  const m = ctx.query.get('msg');
  const uploaded = kvGet(ctx.db, 'brand_logo');
  const hasLogo = !!brandLogoFile(ctx.db, cfg, ROOT);
  const used = (h: string) => useOf(h, pool, perPost) !== 'none';
  const nOn = list.filter((x) => used(x.handle)).length;
  const choices: [Use, string][] = [['none', 'Not used'], ...times.map((t, i): [Use, string] => [String(i + 1) as Use, `Post ${i + 1} · ${t}`]), ...(times.length > 1 ? [['both', 'Both posts'] as [Use, string]] : []), ['any', 'Any post']];
  const photoOk = (x: Item) => !!x.brief.shots[0] && !!inside(path.resolve(dataRoot(), x.brief.shots[0].file), path.join(dataRoot(), 'assets')) && existsSync(path.resolve(dataRoot(), x.brief.shots[0].file));
  const card = (x: Item, i: number) => {
    const u = useOf(x.handle, pool, perPost);
    const name = `use.${x.handle}`;
    return html`<li class="pcard${u !== 'none' ? ' on' : ''}">
<div class="pcard-img">${photoOk(x) ? html`<img src="/media/photo?handle=${x.handle}" alt="${x.brief.product.title}" loading="lazy" width="160" height="120">` : html`<span class="muted">No photo${!x.own && x.skipped > 0 ? '. Photos could not be downloaded from Shopify; they are tried again at the next check.' : ''}</span>`}</div>
<div class="pcard-body">${x.own ? badge('warn', 'Added by you') : badge('ok', 'From Shopify')}
<strong>${x.brief.product.title}</strong><span class="pcard-price">${x.brief.product.priceText}</span>
<fieldset><legend>Use in videos</legend>${choices.map(([v, label]) => html`<label class="check" for="u-${x.handle}-${v}"><input id="u-${x.handle}-${v}" type="radio" name="${name}" value="${v}"${u === v ? raw(' checked') : ''}> ${label}</label>`)}</fieldset>
<div class="pcard-act">${x.own ? html`<a href="/products/edit?handle=${x.handle}">Edit</a>${confirmRemove('Remove…', html`<button class="danger" type="submit" form="del-${i}">Yes, remove ${x.brief.product.title}</button>`)}` : html`<a href="/prompts/edit?key=${encodeURIComponent('note:' + x.handle)}">Describe how it looks</a>`}</div></div></li>`;
  };
  // "Any post" products are unused by daily posts when every post has a product of its own (chooseBrief).
  const title = (h: string) => list.find((x) => x.handle === h)?.brief.product.title;
  const anyTitles = (pool ?? []).map(title).filter((t): t is string => !!t);
  const allPostsOwn = times.length > 0 && postTimes(cfg).every((_, i) => (perPost[String(i + 1)] ?? []).some((h) => title(h)));
  const trap = anyTitles.length && allPostsOwn ? flash('bad', `${anyTitles.join(', ')} ${anyTitles.length > 1 ? 'are' : 'is'} set to "Any post", but every post already has its own product, so ${anyTitles.length > 1 ? 'they are' : 'it is'} used only by "Make a video now".`, `Put ${anyTitles.length > 1 ? 'them' : 'it'} on a post, or leave one post with no product of its own so "Any post" products fill it.`) : '';
  const flashes = html`${trap}${error ? flash('bad', 'Not done.', error) : m === 'synced' ? flash('ok', 'Shopify checked.', '') : m && MSG[m] ? flash(m === 'sync_requested' ? 'info' : 'ok', MSG[m][0], MSG[m][1]) : ''}
${staleOf(ctx.db).map((s) => flash('bad', s.post === null ? 'Some products you set to Any post are no longer in the store.' : `Post ${s.post}: the product you chose is no longer in the store, so the other products take turns.`, 'Choose again below and save.'))}`;
  return {
    ...layout(ctx, 'Products', '/products', html`${flashes}
<section class="card"><div class="section-head"><h2>Next posts</h2><div class="section-actions"><a class="btn primary" href="/products/new">Add a product</a><form method="post" action="/products/sync">${csrfField(ctx)}<button type="submit">Get latest from Shopify</button></form></div></div>
${shopStatus(ctx.db, tz)}
${next.length ? html`<ul class="next-posts">${next.map((x) => html`<li data-post="${x.idx}" data-date="${x.date}"><strong>Post ${x.idx} · ${x.time}</strong> next on ${fmtDate(x.date)}, uses: <strong>${x.title}</strong></li>`)}</ul>` : html`<p>Every platform is off, so nothing is posted. Turn one on in <a href="/settings#where">Settings</a>.</p>`}
<p class="hint">${times.length ? `Each day has ${times.map((t, i) => `Post ${i + 1} (${t})`).join(' and ')}. ` : ''}Products on the same post take turns day by day. "Any post" products fill posts that have no product chosen, and "Make a video now". If no product is set to "Any post", those use the products chosen for a post. "Not used" products are never used unless nothing else is chosen.</p></section>
<section><h2>Your products</h2>
${list.length ? html`<form method="post" action="/products/select">${csrfField(ctx)}<ul class="pgrid">${list.map(card)}
<li class="pcard add"><a href="/products/new"><span class="plus" aria-hidden="true">+</span>Add your own product</a></li></ul>
<div class="sticky-save"><button class="primary" type="submit">Save choices</button><span class="muted">${nOn} of ${list.length} used in videos</span></div></form>
${list.map((x, i) => (x.own ? html`<form id="del-${i}" method="post" action="/products/delete">${csrfField(ctx)}<input type="hidden" name="handle" value="${x.handle}"></form>` : ''))}`
      : empty('No products yet. Shopify products appear after the next store check (every hour), or press "Get latest from Shopify" above.', html`<a class="btn primary" href="/products/new">Add your own product</a>`)}</section>
<section class="card"><h2>Your logo</h2><div class="logo-panel"><div class="logo-box">${hasLogo ? html`<img src="/media/logo?v=${uploaded && isLogoKey(uploaded) ? uploaded.slice(11, 23) : 'file'}" alt="Your logo" width="160" height="160">` : html`<span class="muted">No logo</span>`}</div>
<div><p>Shown to the video model so a gift box or label in the scene can carry it. ${uploaded && isLogoKey(uploaded) ? 'Using the logo uploaded here.' : cfg.brand.logo ? 'Using the default logo.' : 'No logo is set.'}</p>
<form method="post" action="/brand/logo" enctype="multipart/form-data">${csrfField(ctx)}
${formRow({ id: 'logo', label: 'New logo', control: html`<input id="logo" type="file" name="file" accept="image/png,image/jpeg" required>`, hint: 'PNG or JPEG, up to 15 MB. A transparent PNG works best.' })}
<div class="actions"><button class="primary" type="submit">Upload logo</button></div></form>
${uploaded ? html`<form method="post" action="/brand/logo/reset">${csrfField(ctx)}<button class="link" type="submit">Use the default logo instead</button></form>` : ''}</div></div></section>`),
    status,
  };
}

export async function productsSelect(ctx: Ctx): Promise<Res> {
  const known = items(ctx.db).map((x) => x.handle);
  const cfg = await loadEffectiveConfig(ctx.db, ctx.now);
  const nPosts = postTimes(cfg).length;
  // The page sends one choice per product (use.<handle>); plain sel / postN fields are read too.
  const sel = new Set(ctx.form.getAll('sel'));
  const posts: Record<string, Set<string>> = Object.fromEntries(Array.from({ length: nPosts }, (_, i) => [String(i + 1), new Set(ctx.form.getAll(`post${i + 1}`))]));
  for (const h of known) {
    const u = ctx.form.get(`use.${h}`);
    if (u === 'any') sel.add(h);
    if ((u === '1' || u === 'both') && posts['1']) posts['1'].add(h);
    if ((u === '2' || u === 'both') && posts['2']) posts['2'].add(h);
  }
  const pool = [...sel].filter((h) => known.includes(h)).sort();
  const lists = Object.fromEntries(Object.entries(posts).map(([k, s]) => [k, [...s].filter((h) => known.includes(h)).sort()]));
  if (!pool.length && !Object.values(lists).some((l) => l.length)) return productsPage(ctx, 'Choose at least one product for a post or for "Any post". With none chosen there is nothing to make videos for.', 422);
  kvSet(ctx.db, 'products_active', JSON.stringify(pool));
  kvSet(ctx.db, 'slot_products', JSON.stringify(lists));
  audit(ctx.db, 'admin', 'products.select', 'products', { selected: pool, posts: lists }, ctx.now);
  return redirect('/products?msg=selected');
}

// Asks the factory to read the store now. The admin has no Shopify credentials (D-32); the scheduler does the read.
export function productsSync(ctx: Ctx): Res {
  const prev = kvGet(ctx.db, 'ingest_requested');
  if (prev && ctx.now.getTime() - Date.parse(prev) < 60_000) return redirect('/products?msg=sync_requested'); // already asked this minute
  kvSet(ctx.db, 'ingest_requested', ctx.now.toISOString());
  audit(ctx.db, 'admin', 'products.sync', 'products', {}, ctx.now);
  return redirect('/products?msg=sync_requested');
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
const blank = (cur: string): FormVals => ({ handle: '', title: '', type: '', price: '', currency: cur, url: '', colors: '', facts: '', disclosures: '' });

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
  if (editing && !existing) return { ...layout(ctx, 'Not found', '/products', html`<p>No such product.</p><p><a class="btn" href="/products">Back to Products</a></p>`), status: 404 };
  const vals: FormVals = v ?? (existing ? { handle: editing, title: existing.title, type: existing.type, price: String(existing.price), currency: existing.currency, url: existing.url, colors: existing.colors.join(', '), facts: existing.facts.join('\n'), disclosures: existing.disclosures.join('\n') } : blank(storeCurrency(ctx.db)));
  const f = (id: string, label: string, input: Raw, hint: string) => formRow({ id, label, control: input, hint });
  return {
    ...layout(ctx, existing ? `Edit ${existing.title}` : 'Add a product', '/products', html`${errSummary(errors.map((msg) => ({ msg })))}${errors.length && v ? html`<p class="hint">Choose the photos again: a browser does not keep them after an error.</p>` : ''}
<p>Add a product that is not in your Shopify store. Videos may say <strong>only</strong> what you write under <em>Facts</em>, so write each true statement on its own line.</p>
<form method="post" action="/products/save" enctype="multipart/form-data">${csrfField(ctx)}<input type="hidden" name="handle" value="${vals.handle}">
<section class="card"><h2>About the product</h2>
${f('title', 'Product name', html`<input id="title" type="text" name="title" value="${vals.title}" maxlength="120" required>`, 'As it should appear in a video, for example: Heated Shawl Wrap.')}
${f('type', 'Kind of product (optional)', html`<input id="type" type="text" name="type" value="${vals.type}" maxlength="60">`, 'For example: Wearable blanket.')}
${f('price', 'Price', html`<span class="price-row"><input id="price" type="text" inputmode="decimal" name="price" value="${vals.price}" required><select name="currency" aria-label="Currency">${CURRENCIES.map((c) => html`<option${c === vals.currency ? raw(' selected') : ''}>${c}</option>`)}</select></span>`, 'The regular price. Videos never mention discounts for products added here.')}
${f('url', 'Link (optional)', html`<input id="url" type="text" name="url" value="${vals.url}" maxlength="300" placeholder="https://">`, 'Where a viewer can buy it. Must start with https://.')}
${f('colors', 'Colours (optional)', html`<input id="colors" type="text" name="colors" value="${vals.colors}" maxlength="400">`, 'Comma separated, for example: Beige, Green, Red.')}</section>
<section class="card"><h2>What videos may say</h2>
${f('facts', 'Facts, one per line', html`<textarea id="facts" name="facts" class="short" rows="8" required>${vals.facts}</textarea>`, 'Only true statements you can stand behind: what it is, what it is made of, what it does, size, what is in the box. No reviews, ratings or "best seller". Up to 40 lines.')}
${f('disclosures', 'Disclosures, one per line (optional)', html`<textarea id="disclosures" name="disclosures" class="short" rows="3">${vals.disclosures}</textarea>`, 'Shown in every caption, for example: Power bank not included.')}</section>
<section class="card"><h2>Photos</h2>
${existing ? html`<fieldset class="form-row"><legend class="lbl">Keep these photos</legend><div class="thumbs">${existing.photos.map((p, i) => html`<label class="thumb"><img src="/media/photo?handle=${editing}&i=${i}" alt="${existing.title}, photo ${i + 1}" width="96" height="96"><span><input type="checkbox" name="keep" value="${p.file}" checked> Keep</span></label>`)}</div></fieldset>` : ''}
${f('photos', existing ? 'Add photos (optional)' : 'Photos', html`<input id="photos" type="file" name="photos" accept="image/png,image/jpeg" multiple${existing ? '' : raw(' required')}>`, `1 to ${MAX_PHOTOS} photos of the product itself, PNG or JPEG, up to 15 MB each. Photos with no printed text work best; the video model copies what it sees.`)}</section>
<div class="card"><label class="check" for="ack"><input id="ack" type="checkbox" name="ack" value="1" required> I confirm every fact is true and I may use these photos in ads.</label></div>
<div class="sticky-save"><button class="primary" type="submit">${existing ? 'Save product' : 'Add product'}</button><a href="/products">Cancel</a></div></form>`),
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
    // Photos are named by content, so a re-upload can land on a file already in use: only new files are undone on failure.
    const before = new Set(existsSync(dir) ? readdirSync(dir) : []);
    try {
      for (const file of files) {
        const img = await saveImage(file, dir, '', 1600);
        const f = path.join(dir, img.name);
        if (!before.has(img.name) && !written.includes(f)) written.push(f);
        const rel = `assets/${handle}/${img.name}`;
        if (!photos.some((x) => x.file === rel)) photos.push({ file: rel, width: img.width, height: img.height });
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
    // Photos no longer in the product are removed; a re-uploaded one is still in `photos`.
    const inUse = new Set(photos.map((x) => x.file));
    if (editing) for (const old of editing.photos) if (!inUse.has(old.file)) { const f = inside(path.resolve(dataRoot(), old.file), path.join(dataRoot(), 'assets')); if (f) try { rmSync(f, { force: true }); } catch { /* left on disk */ } }
    return redirect('/products?msg=saved');
  } finally {
    busy = false;
    for (const f of written) try { rmSync(f, { force: true }); } catch { /* left on disk */ }
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
    if (old && old !== key && isLogoKey(old)) try { rmSync(path.join(dataRoot(), old), { force: true }); } catch { /* left on disk */ }
    return redirect('/products?msg=logo');
  } finally {
    busy = false;
  }
}

export function logoReset(ctx: Ctx): Res {
  const old = kvGet(ctx.db, 'brand_logo');
  ctx.db.prepare("DELETE FROM kv WHERE key = 'brand_logo'").run();
  audit(ctx.db, 'admin', 'brand.logo', 'file', {}, ctx.now);
  if (old && isLogoKey(old)) try { rmSync(path.join(dataRoot(), old), { force: true }); } catch { /* left on disk */ }
  return redirect('/products?msg=logofile');
}
