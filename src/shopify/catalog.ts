// The product catalog beyond the Shopify feed: products the owner adds by hand, which products get videos,
// and the uploaded logo. Read by the producer and written by the admin.
import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Brief } from '../contracts.ts';
import { env, type Config } from '../config/index.ts';
import { kvGet, type Db } from '../db/index.ts';
import { alert } from '../ops/alert.ts';

export const OWN_PREFIX = 'own-';
export const SAFE_HANDLE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SYMBOLS: Record<string, string> = { CAD: '$', USD: '$', AUD: '$', EUR: '€', GBP: '£' };

// What the owner types in. Every line of `facts` is a statement the ads may make; nothing else may be claimed.
export const OwnerProduct = z.object({
  title: z.string().trim().min(2).max(120),
  type: z.string().trim().max(60),
  price: z.number().positive().max(100_000),
  currency: z.string().regex(/^[A-Z]{3}$/),
  url: z.string().trim().max(300).refine((u) => u === '' || /^https:\/\/[^\s<>"]+$/.test(u), 'must be an https:// link or empty'),
  colors: z.array(z.string().trim().min(1).max(40)).max(12),
  facts: z.array(z.string().trim().min(3).max(300)).min(1).max(40),
  disclosures: z.array(z.string().trim().min(3).max(300)).max(10),
  photos: z.array(z.object({ file: z.string(), width: z.number().int().positive(), height: z.number().int().positive() })).min(1).max(8),
});
export type OwnerProduct = z.infer<typeof OwnerProduct>;

export function slugHandle(title: string): string {
  const s = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  return OWN_PREFIX + (s || 'product');
}

export function priceLabel(price: number, currency: string): string {
  return (SYMBOLS[currency] ?? currency + ' ') + price.toFixed(2);
}

// The shop part of a brief: the newest Shopify brief's, or the brand name with no domain.
export function shopOf(db: Db, config: Config, currency: string): Brief['shop'] {
  const r = db.prepare(`SELECT json FROM briefs WHERE handle NOT LIKE '${OWN_PREFIX}%' ORDER BY built_at DESC LIMIT 1`).get() as { json: string } | undefined;
  if (r) {
    try {
      return { ...Brief.parse(JSON.parse(r.json)).shop, currency };
    } catch { /* fall through */ }
  }
  return { name: config.brand.name ?? 'Our shop', domain: '', currency, shipsTo: [] };
}

// Same shape as a Shopify brief. The facts come from the owner's lines; tags and discounts do not exist here.
export function ownerBrief(handle: string, p: OwnerProduct, shop: Brief['shop']): Brief {
  const price = priceLabel(p.price, p.currency);
  const facts: Brief['facts'] = [{ id: 'f-title', text: p.title, source: 'owner' }];
  if (p.type) facts.push({ id: 'f-type', text: p.type, source: 'owner' });
  facts.push({ id: 'f-price', text: `Price: ${price} ${p.currency}`, source: 'owner' });
  if (p.colors.length) facts.push({ id: 'f-option-color', text: `Color: ${p.colors.join(', ')}`, source: 'owner' });
  p.facts.forEach((l, i) => facts.push({ id: `f-desc-${i + 1}`, text: l, source: 'owner' }));
  if (shop.shipsTo.length) facts.push({ id: 'f-ships', text: `Ships to: ${shop.shipsTo.join(', ')}`, source: 'meta.json' });
  const shots = p.photos.map((ph, i) => ({ id: `photo-${i}`, file: ph.file, width: ph.width, height: ph.height, kind: 'product' as const, variant: null, crop: null, note: '' }));
  const body = { handle, p, shop };
  return Brief.parse({
    version: 1,
    sourceHash: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    shop,
    product: { handle, title: p.title, url: p.url, type: p.type, priceText: price, colors: p.colors },
    facts,
    disclosures: p.disclosures,
    angles: [],
    shots,
    rules: { discountClaims: false, reviewClaims: false },
  });
}

// null = every stored product takes a turn (the behaviour before the selection existed).
export function activeHandles(db: Db): string[] | null {
  const v = kvGet(db, 'products_active');
  if (!v) return null;
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) && a.every((h) => typeof h === 'string') ? a : null;
  } catch {
    return null;
  }
}

// The ticked products, in handle order. A selection that matches nothing stored (a product left the store)
// falls back to every product, so the line never stops because of a stale tick.
export function selectBriefs<T extends { product: { handle: string } }>(briefs: T[], active: string[] | null): T[] {
  if (!active) return briefs;
  const picked = briefs.filter((b) => active.includes(b.product.handle));
  return picked.length ? picked : briefs;
}

export function listBriefs(db: Db): Brief[] {
  return (db.prepare('SELECT json FROM briefs ORDER BY handle').all() as { json: string }[]).map((r) => Brief.parse(JSON.parse(r.json)));
}

