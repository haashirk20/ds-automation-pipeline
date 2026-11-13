// The vision check on a generated clip. One model call; the verdict is decided here, not by the model.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { z } from 'zod';
import type { Brief, UgcConcept } from '../contracts.ts';
import type { Config } from '../config/index.ts';
import type { Db } from '../db/index.ts';
import { callJson } from '../llm/client.ts';
import { systemPrompt } from '../llm/prompts.ts';
import { ff } from '../render/ffmpeg.ts';

export const VisionVerdict = z.object({ productVisible: z.boolean(), productMatches: z.boolean(), extraText: z.array(z.string()), brandMisspelled: z.boolean(), bodyGlitch: z.boolean(), reason: z.string() });

// n JPEG frames, 360x640, evenly spaced from 1 s in to 1 s before the end.
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
      await ff('ffmpeg', ['-y', '-v', 'error', '-ss', t.toFixed(2), '-i', file, '-frames:v', '1', '-vf', 'scale=360:640', '-q:v', '4', f]);
      out.push(readFileSync(f));
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function checkClip(
  db: Db,
  config: Config,
  input: { clipFile: string; refImage: string; brief: Brief; concept: UgcConcept },
  now: Date,
  slotId: string,
  deps: { frames?: (file: string, n: number) => Promise<Buffer[]> } = {},
): Promise<{ pass: boolean; problems: string[]; verdict: z.infer<typeof VisionVerdict> }> {
  const { brief, concept } = input;
  const frames = await (deps.frames ?? defaultFrames)(input.clipFile, 6);
  const ref = { mediaType: (extname(input.refImage).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg') as 'image/png' | 'image/jpeg', data: readFileSync(input.refImage).toString('base64') };
  const user =
    `Shop name: ${brief.shop.name}\nThe first image is the REFERENCE photo of the product. The other ${frames.length} images are frames from the video, in time order.\n` +
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
      images: [ref, ...frames.map((f) => ({ mediaType: 'image/jpeg' as const, data: f.toString('base64') }))],
      schema: VisionVerdict,
      maxTokens: 1500,
      effort: 'low',
      slotId,
    },
    now,
  );
  const shop = brief.shop.name.trim().toLowerCase();
  const extra = verdict.extraText.filter((t) => t.trim().toLowerCase() !== shop);
  const problems: string[] = [];
  if (!verdict.productVisible) problems.push('the product is not clearly visible');
  if (!verdict.productMatches) problems.push('the product does not match the reference');
  if (extra.length) problems.push(`readable text in the video: ${extra.map((t) => `"${t}"`).join(', ')}`);
  if (verdict.brandMisspelled) problems.push('the shop name or logo is misspelled or distorted');
  if (verdict.bodyGlitch) problems.push('a generation fault such as a bad hand or face');
  return { pass: !problems.length, problems, verdict };
}
