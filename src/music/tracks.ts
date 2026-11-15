import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { env } from '../config/index.ts';
import type { Db } from '../db/index.ts';
import { safeRemove } from '../ops/housekeeping.ts';
import { assertInside } from '../render/render.ts';

export type Track = { sha256: string; name: string; file: string; lufs: number };

export const musicRoot = () => path.join(path.resolve(env.dataDir()), 'music');

// The least recently used ticked track whose file is still inside the music folder.
export function pickTrack(db: Db): Track | null {
  const rows = db
    .prepare('SELECT sha256, name, file, lufs FROM music_tracks WHERE selected = 1 AND deleted_at IS NULL ORDER BY last_used_at IS NOT NULL, last_used_at, created_at')
    .all() as { sha256: string; name: string; file: string; lufs: number }[];
  for (const r of rows) {
    try {
      const abs = assertInside(path.resolve(env.dataDir(), r.file), musicRoot());
      if (existsSync(abs)) return { sha256: r.sha256, name: r.name, file: abs, lufs: r.lufs };
    } catch { /* a bad path is skipped like a missing file */ }
  }
  return null;
}

// Brings the track to -14 LUFS, then applies the owner's volume offset. Never above 0 dB.
export const musicGainDb = (t: Track, volumeDb: number): number => Math.min(0, Math.max(-40, -14 - t.lufs + volumeDb));

// Removes upload leftovers: files in .incoming and *.part older than a day, and <sha>.m4a with no live row older than an hour.
export function sweepMusic(db: Db, now: Date): { removed: number; errors: string[] } {
  const root = musicRoot();
  const out = { removed: 0, errors: [] as string[] };
  const live = new Set((db.prepare('SELECT sha256 FROM music_tracks WHERE deleted_at IS NULL').all() as { sha256: string }[]).map((r) => r.sha256));
  // A file that vanished mid-sweep counts as not old, so the sweep goes on.
  const older = (f: string, ms: number) => { try { return now.getTime() - statSync(f).mtimeMs > ms; } catch { return false; } };
  const old = (f: string) => older(f, 86_400_000);
  const drop = (f: string) => {
    try {
      if (safeRemove(f, root)) out.removed++;
    } catch (e) {
      out.errors.push(`${f}: ${(e as Error).message}`);
    }
  };
  const list = (d: string) => { try { return readdirSync(d); } catch { return []; } };
  for (const n of list(path.join(root, '.incoming'))) if (old(path.join(root, '.incoming', n))) drop(path.join(root, '.incoming', n));
  for (const n of list(root)) {
    const f = path.join(root, n);
    if (n.endsWith('.part')) { if (old(f)) drop(f); }
    else if (/^[0-9a-f]{64}\.m4a$/.test(n) && !live.has(n.slice(0, 64)) && older(f, 3_600_000)) drop(f); // a fresh one may be an upload between its rename and its row
  }
  return out;
}
