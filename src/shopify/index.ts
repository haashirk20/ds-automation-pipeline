import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { Transform } from 'node:stream';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Brief } from '../contracts.ts';
import { env, type Config } from '../config/index.ts';
import { kvGet, kvSet, type Db } from '../db/index.ts';
import { alert } from '../ops/alert.ts';
import { log, scrub } from '../ops/log.ts';
import { buildBrief, normalize, type Product } from './brief.ts';
import { fetchShopAdmin } from './admin.ts';
import { OWN_PREFIX } from './catalog.ts';
import { MAX_PHOTOS, MAX_PRODUCTS, defaultSleep, fetchShop, getWithRetry, type Fetch, type ShopRead, type Sleep } from './fetch.ts';

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
const SAFE_HANDLE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const DEFAULT_TAGS = join(import.meta.dirname, '../../config/photo-tags.json');

// `signal` stops the read: checked between products and before each photo, and passed to every request.
export type IngestDeps = { fetch: Fetch; sleep: Sleep; tagsPath: string; maxImageBytes?: number; signal?: AbortSignal };

export { listBriefs } from './catalog.ts';

// Keeps downloadable images only; downloads the missing ones. Returns the product with usable images.
async function downloadImages(p: Product, dataDir: string, deps: IngestDeps): Promise<Product> {
  const root = resolve(dataDir);
  const kept: Product['images'] = [];
  if (p.images.length > MAX_PHOTOS) log.warn('ingest: photos dropped', { handle: p.handle, kept: MAX_PHOTOS, dropped: p.images.length - MAX_PHOTOS });
  for (const img of p.images.slice(0, MAX_PHOTOS)) {
    deps.signal?.throwIfAborted();
    const skip = (why: string) => log.warn('ingest: image skipped', { handle: p.handle, url: img.url, why });
    if (!img.url.startsWith('https://cdn.shopify.com/')) { skip('not a Shopify CDN url'); continue; }
    if (!SAFE_NAME.test(img.basename) || img.basename === '.' || img.basename === '..') { skip('unsafe file name'); continue; }
    const dest = resolve(root, 'assets', p.handle, img.basename);
    if (!dest.startsWith(root + sep)) { skip('outside data dir'); continue; }
    if (existsSync(dest) && statSync(dest).size > 0) { kept.push(img); continue; }
    const limit = deps.maxImageBytes ?? MAX_IMAGE_BYTES;
    const part = `${dest}.part-${process.pid}`;
    try {
      const res = await getWithRetry(img.url, deps.fetch, deps.sleep, deps.signal);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      if (!(res.headers.get('content-type') ?? '').startsWith('image/')) throw new Error('not an image');
      if (Number(res.headers.get('content-length') ?? 0) > limit) throw new Error('too large');
      mkdirSync(dirname(dest), { recursive: true });
      // Stream to a temporary file with a byte limit; only a complete file is renamed into place.
      let n = 0;
      const count = new Transform({ transform(chunk, _e, cb) { n += chunk.length; cb(n > limit ? new Error('too large') : null, chunk); } });
      await pipeline(Readable.fromWeb(res.body as never), count, createWriteStream(part));
      if (n === 0) throw new Error('empty');
      renameSync(part, dest);
      kept.push(img);
    } catch (e) {
      if (deps.signal?.aborted) throw e; // a stopped read must not store a brief with photos missing
      skip(`download failed: ${(e as Error).message}`);
    } finally {
      rmSync(part, { force: true });
    }
  }
  return { ...p, images: kept };
}

export type SyncResult = { briefs: Brief[]; added: number; updated: number; removed: string[]; empty?: true };

export async function ingest(db: Db, config: Config, now: Date, deps: IngestDeps): Promise<Brief[]> {
  return (await syncShop(db, config, now, deps)).briefs;
}

// Fetch, store, and drop the stored Shopify products the store no longer lists. Throws if the fetch fails,
// before anything is written. Products added on the Products page are never removed here.
// Every attempt leaves its outcome in `kv shop_sync_result` for the Products page.
export async function syncShop(db: Db, config: Config, now: Date, deps: IngestDeps): Promise<SyncResult> {
  const result = (v: { ok: boolean; added: number; updated: number; removed: number; error?: string }) => kvSet(db, 'shop_sync_result', JSON.stringify({ at: now.toISOString(), ...v }));
  try {
    const out = await readShop(db, config, now, deps);
    result(out.empty ? { ok: false, added: 0, updated: 0, removed: 0, error: 'the store returned no products; the stored products were kept' } : { ok: true, added: out.added, updated: out.updated, removed: out.removed.length });
    return out;
  } catch (e) {
    result({ ok: false, added: 0, updated: 0, removed: 0, error: scrub(String(e)) });
    throw e;
  }
}

