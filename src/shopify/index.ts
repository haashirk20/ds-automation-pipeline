import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { Transform } from 'node:stream';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Brief } from '../contracts.ts';
import { env, type Config } from '../config/index.ts';
import type { Db } from '../db/index.ts';
import { log } from '../ops/log.ts';
import { buildBrief, normalize, type Product } from './brief.ts';
import { defaultSleep, fetchShop, getWithRetry, type Fetch, type Sleep } from './fetch.ts';

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_PRODUCTS = 20;
export const MAX_PHOTOS = 20;
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
const SAFE_HANDLE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const DEFAULT_TAGS = join(import.meta.dirname, '../../config/photo-tags.json');

export type IngestDeps = { fetch: Fetch; sleep: Sleep; tagsPath: string; maxImageBytes?: number };

export function listBriefs(db: Db): Brief[] {
  return (db.prepare('SELECT json FROM briefs ORDER BY handle').all() as { json: string }[]).map((r) => Brief.parse(JSON.parse(r.json)));
}

// Keeps downloadable images only; downloads the missing ones. Returns the product with usable images.
async function downloadImages(p: Product, dataDir: string, deps: IngestDeps): Promise<Product> {
  const root = resolve(dataDir);
  const kept: Product['images'] = [];
  if (p.images.length > MAX_PHOTOS) log.warn('ingest: photos dropped', { handle: p.handle, kept: MAX_PHOTOS, dropped: p.images.length - MAX_PHOTOS });
  for (const img of p.images.slice(0, MAX_PHOTOS)) {
    const skip = (why: string) => log.warn('ingest: image skipped', { handle: p.handle, url: img.url, why });
    if (!img.url.startsWith('https://cdn.shopify.com/')) { skip('not a Shopify CDN url'); continue; }
    if (!SAFE_NAME.test(img.basename) || img.basename === '.' || img.basename === '..') { skip('unsafe file name'); continue; }
    const dest = resolve(root, 'assets', p.handle, img.basename);
    if (!dest.startsWith(root + sep)) { skip('outside data dir'); continue; }
    if (existsSync(dest) && statSync(dest).size > 0) { kept.push(img); continue; }
    const limit = deps.maxImageBytes ?? MAX_IMAGE_BYTES;
    const part = `${dest}.part-${process.pid}`;
    try {
      const res = await getWithRetry(img.url, deps.fetch, deps.sleep);
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
      skip(`download failed: ${(e as Error).message}`);
    } finally {
      rmSync(part, { force: true });
    }
  }
  return { ...p, images: kept };
}

export async function ingest(db: Db, config: Config, now: Date, deps: IngestDeps): Promise<Brief[]> {
  const shop = env.shop();
  if (!shop) throw new Error('ingest: SHOPIFY_SHOP is not set (e.g. my-store.myshopify.com)');
  const { meta, products } = await fetchShop(shop, deps.fetch, deps.sleep);
  const tagsText = existsSync(deps.tagsPath) ? readFileSync(deps.tagsPath, 'utf8') : null;
  const briefs: Brief[] = [];
  if (products.length > MAX_PRODUCTS) log.warn('ingest: products dropped', { kept: MAX_PRODUCTS, dropped: products.length - MAX_PRODUCTS });
  for (const raw of products.slice(0, MAX_PRODUCTS)) {
    if (!SAFE_HANDLE.test(raw.handle)) { log.warn('ingest: product skipped, unsafe handle', { handle: raw.handle }); continue; }
    const p = await downloadImages(normalize(raw, shop), env.dataDir(), deps);
    const brief = buildBrief(p, meta, config, tagsText);
    const at = now.toISOString();
    db.prepare(
      `INSERT INTO products (handle, title, updated_at, raw_json, fetched_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(handle) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at, raw_json = excluded.raw_json, fetched_at = excluded.fetched_at`,
    ).run(p.handle, p.title, p.updatedAt, JSON.stringify(p), at);
    const old = db.prepare('SELECT source_hash FROM briefs WHERE handle = ?').get(p.handle) as { source_hash: string } | undefined;
    const changed = old?.source_hash !== brief.sourceHash;
    if (changed) {
      db.prepare(
        `INSERT INTO briefs (handle, source_hash, json, built_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(handle) DO UPDATE SET source_hash = excluded.source_hash, json = excluded.json, built_at = excluded.built_at`,
      ).run(p.handle, brief.sourceHash, JSON.stringify(brief), at);
    }
    log.info(`ingest: ${p.handle}: ${brief.facts.length} facts, ${brief.shots.length} shots, ${brief.disclosures.length} disclosures, brief ${changed ? (old ? 'updated' : 'created') : 'unchanged'}`);
    briefs.push(brief);
  }
  return briefs;
}

// Fetch, download, build and store. Throws if the fetch fails; the caller keeps the last stored brief.
export async function runIngest(db: Db, config: Config, now: Date, opts: { print: boolean }): Promise<void> {
  const briefs = await ingest(db, config, now, { fetch, sleep: defaultSleep, tagsPath: DEFAULT_TAGS });
  if (opts.print) process.stdout.write(JSON.stringify(briefs, null, 2) + '\n');
}