// The store could not be read and there is no stored brief: the slot goes back to 'planned'.
export class NoBriefError extends Error {}

// The products chosen per daily post on the Products page: {"1": [handles], "2": [handles]}. A malformed value is ignored.
export function slotProducts(db: Db): Record<string, string[]> {
  const v = kvGet(db, 'slot_products');
  if (!v) return {};
  try {
    const o = JSON.parse(v);
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
    return Object.fromEntries(Object.entries(o).filter(([k, a]) => /^\d+$/.test(k) && Array.isArray(a) && a.every((h) => typeof h === 'string'))) as Record<string, string[]>;
  } catch {
    return {};
  }
}

// Pure. A post with its own products takes turns among them by `turn` (earlier slots with the same index);
// a post with none, or whose products are all gone, uses the general pool by `ordinal` (every earlier slot).
// A post with no stored choice uses the "Any post" products, else the products chosen for any post, else every
// product, so a "Not used" product only runs when nothing chosen is left in the store.
export function chooseBrief<T extends { product: { handle: string } }>(briefs: T[], active: string[] | null, postList: string[], turn: number, ordinal: number, assigned: string[] = []): T | undefined {
  const own = briefs.filter((b) => postList.includes(b.product.handle));
  if (own.length) return own[turn % own.length];
  const of = (hs: string[] | null) => (hs ? briefs.filter((b) => hs.includes(b.product.handle)) : []);
  const pool = [of(active), of(assigned)].find((p) => p.length) ?? briefs;
  return pool[ordinal % pool.length];
}

// The brief a slot uses. The producer and the Products page preview both call this. Manual slots use the pool.
export function pickBrief(db: Db, slot: { local_date: string; idx: number; kind: string }): Brief {
  const postList = slot.kind === 'planned' ? (slotProducts(db)[String(slot.idx)] ?? []) : [];
  const count = (sql: string, ...a: (string | number)[]) => (db.prepare(`SELECT COUNT(*) AS n FROM slots WHERE ${sql}`).get(...a) as { n: number }).n;
  const turn = count('idx = ? AND local_date < ?', slot.idx, slot.local_date);
  const ordinal = count('local_date < ? OR (local_date = ? AND idx < ?)', slot.local_date, slot.local_date, slot.idx);
  const b = chooseBrief(listBriefs(db), activeHandles(db), postList, turn, ordinal, Object.values(slotProducts(db)).flat());
  if (!b) throw new NoBriefError('no product brief and the store could not be read');
  return b;
}

// Each non-empty choice whose handles match no stored brief: a daily post's list (post = its index) or the
// ticked products (post null). pickBrief falls back to the pool for these; the owner should fix the choice.
export function staleSelections(db: Db): { post: number | null; handles: string[] }[] {
  const have = new Set((db.prepare('SELECT handle FROM briefs').all() as { handle: string }[]).map((r) => r.handle));
  const stale = (hs: string[]) => hs.length > 0 && !hs.some((h) => have.has(h));
  const out: { post: number | null; handles: string[] }[] = Object.entries(slotProducts(db)).filter(([, hs]) => stale(hs)).map(([k, hs]) => ({ post: Number(k), handles: hs }));
  const active = activeHandles(db);
  if (active && stale(active)) out.push({ post: null, handles: active });
  return out;
}

// After pickBrief: alerts (rate-limited per choice) when this slot's post list or the ticked products are stale.
export async function alertStaleSelection(db: Db, slot: { id: string; idx: number; kind: string }, picked: string, now: Date): Promise<void> {
  for (const s of staleSelections(db)) {
    if (s.post !== null && (slot.kind !== 'planned' || s.post !== slot.idx)) continue;
    const what = s.post === null ? 'the ticked products' : `daily post ${s.post}`;
    await alert(db, 'selection_stale', s.post === null ? 'active' : `post-${s.post}`, `${what} ${s.post === null ? 'name' : 'names'} only products that are no longer stored (${s.handles.slice(0, 5).join(', ')}); ${slot.id} uses ${picked} instead. Choose again on the Products page.`, now);
  }
}

export const LOGO_DIR = 'brand';
const LOGO_FILE = /^brand\/logo-[0-9a-f]{64}\.png$/;

// The logo file to send to the video model: the uploaded one when set and present, else the file's.
export function brandLogoFile(db: Db, config: Config, root: string): string | null {
  const v = kvGet(db, 'brand_logo');
  if (v && LOGO_FILE.test(v)) {
    const data = path.resolve(env.dataDir());
    const f = path.resolve(data, v);
    try {
      if (existsSync(f) && realpathSync(f).startsWith(realpathSync(data) + path.sep) && statSync(f).isFile()) return f;
    } catch { /* fall back to the file logo */ }
  }
  return config.brand.logo ? path.resolve(root, config.brand.logo) : null;
}
export const isLogoKey = (v: string) => LOGO_FILE.test(v);
