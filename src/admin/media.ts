// Media routes: strict ids, realpath + containment, byte ranges. Streams come from the shared volumes; nothing is rewritten.
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { env } from '../config/index.ts';
import type { Ctx, Res } from './pages.ts';

export const musicRoot = (): string => path.join(path.resolve(env.dataDir()), 'music');

// null = send the whole file (no header, several ranges, or a syntax we ignore); 'unsatisfiable' = 416.
export function parseRange(header: string | null | undefined, size: number): { start: number; end: number } | null | 'unsatisfiable' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (size === 0) return null; // answered as an empty 200 by serve
  let start: number;
  let end: number;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (m[2] !== '' && Number(m[2]) < start) return null; // an invalid range is ignored (RFC 9110)
    if (start >= size) return 'unsatisfiable';
  }
  return { start, end };
}

// Resolves symlinks on both sides, so a link inside the folder cannot lead out of it.
export function inside(file: string, root: string): string | null {
  try {
    const r = realpathSync(root);
    const f = realpathSync(file);
    return f.startsWith(r + path.sep) && statSync(f).isFile() ? f : null;
  } catch {
    return null;
  }
}

function serve(ctx: Ctx, file: string, type: string): Res {
  const size = statSync(file).size;
  if (size === 0) return { status: 200, headers: { 'accept-ranges': 'bytes' }, body: '', type };
  const r = parseRange(ctx.range, size);
  const base = { 'accept-ranges': 'bytes' };
  if (r === 'unsatisfiable') return { status: 416, headers: { ...base, 'content-range': `bytes */${size}` }, body: '', type: 'text/plain; charset=utf-8' };
  if (r === null) return { status: 200, headers: base, file: { path: file, start: 0, end: size - 1, size, type } };
  return { status: 206, headers: { ...base, 'content-range': `bytes ${r.start}-${r.end}/${size}` }, file: { path: file, ...r, size, type } };
}

const notFound: Res = { status: 404, body: 'Not found', type: 'text/plain; charset=utf-8' };

export const SLOT_ID = /^\d{4}-\d{2}-\d{2}#\d{1,3}$/;

// The first render of a slot, if its file is a regular file inside OUT_DIR.
export function renderFile(db: Ctx['db'], slot: string): string | null {
  if (!SLOT_ID.test(slot)) return null;
  const r = db.prepare('SELECT file_path FROM renders WHERE slot_id = ? ORDER BY platform LIMIT 1').get(slot) as { file_path: string } | undefined;
  return r ? inside(path.resolve(r.file_path), env.outDir()) : null;
}

export function mediaRender(ctx: Ctx): Res {
  const f = renderFile(ctx.db, ctx.query.get('slot') ?? '');
  return f ? serve(ctx, f, 'video/mp4') : notFound;
}

export function mediaMusic(ctx: Ctx): Res {
  const sha = ctx.query.get('sha') ?? '';
  if (!/^[0-9a-f]{64}$/.test(sha) || !ctx.db.prepare('SELECT 1 FROM music_tracks WHERE sha256 = ? AND deleted_at IS NULL').get(sha)) return notFound;
  const f = inside(path.join(musicRoot(), `${sha}.m4a`), musicRoot());
  return f ? serve(ctx, f, 'audio/mp4') : notFound;
}
