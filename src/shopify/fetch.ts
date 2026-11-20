import { z } from 'zod';
import { log } from '../ops/log.ts';

// Public storefront endpoints. Admin API mode is in admin.ts (D-12).
export type Fetch = typeof fetch;
export type Sleep = (ms: number) => Promise<void>;

export const MAX_PRODUCTS = 20;
export const MAX_PHOTOS = 20;

const MAX_TRIES = 4;
const BACKOFF_MS = [5_000, 15_000, 45_000];
const MAX_WAIT_MS = 90_000;

export const defaultSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Each request's 20 s timeout, combined with the caller's signal when there is one.
export const withTimeout = (signal?: AbortSignal) => (signal ? AbortSignal.any([AbortSignal.timeout(20_000), signal]) : AbortSignal.timeout(20_000));

// GET with a 20 s timeout. Retries 429 and 5xx; returns the final response (caller checks ok).
export async function getWithRetry(url: string, f: Fetch, sleep: Sleep, signal?: AbortSignal): Promise<Response> {
  for (let i = 1; ; i++) {
    signal?.throwIfAborted();
    const res = await f(url, { signal: withTimeout(signal) });
    if (res.status !== 429 && res.status < 500) return res;
    if (i >= MAX_TRIES) throw new Error(`GET ${url} failed: HTTP ${res.status} after ${MAX_TRIES} tries`);
    await res.body?.cancel();
    const ra = Number(res.headers.get('retry-after'));
    const waitMs = Math.min(res.headers.has('retry-after') && Number.isFinite(ra) && ra >= 0 ? ra * 1000 : BACKOFF_MS[i - 1], MAX_WAIT_MS);
    log.warn('fetch: retrying', { url, status: res.status, attempt: i, waitMs });
    await sleep(waitMs);
  }
}

async function getJson<T>(url: string, schema: z.ZodType<T>, f: Fetch, sleep: Sleep, signal?: AbortSignal): Promise<T> {
  const res = await getWithRetry(url, f, sleep, signal);
  if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}`);
  const r = schema.safeParse(await res.json());
  if (!r.success) throw new Error(`GET ${url}: unexpected response: ${r.error.message}`);
  return r.data;
}

const Meta = z.object({
  name: z.string(),
  currency: z.string(),
  domain: z.string(),
  ships_to_countries: z.array(z.string()).default([]),
});
export type ShopMeta = z.infer<typeof Meta>;

const RawProduct = z.object({
  title: z.string(),
  handle: z.string(),
  body_html: z.string().nullable().default(''),
  updated_at: z.string(),
  vendor: z.string().default(''),
  product_type: z.string().default(''),
  tags: z.union([z.array(z.string()), z.string()]).default([]),
  options: z.array(z.object({ name: z.string(), values: z.array(z.string()) })).default([]),
  variants: z.array(z.object({ title: z.string(), price: z.string(), compare_at_price: z.string().nullable().default(null), available: z.boolean().default(true) })),
  images: z.array(z.object({ src: z.string(), width: z.number().int().positive(), height: z.number().int().positive() })).default([]),
});
export type RawProduct = z.infer<typeof RawProduct>;
export const Products = z.object({ products: z.array(RawProduct) });

// `handles` is every listed product's handle, or null when the list may go on past the last page read.
export type ShopRead = { meta: ShopMeta; products: RawProduct[]; handles: string[] | null };

export async function fetchShop(shop: string, f: Fetch, sleep: Sleep, signal?: AbortSignal): Promise<ShopRead> {
  const meta = await getJson(`https://${shop}/meta.json`, Meta, f, sleep, signal);
  const products: RawProduct[] = [];
  let complete = false;
  for (let page = 1; page <= 4; page++) {
    const url = `https://${shop}/products.json?limit=250` + (page > 1 ? `&page=${page}` : '');
    const got = (await getJson(url, Products, f, sleep, signal)).products;
    products.push(...got);
    if (got.length < 250) { complete = true; break; }
  }
  return { meta, products, handles: complete ? products.map((p) => p.handle) : null };
}