// Hooks that cite a fact the new brief dropped or reworded no longer hold; they are retired.
function retireStaleHooks(db: Db, handle: string, oldJson: string, brief: Brief): void {
  let before: Brief;
  try { before = Brief.parse(JSON.parse(oldJson)); } catch { before = { ...brief, facts: [] }; } // unreadable old brief: every cited fact counts as changed
  const text = (b: Brief, id: string) => b.facts.find((f) => f.id === id)?.text;
  const hooks = db.prepare("SELECT id, fact_ids_json FROM hooks WHERE product_handle = ? AND status = 'active'").all(handle) as { id: number; fact_ids_json: string }[];
  const stale = hooks.filter((h) => (JSON.parse(h.fact_ids_json) as string[]).some((id) => text(brief, id) === undefined || text(brief, id) !== text(before, id)));
  for (const h of stale) db.prepare("UPDATE hooks SET status = 'retired' WHERE id = ?").run(h.id);
  if (stale.length) log.info('ingest: hooks retired, their facts changed', { handle, hooks: stale.length });
}

async function readShop(db: Db, config: Config, now: Date, deps: IngestDeps): Promise<SyncResult> {
  const shop = env.shop();
  if (!shop) throw new Error('ingest: SHOPIFY_SHOP is not set (e.g. my-store.myshopify.com)');
  const id = env.shopifyClientId();
  const secret = env.shopifyClientSecret();
  let shopData: ShopRead | undefined;
  if (id && secret) {
    try {
      shopData = await fetchShopAdmin(shop, id, secret, deps.fetch, deps.signal);
    } catch (e) {
      if (deps.signal?.aborted) throw e;
      log.warn('ingest: admin api failed, using the public feed', { error: (e as Error).message });
    }
  }
  const { meta, products, handles } = shopData ?? (await fetchShop(shop, deps.fetch, deps.sleep, deps.signal));
  const out: SyncResult = { briefs: [], added: 0, updated: 0, removed: [] };
  // An empty store is more likely a broken read than a real one: keep what is stored.
  if (!products.length) {
    log.warn('ingest: the store returned no products, keeping the stored ones');
    await alert(db, 'shop_empty', 'ingest', 'the store returned no products; the stored products were kept', now);
    return { ...out, empty: true };
  }
  const tagsText = existsSync(deps.tagsPath) ? readFileSync(deps.tagsPath, 'utf8') : null;
  if (products.length > MAX_PRODUCTS) {
    const total = handles?.length ?? products.length; // a lower bound when the handle list itself was cut short
    log.warn('ingest: products dropped', { kept: MAX_PRODUCTS, total });
    kvSet(db, 'shop_truncated', JSON.stringify({ at: now.toISOString(), total, kept: MAX_PRODUCTS }));
    await alert(db, 'shop_truncated', 'ingest', `the store lists ${handles ? total : `more than ${MAX_PRODUCTS}`} products; only the first ${MAX_PRODUCTS} get videos`, now);
  } else {
    db.prepare("DELETE FROM kv WHERE key = 'shop_truncated'").run();
  }
  for (const raw of products.slice(0, MAX_PRODUCTS)) {
    deps.signal?.throwIfAborted();
    if (!SAFE_HANDLE.test(raw.handle)) { log.warn('ingest: product skipped, unsafe handle', { handle: raw.handle }); continue; }
    // An owner product's handle space: a Shopify product there would overwrite or be deleted with it.
    if (raw.handle.startsWith(OWN_PREFIX)) { log.warn('ingest: product skipped, reserved prefix', { handle: raw.handle }); continue; }
    const n = normalize(raw, shop);
    const p = await downloadImages(n, env.dataDir(), deps);
    const brief = buildBrief(p, meta, config, tagsText);
    const at = now.toISOString();
    db.prepare(
      `INSERT INTO products (handle, title, updated_at, raw_json, fetched_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(handle) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at, raw_json = excluded.raw_json, fetched_at = excluded.fetched_at`,
    ).run(p.handle, p.title, p.updatedAt, JSON.stringify({ ...p, imagesSkipped: Math.min(n.images.length, MAX_PHOTOS) - p.images.length }), at); // imagesSkipped: the Products page says why a photo is missing
    const old = db.prepare('SELECT source_hash, json FROM briefs WHERE handle = ?').get(p.handle) as { source_hash: string; json: string } | undefined;
    const changed = old?.source_hash !== brief.sourceHash;
    if (changed) {
      db.prepare(
        `INSERT INTO briefs (handle, source_hash, json, built_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(handle) DO UPDATE SET source_hash = excluded.source_hash, json = excluded.json, built_at = excluded.built_at`,
      ).run(p.handle, brief.sourceHash, JSON.stringify(brief), at);
      if (old) {
        out.updated++;
        retireStaleHooks(db, p.handle, old.json, brief);
      } else out.added++;
    }
    log.info(`ingest: ${p.handle}: ${brief.facts.length} facts, ${brief.shots.length} shots, ${brief.disclosures.length} disclosures, brief ${changed ? (old ? 'updated' : 'created') : 'unchanged'}`);
    out.briefs.push(brief);
  }
  deps.signal?.throwIfAborted();
  if (!handles) {
    log.warn('ingest: the product list may be incomplete, nothing removed');
  } else {
    // Slots already made keep their stored master; a removed product is only no longer picked for new slots.
    const listed = new Set([...handles, ...products.map((p) => p.handle)]);
    const stored = db.prepare(`SELECT handle FROM products WHERE handle NOT LIKE '${OWN_PREFIX}%' AND handle NOT IN (SELECT handle FROM owner_products)`).all() as { handle: string }[];
    out.removed = stored.map((r) => r.handle).filter((h) => !listed.has(h));
    if (out.removed.length) {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const h of out.removed) {
          db.prepare('DELETE FROM briefs WHERE handle = ?').run(h);
          db.prepare('DELETE FROM products WHERE handle = ?').run(h);
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      log.info('ingest: products no longer in the store removed', { handles: out.removed });
    }
  }
  kvSet(db, 'shop_synced_at', now.toISOString());
  return out;
}

