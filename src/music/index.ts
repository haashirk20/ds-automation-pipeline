import { run } from '../render/proc.ts';

// Procedural instrumental bed (stereo 48 kHz WAV) from tools/music. Same seed, same bytes.
export async function makeBed(job: { seed: number; durationSec: number; outWav: string }): Promise<void> {
  await run('uv', ['run', '--project', 'tools/music', 'python', 'tools/music/bed.py', '--seed', String(job.seed), '--duration', String(job.durationSec), '--out', job.outWav], { timeoutMs: 180_000 });
}
