// Shapes shared between modules. A change here is a change to a contract: update every user of it
// in the same commit.
import { z } from 'zod';

export const PLATFORMS = ['youtube', 'facebook', 'instagram', 'tiktok'] as const;
export const Platform = z.enum(PLATFORMS);
export type Platform = z.infer<typeof Platform>;

// A region of a source image, in fractions of its width and height, origin top-left.
export const Rect = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().gt(0).max(1),
  h: z.number().gt(0).max(1),
});
export type Rect = z.infer<typeof Rect>;

// One usable picture: a product photo, or a text-free region of one.
export const Shot = z.object({
  id: z.string(), // unique within a brief, e.g. "model-beige"
  file: z.string(), // path relative to DATA_DIR
  width: z.number().int().positive(), // source image size in pixels, before cropping
  height: z.number().int().positive(),
  kind: z.enum(['product', 'lifestyle', 'clip']),
  variant: z.string().nullable(), // colour shown, when one is
  crop: Rect.nullable(), // null means the whole image
  note: z.string(), // what it shows, for the script writer
});
export type Shot = z.infer<typeof Shot>;

// Everything the creative steps may know about the product. Built from Shopify data only.
export const Brief = z.object({
  version: z.literal(1),
  sourceHash: z.string(),
  shop: z.object({ name: z.string(), domain: z.string(), currency: z.string(), shipsTo: z.array(z.string()) }),
  product: z.object({
    handle: z.string(),
    title: z.string(),
    url: z.string(),
    type: z.string(),
    priceText: z.string(), // exactly as it must appear on screen, e.g. "$49.99"
    colors: z.array(z.string()),
  }),
  facts: z.array(z.object({ id: z.string(), text: z.string(), source: z.string() })), // the only allowed claims
  disclosures: z.array(z.string()), // must appear on the end card and in every caption
  angles: z.array(z.string()), // from tags; they steer the hook and are never stated as claims
  shots: z.array(Shot),
  rules: z.object({ discountClaims: z.boolean(), reviewClaims: z.boolean(), claimsFromPhotos: z.boolean() }),
});
export type Brief = z.infer<typeof Brief>;

export const BEATS = ['hook', 'benefit', 'offer', 'cta'] as const;

// What the script writer (a model, or a fixture) returns. `say` is spoken; `show` is the caption for
// the same moment ("forty-nine ninety-nine" / "$49.99").
export const Script = z.object({
  hook: z.object({ framework: z.string(), headline: z.string() }), // headline = the on-screen hook text
  beats: z
    .array(
      z.object({
        kind: z.enum(BEATS),
        chunks: z.array(z.object({ say: z.string().min(1), show: z.string().min(1) })).min(1),
        shotIds: z.array(z.string()).min(1),
        factIds: z.array(z.string()),
      }),
    )
    .length(4), // one per BEATS entry, in that order
});
export type Script = z.infer<typeof Script>;

const Ms = z.number().int().min(0);
const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const TEMPLATES = ['kinetic-bold', 'cozy-soft', 'gift-guide'] as const;
export const MOTIONS = ['push-in', 'pull-out', 'pan-left', 'pan-right', 'still'] as const;

// The master edit for one slot. Every platform render is made from this and nothing else.
// File paths are absolute; the renderer stages them and rewrites them before the template sees them.
export const Edl = z.object({
  version: z.literal(1),
  slotId: z.string(),
  template: z.enum(TEMPLATES),
  palette: z.object({ bg: Hex, ink: Hex, accent: Hex, plate: Hex }),
  durationMs: z.number().int().min(14000).max(16000),
  headline: z.string(),
  beats: z
    .array(
      z.object({
        kind: z.enum(BEATS),
        startMs: Ms,
        endMs: Ms,
        shots: z
          .array(z.object({ src: z.string(), width: z.number().int().positive(), height: z.number().int().positive(), crop: Rect.nullable(), kind: Shot.shape.kind, startMs: Ms, endMs: Ms, motion: z.enum(MOTIONS) }))
          .min(1),
      }),
    )
    .length(4),
  captions: z.array(z.object({ startMs: Ms, endMs: Ms, words: z.array(z.object({ text: z.string(), startMs: Ms, endMs: Ms })).min(1) })),
  endCard: z.object({
    title: z.string(),
    priceText: z.string(),
    shopName: z.string(),
    shopDomain: z.string(),
    disclosures: z.array(z.string()),
    shotSrc: z.string(),
    shotWidth: z.number().int().positive(),
    shotHeight: z.number().int().positive(),
    shotCrop: Rect.nullable(),
  }),
  audio: z.object({ voiceSrc: z.string(), musicSrc: z.string().nullable(), musicGainDb: z.number().max(0) }),
  ai: z.object({ visuals: z.boolean(), voice: z.boolean(), music: z.boolean() }), // drives the disclosure flags
});
export type Edl = z.infer<typeof Edl>;

// Pixels kept clear of text on each edge of the 1080x1920 frame.
export const SafeZone = z.object({ top: Ms, bottom: Ms, left: Ms, right: Ms });
export type SafeZone = z.infer<typeof SafeZone>;

// What a template receives. The only things that differ between the four renders of one slot.
export const RenderProps = z.object({ edl: Edl, platform: Platform, safe: SafeZone, cta: z.string() });
export type RenderProps = z.infer<typeof RenderProps>;

export const FRAME = { width: 1080, height: 1920, fps: 30 } as const;
