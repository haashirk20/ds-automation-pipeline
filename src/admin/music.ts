// Owner music: list, switch on, preview, remove and the one multipart upload. Untrusted media is parsed here, in the
// container that holds no API keys, with forced demuxers and a file-only protocol whitelist.
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { closeSync, createWriteStream, mkdirSync, openSync, readSync, renameSync, rmSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { Transform, Readable } from 'node:stream';
import { audit } from '../config/overrides.ts';
import { log } from '../ops/log.ts';
import { ff } from '../render/ffmpeg.ts';
import { safeEqual } from './auth.ts';
import { html } from './html.ts';
import { musicRoot } from './media.ts';
import { readMultipart } from './upload.ts';
import fileConfig from '../../config/pipeline.config.ts';
import { parseConfig } from '../config/index.ts';
import { csrfField, layout, redirect, type Ctx, type Res } from './pages.ts';
import { confirmRemove, empty, flash, fmtLocal, formRow, toggle } from './ui.ts';

export const MAX_FILE = 40 * 1024 * 1024;
export const MAX_BODY = MAX_FILE + 64 * 1024;
const MAX_TRACKS = 50;
const CODECS = new Set(['aac', 'mp3', 'pcm_s16le', 'pcm_s24le']);
const SHA = /^[0-9a-f]{64}$/;

type Row = { sha256: string; name: string; seconds: number; lufs: number; selected: number; last_used_at: string | null };

export function musicPage(ctx: Ctx, error: string | null = null, status = 200): Res {
  const rows = ctx.db.prepare('SELECT sha256, name, seconds, lufs, selected, last_used_at FROM music_tracks WHERE deleted_at IS NULL ORDER BY created_at DESC').all() as Row[];
  const tz = (() => { try { return parseConfig(fileConfig).timezone; } catch { return 'UTC'; } })();
  const m = ctx.query.get('msg');
  const top = error ? flash('bad', 'Not saved.', error) : m === 'uploaded' ? flash('ok', 'Uploaded.', 'Switch it on below to use it in videos.') : m === 'saved' ? flash('ok', 'Choices saved.', 'The next video made uses them.') : m === 'deleted' ? flash('ok', 'Track removed.', 'Videos already made keep their music.') : '';
  const len = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  return {
    ...layout(ctx, 'Music', '/music', html`${top}${flash('info', 'Only upload music you own or have licensed for ads.', html`Platforms mute or block posts with music they recognise.<details><summary>Why this matters</summary>YouTube, Facebook, Instagram and TikTok scan uploads for copyrighted music; a match can mute or block the post, hand its earnings to the rights holder, or strike the account. TikTok business accounts may use only its Commercial Music Library or audio you own.</details>`)}
<section><h2>Your tracks</h2><p class="hint">Tracks that are switched on take turns, the least recently used first. With none switched on, videos have no music.</p>
${rows.length ? html`<form method="post" action="/music/select">${csrfField(ctx)}<ul class="tracks card">${rows.map((r, i) => html`<li class="track">${toggle({ id: `t-${i}`, name: 'sel', value: r.sha256, checked: !!r.selected, label: `Use ${r.name}` })}
<div><strong>${r.name}</strong><span class="hint">${len(r.seconds)} · ${r.last_used_at ? `Last used ${fmtLocal(r.last_used_at, tz)}` : 'Never used'}</span></div>
${confirmRemove('Remove…', html`<button class="danger" type="submit" form="del-${i}">Yes, remove ${r.name}</button>`)}
<audio controls preload="none" src="/media/music?sha=${r.sha256}" aria-label="Play ${r.name}"></audio>
<details class="tech"><summary>Technical details</summary>Loudness ${r.lufs.toFixed(1)} LUFS (evened out when mixed).</details></li>`)}</ul>
<div class="sticky-save"><button class="primary" type="submit">Save choices</button></div></form>
${rows.map((r, i) => html`<form id="del-${i}" method="post" action="/music/delete">${csrfField(ctx)}<input type="hidden" name="sha" value="${r.sha256}"></form>`)}` : empty('No music yet. Without music, videos have none.')}</section>
<section class="card"><h2>Upload a track</h2><form method="post" action="/music/upload" enctype="multipart/form-data">${csrfField(ctx)}
${formRow({ id: 'file', label: 'Track', control: html`<input id="file" type="file" name="file" accept=".mp3,.m4a,.mp4,.wav,audio/*,video/mp4" required>`, hint: 'Up to 40 MB, 5 seconds to 10 minutes. mp3, m4a, mp4 or wav; the picture of a video file is dropped.' })}
<label class="check" for="ack"><input id="ack" type="checkbox" name="ack" value="1" required> I own this track or hold the rights to use it in ads on these platforms.</label>
<div class="actions"><button class="primary" type="submit">Upload track</button></div></form></section>`),
    status,
  };
}

export function musicSelect(ctx: Ctx): Res {
  const sel = [...new Set(ctx.form.getAll('sel'))].filter((s) => SHA.test(s));
  ctx.db.exec('BEGIN IMMEDIATE');
  try {
    ctx.db.prepare('UPDATE music_tracks SET selected = 0').run();
    const up = ctx.db.prepare('UPDATE music_tracks SET selected = 1 WHERE sha256 = ? AND deleted_at IS NULL');
    for (const s of sel) up.run(s);
    audit(ctx.db, 'admin', 'music.select', 'music', { selected: sel }, ctx.now);
    ctx.db.exec('COMMIT');
  } catch (e) {
    ctx.db.exec('ROLLBACK');
    throw e;
  }
  return redirect('/music?msg=saved');
}

export function musicDelete(ctx: Ctx): Res {
  const sha = ctx.form.get('sha') ?? '';
  if (!SHA.test(sha)) return redirect('/music');
  if (ctx.db.prepare('UPDATE music_tracks SET deleted_at = ?, selected = 0 WHERE sha256 = ? AND deleted_at IS NULL').run(ctx.now.toISOString(), sha).changes) {
    audit(ctx.db, 'admin', 'music.delete', sha, {}, ctx.now);
    try { rmSync(path.join(musicRoot(), `${sha}.m4a`), { force: true }); } catch { /* sweepMusic is the backstop */ }
  }
  return redirect('/music?msg=deleted');
}

// From the first bytes, never from the file name.
export function demuxerOf(b: Buffer): 'mov' | 'wav' | 'mp3' | null {
  if (b.length < 12) return null;
  if (b.toString('latin1', 4, 8) === 'ftyp') return 'mov';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE') return 'wav';
  if (b.toString('latin1', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'mp3';
  return null;
}

const cleanName = (n: string): string => path.basename(n).replace(/\p{C}/gu, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'track';

let busy = false;

// Reads the form, streams the file to `incoming` while hashing, and lets go of the form, so the 40 MB it holds can be freed
// before ffmpeg starts. Returns the fields the rest needs, or the response to send.
async function stage(ctx: Ctx, req: IncomingMessage, incoming: string): Promise<{ sha: string; name: string; d: 'mov' | 'wav' | 'mp3' } | Res> {
  const fail = (status: number, msg: string): Res => ({ ...musicPage(ctx, msg, status), headers: status === 413 ? { connection: 'close' } : undefined });
  const r = await readMultipart(req, MAX_BODY);
  if ('why' in r) return r.why === 'large' ? fail(413, 'The upload is too large.') : fail(400, 'The upload could not be read.');
  const fd = r.fd;
  if (!safeEqual(String(fd.get('csrf') ?? ''), ctx.csrf ?? '')) return { status: 403, body: 'Forbidden', type: 'text/plain; charset=utf-8', headers: { connection: 'close' } };
  if (fd.get('ack') !== '1') return fail(422, 'Tick the box to confirm you hold the rights to this track.');
  const file = fd.get('file');
  if (!(file instanceof File) || file.size === 0) return fail(422, 'Choose an audio file.');
  if (file.size < 1024) return fail(422, 'That file is too small to be a song.');
  if (file.size > MAX_FILE) return fail(413, 'The file is over 40 MB.');
  if ((ctx.db.prepare('SELECT COUNT(*) AS n FROM music_tracks WHERE deleted_at IS NULL').get() as { n: number }).n >= MAX_TRACKS) return fail(422, `At most ${MAX_TRACKS} tracks. Remove one first.`);

  const hash = createHash('sha256');
  await pipeline(Readable.fromWeb(file.stream() as any), new Transform({ transform(c: Buffer, _e, cb) { hash.update(c); cb(null, c); } }), createWriteStream(incoming));
  const name = cleanName(file.name);
  const head = Buffer.alloc(12);
  const f = openSync(incoming, 'r');
  try { readSync(f, head, 0, 12, 0); } finally { closeSync(f); }
  const d = demuxerOf(head);
  if (!d) return fail(422, 'That file is not audio we can read.');
  return { sha: hash.digest('hex'), name, d };
}

// Steps 4 to 15 of the upload order. The caller has checked host, session, Origin, Sec-Fetch-Site, content type and length.
export async function uploadMusic(ctx: Ctx, req: IncomingMessage): Promise<Res> {
  const fail = (status: number, msg: string): Res => ({ ...musicPage(ctx, msg, status), headers: status === 413 ? { connection: 'close' } : undefined });
  const plain = (status: number, text: string): Res => ({ ...layout(ctx, 'Music', '/music', html`<p>${text}</p><p><a class="btn" href="/music">Back to Music</a></p>`), status });
  if (busy) return plain(429, 'Another upload is running. Try again in a minute.');
  busy = true;
  let part: string | null = null;
  const root = musicRoot();
  const incoming = path.join(root, '.incoming', `${randomBytes(12).toString('hex')}.bin`);
  try {
    mkdirSync(path.join(root, '.incoming'), { recursive: true });
    const st = await stage(ctx, req, incoming);
    if ('status' in st) return st;
    const { sha, name, d } = st;
    const guard = ['-protocol_whitelist', 'file', '-format_whitelist', 'mov,wav,mp3', '-codec_whitelist', 'aac,mp3,mp3float,pcm_s16le,pcm_s24le,h264,mjpeg,png', '-f', d];
    try {
      const probe = JSON.parse((await ff('ffprobe', ['-v', 'error', ...guard, '-print_format', 'json', '-show_format', '-show_streams', incoming], { timeoutMs: 15_000 })).stdout.toString());
      const a = (probe.streams ?? []).find((s: any) => s.codec_type === 'audio' && CODECS.has(s.codec_name));
      const seconds = Number(probe.format?.duration ?? a?.duration);
      if (!a) return fail(422, 'That file is not audio we can read.');
      if (!(seconds >= 5 && seconds <= 600)) return fail(422, 'The track must be 5 seconds to 10 minutes long.');
      part = path.join(root, `${sha}.m4a.part`);
      await ff('ffmpeg', ['-hide_banner', '-nostdin', '-threads', '2', '-filter_threads', '1', ...guard, '-i', incoming, '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '2', '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', '-map_metadata', '-1', '-t', '600', '-f', 'mp4', '-movflags', '+faststart', '-y', part], { timeoutMs: 120_000 });
      const m = await ff('ffmpeg', ['-hide_banner', '-nostdin', '-protocol_whitelist', 'file', '-f', 'mov', '-i', part, '-vn', '-af', 'loudnorm=I=-14:TP=-1:LRA=11:print_format=json', '-f', 'null', '-'], { timeoutMs: 60_000 });
      const lufs = Number(JSON.parse(m.stderr.slice(m.stderr.lastIndexOf('{'), m.stderr.lastIndexOf('}') + 1)).input_i);
      if (!Number.isFinite(lufs)) return fail(422, 'The track is silent.');
      renameSync(part, path.join(root, `${sha}.m4a`));
      part = null;
      ctx.db.prepare('INSERT INTO music_tracks (sha256, name, file, seconds, lufs, selected, created_at) VALUES (?,?,?,?,?,0,?) ON CONFLICT(sha256) DO UPDATE SET name = excluded.name, file = excluded.file, seconds = excluded.seconds, lufs = excluded.lufs, deleted_at = NULL').run(sha, name, `music/${sha}.m4a`, seconds, lufs, ctx.now.toISOString());
      audit(ctx.db, 'admin', 'music.upload', sha, { name, seconds, lufs }, ctx.now);
      return redirect('/music?msg=uploaded');
    } catch (e) {
      log.warn('music upload refused', { error: (e as Error).message.slice(0, 200) });
      return fail(422, 'That file is not audio we can read.');
    }
  } finally {
    busy = false;
    for (const f of [incoming, part]) if (f) try { rmSync(f, { force: true }); } catch { /* sweepMusic */ }
  }
}
