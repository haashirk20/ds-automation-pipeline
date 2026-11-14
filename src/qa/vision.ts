// The vision check on a generated clip. One model call; the verdict is decided here, not by the model.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { z } from 'zod';
import type { Brief, UgcConcept } from '../contracts.ts';
import type { Config } from '../config/index.ts';
import type { Db } from '../db/index.ts';
import { productLook } from '../creative/ugc.ts';
import { callJson } from '../llm/client.ts';
import { systemPrompt } from '../llm/prompts.ts';
import { ff } from '../render/ffmpeg.ts';

const Writing = z.object({ text: z.string(), kind: z.enum(['overlay', 'prominent', 'background']) });
export const VisionVerdict = z.object({ productVisible: z.boolean(), productMatches: z.boolean(), writing: z.array(Writing), brandMisspelled: z.boolean(), bodyGlitch: z.boolean(), reason: z.string() });

// Letters and digits only, lower case, no spaces, without a leading "the": "The Merry Marts" is the shop "Merry Marts".
const plain = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/^the /, '').replace(/ /g, '');

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

// n JPEG frames, FRAME_W x FRAME_H, evenly spaced from 1 s in to 1 s before the end.
const FRAME_W = 720;
const FRAME_H = 1280;
const FRAME_COUNT = 8; // 6 frames missed a misspelling that showed for about two seconds
const EFFORT = 'low' as const;

async function defaultFrames(file: string, n: number): Promise<Buffer[]> {
  const probe = await ff('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  const dur = Number(probe.stdout.toString().trim());
  if (!(dur > 0)) throw new Error(`cannot read the duration of ${file}`);
  const lo = Math.min(1, dur / 2);
  const hi = Math.max(lo, dur - 1);
  const dir = mkdtempSync(join(tmpdir(), 'vision-'));
  try {
    const out: Buffer[] = [];
    for (let i = 0; i < n; i++) {
      const t = lo + ((hi - lo) * i) / (n - 1);
      const f = join(dir, `${i}.jpg`);
      await ff('ffmpeg', ['-y', '-v', 'error', '-ss', t.toFixed(2), '-i', file, '-frames:v', '1', '-vf', `scale=${FRAME_W}:${FRAME_H}`, '-q:v', '4', f]);
      out.push(readFileSync(f));
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const image = (file: string) => ({ mediaType: (extname(file).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg') as 'image/png' | 'image/jpeg', data: readFileSync(file).toString('base64') });

export async function checkClip(
  db: Db,
  config: Config,
  input: { clipFile: string; refImages: string[]; brief: Brief; concept: UgcConcept },
  now: Date,
  slotId: string,
  deps: { frames?: (file: string, n: number) => Promise<Buffer[]> } = {},
): Promise<{ pass: boolean; problems: string[]; verdict: z.infer<typeof VisionVerdict> }> {
  const { brief, concept } = input;
  const frames = await (deps.frames ?? defaultFrames)(input.clipFile, FRAME_COUNT);
  const refs = input.refImages.map(image);
  const look = productLook(brief.product.handle);
  const user =
    `Shop name: ${brief.shop.name}\nThe first ${refs.length} images are REFERENCE photos of the product. The other ${frames.length} images are frames from the video, in time order.\n` +
    `Owner's note on the product: ${look ?? 'none'}\n` +
    `Plan:\nSetting: ${concept.setting}\nPerson: ${concept.person}\nColour: ${concept.color}\n` +
    concept.shots.map((s, i) => `Shot ${i + 1} (${s.seconds}s): ${s.action}`).join('\n');
  const verdict = await callJson(
    db,
    config,
    {
      purpose: 'vision',
      model: config.llm.models.qa,
      system: systemPrompt('vision', brief),
      user,
      images: [...refs, ...frames.map((f) => ({ mediaType: 'image/jpeg' as const, data: f.toString('base64') }))],
      schema: VisionVerdict,
      maxTokens: 4000,
      effort: EFFORT,
      slotId,
    },
    now,
  );
  const shop = plain(brief.shop.name);
  const quote = (w: { text: string }) => `"${w.text}"`;
  const overlay = verdict.writing.filter((w) => w.kind === 'overlay');
  const prominent = verdict.writing.filter((w) => w.kind === 'prominent' && plain(w.text) !== shop);
  // Any writing, however small, that is one or two letters away from the shop's name is a misspelling of it.
  const nearMiss = verdict.writing.filter((w) => { const t = plain(w.text); return t.length >= 4 && t !== shop && distance(t, shop) <= 2; });
  const problems: string[] = [];
  if (!verdict.productVisible) problems.push('the product is not clearly visible');
  if (!verdict.productMatches) problems.push('the product does not match the reference');
  if (overlay.length) problems.push(`writing drawn over the picture: ${overlay.map(quote).join(', ')}`);
  if (prominent.length) problems.push(`prominent writing in the video: ${prominent.map(quote).join(', ')}`);
  if (nearMiss.length) problems.push(`writing that nearly spells the shop's name: ${nearMiss.map(quote).join(', ')}`);
  if (verdict.brandMisspelled) problems.push('the shop name or logo is misspelled or distorted');
  if (verdict.bodyGlitch) problems.push('a generation fault such as a bad hand or face');
  return { pass: !problems.length, problems, verdict };
}
