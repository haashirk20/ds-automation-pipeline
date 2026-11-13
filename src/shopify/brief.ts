import { createHash } from 'node:crypto';
import { z } from 'zod';
import { log } from '../ops/log.ts';
import { Brief, Shot } from '../contracts.ts';
import type { Config } from '../config/index.ts';
import type { RawProduct, ShopMeta } from './fetch.ts';

export type Product = {
  handle: string;
  title: string;
  productType: string;
  vendor: string;
  tags: string[];
  updatedAt: string;
  descriptionLines: string[];
  url: string;
  options: { name: string; values: string[] }[];
  variants: { title: string; price: number; compareAtPrice: number | null; available: boolean }[];
  images: { url: string; width: number; height: number; basename: string }[];
};

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|nbsp);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k in ENTITIES) return ENTITIES[k];
    const n = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
  });

export function descriptionLines(html: string): string[] {
  return decode(html.replace(/<br\s*\/?>|<\/(p|li|div)>/gi, '\n').replace(/<[^>]*>/g, ''))
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l && !/^[^:]*:$/.test(l));
}

export const MAX_LINES = 40;
export const MAX_LINE_CHARS = 300;
// At most 40 description lines of at most 300 characters; what is dropped is logged.
export function limitLines(lines: string[], handle: string): string[] {
  const short = lines.filter((l) => l.length <= MAX_LINE_CHARS);
  const out = short.slice(0, MAX_LINES);
  if (out.length < lines.length) log.warn('ingest: description lines dropped', { handle, tooLong: lines.length - short.length, overLimit: short.length - out.length });
  return out;
}

export function imageBasename(url: string): string {
  return url.split('?')[0].split('#')[0].split('/').pop() ?? '';
}

export function normalize(raw: RawProduct, shop: string): Product {
  return {
    handle: raw.handle,
    title: raw.title,
    productType: raw.product_type,
    vendor: raw.vendor,
    tags: Array.isArray(raw.tags) ? raw.tags : raw.tags.split(',').map((t) => t.trim()).filter(Boolean),
    updatedAt: raw.updated_at,
    descriptionLines: limitLines(descriptionLines(raw.body_html ?? ''), raw.handle),
    url: `https://${shop}/products/${raw.handle}`,
    options: raw.options.map((o) => ({ name: o.name, values: o.values })),
    variants: raw.variants.map((v) => ({ title: v.title, price: Number(v.price), compareAtPrice: v.compare_at_price == null ? null : Number(v.compare_at_price), available: v.available })),
    images: raw.images.map((i) => ({ url: i.src, width: i.width, height: i.height, basename: imageBasename(i.src) })),
  };
}

const SYMBOLS: Record<string, string> = { CAD: '$', USD: '$', AUD: '$', EUR: '€', GBP: '£' };

export function priceText(p: Product, currency: string): string {
  const prices = p.variants.map((v) => v.price);
  const low = Math.min(...prices);
  const text = (SYMBOLS[currency] ?? currency + ' ') + low.toFixed(2);
  return prices.some((x) => x !== low) ? `from ${text}` : text;
}

// Keys are photo basenames; "_about" is a note for humans.
const PhotoTags = z.record(z.string(), z.unknown()).transform((r) => {
  const { _about, ...rest } = r;
  return z.record(z.string(), z.object({ shots: z.array(Shot.omit({ file: true, width: true, height: true })) })).parse(rest);
});
export function parsePhotoTags(text: string | null) {
  return text === null ? {} : PhotoTags.parse(JSON.parse(text));
}

const CLAIM_TAG = /best.?sell|top.?rated|award|#\s?1|number one|guarantee/i;
const DISCLOSURE = /not included|sold separately|batter(y|ies) (not included|required)|requires? |choking hazard|warning|caution|keep away|not suitable|ages? \d+ ?(and up|\+)/i;

export function buildBrief(p: Product, shop: ShopMeta, config: Config, tagsText: string | null): Brief {
  const tags = parsePhotoTags(tagsText);
  const price = priceText(p, shop.currency);
  const colorOpt = p.options.find((o) => /colou?r/i.test(o.name));
  const facts: Brief['facts'] = [{ id: 'f-title', text: p.title, source: 'title' }];
  if (p.productType) facts.push({ id: 'f-type', text: p.productType, source: 'product_type' });
  facts.push({ id: 'f-price', text: `Price: ${price} ${shop.currency}`, source: 'variants.price' });
  for (const o of p.options) {
    facts.push({ id: `f-option-${o.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`, text: `${o.name}: ${o.values.join(', ')}`, source: 'options' });
  }
  p.descriptionLines.forEach((l, i) => facts.push({ id: `f-desc-${i + 1}`, text: l, source: 'body_html' }));
  if (shop.ships_to_countries.length) facts.push({ id: 'f-ships', text: `Ships to: ${shop.ships_to_countries.join(', ')}`, source: 'meta.json' });

  const shots: Shot[] = [];
  p.images.forEach((img, index) => {
    const file = `assets/${p.handle}/${img.basename}`;
    const entry = tags[img.basename];
    const mine = entry
      ? entry.shots.map((s) => ({ ...s, file, width: img.width, height: img.height }))
      : [{ id: `photo-${index}`, file, width: img.width, height: img.height, kind: 'product' as const, variant: null, crop: null, note: '' }];
    shots.push(...mine);
  });
  const ids = new Set<string>();
  for (const s of shots) {
    if (ids.has(s.id)) throw new Error(`duplicate shot id "${s.id}" for ${p.handle}`);
    ids.add(s.id);
  }

  const sourceHash = createHash('sha256').update(JSON.stringify([p, shop, tagsText, config.brand])).digest('hex');
  return Brief.parse({
    version: 1,
    sourceHash,
    shop: { name: config.brand.name ?? shop.name, domain: shop.domain, currency: shop.currency, shipsTo: shop.ships_to_countries },
    product: { handle: p.handle, title: p.title, url: p.url, type: p.productType, priceText: price, colors: colorOpt?.values ?? [] },
    facts,
    disclosures: p.descriptionLines.filter((l) => DISCLOSURE.test(l)),
    angles: p.tags.map((t) => t.toLowerCase()).filter((t) => !CLAIM_TAG.test(t)),
    shots,
    rules: {
      discountClaims: p.variants.some((v) => v.compareAtPrice !== null && v.compareAtPrice > v.price),
      reviewClaims: false,
    },
  });
}