// Fetch, download, build and store. Throws if the fetch fails; the caller keeps the last stored brief.
export async function runIngest(db: Db, config: Config, now: Date, opts: { print: boolean; signal?: AbortSignal }): Promise<SyncResult> {
  const r = await syncShop(db, config, now, { fetch, sleep: defaultSleep, tagsPath: DEFAULT_TAGS, signal: opts.signal });
  if (opts.print) process.stdout.write(JSON.stringify(r.briefs, null, 2) + '\n');
  return r;
}

export const INGEST_EVERY_MS = 3600_000;

// At most hourly, or sooner (at least 60 s after the last attempt) when the admin asked (`kv ingest_requested`
// newer than the last attempt), under an overall deadline; called by the scheduler tick (not awaited) and by the producer. At the deadline the read is
// aborted, so nothing keeps running. A failure alerts (the alert itself is rate-limited) and keeps the stored
// briefs; the next try is an hour later. `signal` (the producer's SIGTERM) also stops the read, without an alert.
export async function ensureIngest(db: Db, now: Date, d: { ingest: (now: Date, signal: AbortSignal) => Promise<unknown>; ingestDeadlineMs: number; signal?: AbortSignal }): Promise<void> {
  const last = kvGet(db, 'ingest_at');
  const asked = kvGet(db, 'ingest_requested');
  const requested = !!asked && (!last || Date.parse(asked) > Date.parse(last));
  // A request still waits 60 s after the last attempt, so repeated presses do not hammer the store.
  if (last && now.getTime() - Date.parse(last) < (requested ? 60_000 : INGEST_EVERY_MS)) return;
  // The attempt time, claimed first and atomically: of the two processes (tick and producer) only one wins the read.
  const at = now.toISOString();
  const claim = last === undefined
    ? db.prepare("INSERT INTO kv (key, value) VALUES ('ingest_at', ?) ON CONFLICT(key) DO NOTHING").run(at)
    : db.prepare("UPDATE kv SET value = ? WHERE key = 'ingest_at' AND value IS ?").run(at, last);
  if (claim.changes !== 1) return;
  const ctrl = new AbortController();
  const signal = d.signal ? AbortSignal.any([ctrl.signal, d.signal]) : ctrl.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, rej) => (timer = setTimeout(() => { const e = new Error('ingest deadline exceeded'); ctrl.abort(e); rej(e); }, d.ingestDeadlineMs)));
    await Promise.race([d.ingest(now, signal), deadline]);
  } catch (e) {
    if (d.signal?.aborted) return;
    await alert(db, 'ingest_failed', 'ingest', `ingest failed, using the stored brief: ${e}`, now);
  } finally {
    clearTimeout(timer);
  }
}
