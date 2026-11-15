export type MusicMix = { gainDb: number; duckDb: number; duckUntilMs: number };

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

// Linear volume (0..1) of the owner's track at time tMs: base gain, ducked while the spoken line plays
// (until duckUntilMs, 150 ms ramps), with a 300 ms fade in and a 600 ms fade out. Pure.
export function ugcMusicVolume(tMs: number, durationMs: number, m: MusicMix): number {
  const duck = m.duckUntilMs > 0 ? clamp01((m.duckUntilMs + 150 - tMs) / 150) : 0;
  const base = Math.min(1, 10 ** ((m.gainDb + m.duckDb * duck) / 20));
  return base * clamp01(tMs / 300) * clamp01((durationMs - tMs) / 600);
}
