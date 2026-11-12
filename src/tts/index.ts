import { z } from 'zod';
import { run } from '../render/proc.ts';

const Word = z.object({ text: z.string(), startMs: z.number(), endMs: z.number() });
export const TtsResult = z.object({
  durationMs: z.number(),
  lines: z.array(z.object({ id: z.string(), startMs: z.number(), endMs: z.number(), words: z.array(Word) })),
});
export type TtsResult = z.infer<typeof TtsResult>;

export type TtsJob = { lines: { id: string; text: string }[]; voice: string; speed: number; gapMs: number; outWav: string };

// Kokoro on CPU through tools/tts. Writes outWav (mono 24 kHz) and returns exact word timings.
export async function synthesize(job: TtsJob): Promise<TtsResult> {
  const out = await run('uv', ['run', '--project', 'tools/tts', 'python', 'tools/tts/tts.py'], { stdin: JSON.stringify(job), timeoutMs: 180_000 });
  return TtsResult.parse(JSON.parse(out));
}
