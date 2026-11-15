// Owner music: list, tick, preview, delete and the one multipart upload. Untrusted media is parsed here, in the
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
import { csrfField, fmtTs, layout, redirect, type Ctx, type Res } from './pages.ts';

export const MAX_FILE = 40 * 1024 * 1024;
export const MAX_BODY = MAX_FILE + 64 * 1024;
const MAX_TRACKS = 50;
const CODECS = new Set(['aac', 'mp3', 'pcm_s16le', 'pcm_s24le']);
const SHA = /^[0-9a-f]{64}$/;

type Row = { sha256: string; name: string; seconds: number; lufs: number; selected: number; last_used_at: string | null };

export function musicPage(ctx: Ctx, error: string | null = null, status = 200): Res {
  const rows = ctx.db.prepare('SELECT sha256, name, seconds, lufs, selected, last_used_at FROM music_tracks WHERE deleted_at IS NULL ORDER BY created_at DESC').all() as Row[];
  const m = ctx.query.get('msg');
  const flash = error ? html`<p class="error-box" role="alert">${error}</p>` : m === 'uploaded' ? html`<p class="notice" role="status">Uploaded.</p>` : m === 'saved' ? html`<p class="notice" role="status">Selection saved. It applies to the next video made.</p>` : m === 'deleted' ? html`<p class="notice" role="status">Deleted.</p>` : '';
  return {
    ...layout(ctx, 'Music', '/music', html`${flash}<p class="banner">Only upload music you have the right to use in ads. YouTube, Facebook, Instagram and TikTok scan uploads for copyrighted music; a match can mute or block the post, hand its earnings to the rights holder, or strike the account. TikTok business accounts may use only its Commercial Music Library or audio you own.</p>
<p>Ticked tracks take turns, the least recently used first. With none ticked, videos have no music.</p>
<h2>Tracks</h2>${rows.length ? html`<form method="post" action="/music/select">${csrfField(ctx)}<div class="scroll"><table><thead><tr><th>Use</th><th>Name</th><th>Length</th><th>Loudness</th><th>Last used</th><th>Preview</th><th></th></tr></thead><tbody>${rows.map((r) => html`<tr><td><input type="checkbox" name="sel" value="${r.sha256}" aria-label="Use ${r.name}"${r.selected ? html` checked` : ''}></td><td>${r.name}</td><td>${Math.round(r.seconds)} s</td><td>${r.lufs.toFixed(1)} LUFS</td><td>${fmtTs(r.last_used_at)}</td><td><audio controls preload="none" src="/media/music?sha=${r.sha256}"></audio></td><td><button class="link" type="submit" formaction="/music/delete" name="sha" value="${r.sha256}">Delete</button></td></tr>`)}</tbody></table></div>
<div class="actions"><button class="primary" type="submit">Save selection</button></div></form>` : html`<p class="muted">No tracks yet.</p>`}
<h2>Upload</h2><form method="post" action="/music/upload" enctype="multipart/form-data">${csrfField(ctx)}
<div class="field"><label for="file">Track</label><div><input id="file" type="file" name="file" accept=".mp3,.m4a,.mp4,.wav,audio/*,video/mp4"><span class="hint">Up to 40 MB. mp3, m4a, mp4 or wav; the picture of a video file is discarded.</span></div></div>
<div class="field"><label for="ack">Rights</label><div><input id="ack" type="checkbox" name="ack" value="1"> I hold the rights to use this track in ads on these platforms.</div></div>
<div class="actions"><button class="primary" type="submit">Upload</button></div></form>`),
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
async function stage(ctx: Ctx, req: IncomingMessage, ct: string, incoming: string): Promise<{ sha: string; name: string; d: 'mov' | 'wav' | 'mp3' } | Res> {
  const fail = (status: number, msg: string): Res => ({ ...musicPage(ctx, msg, status), headers: status === 413 ? { connection: 'close' } : undefined });
  let n = 0;
  let capped = false;
  const counter = new Transform({
    transform(chunk: Buffer, _e, cb) {
      n += chunk.length;
      if (n > MAX_BODY) { capped = true; cb(new Error('too large')); } else cb(null, chunk);
    },
  });
  req.pipe(counter);
  req.on('error', (e) => counter.destroy(e));
  let fd: FormData;
  try {
    fd = await new Request('http://x/', { method: 'POST', headers: { 'content-type': ct }, body: Readable.toWeb(counter) as ReadableStream, duplex: 'half' } as RequestInit).formData();
  } catch {
    req.unpipe(counter);
    return capped ? fail(413, 'The upload is too large.') : fail(400, 'The upload could not be read.');
  }
  if (!safeEqual(String(fd.get('csrf') ?? ''), ctx.csrf ?? '')) return { status: 403, body: 'Forbidden', type: 'text/plain; charset=utf-8', headers: { connection: 'close' } };
  if (fd.get('ack') !== '1') return fail(422, 'Tick the box to confirm you hold the rights to this track.');
  const file = fd.get('file');
  if (!(file instanceof File) || file.size < 1024) return fail(422, 'Choose an audio file (at least 1 KB).');
  if (file.size > MAX_FILE) return fail(413, 'The file is over 40 MB.');
  if ((ctx.db.prepare('SELECT COUNT(*) AS n FROM music_tracks WHERE deleted_at IS NULL').get() as { n: number }).n >= MAX_TRACKS) return fail(422, `At most ${MAX_TRACKS} tracks. Delete one first.`);

  const hash = createHash('sha256');
  await pipeline(Readable.fromWeb(file.stream() as any), new Transform({ transform(c: Buffer, _e, cb) { hash.update(c); cb(null, c); } }), createWriteStream(incoming));
  const name = cleanName(file.name);
  const head = Buffer.alloc(12);
  const f = openSync(incoming, 'r');
  try { readSync(f, head, 0, 12, 0); } finally { closeSync(f); }
  const d = demuxerOf(head);
  if (!d) return fail(422, 'This is not an mp3, m4a, mp4 or wav file.');
  return { sha: hash.digest('hex'), name, d };
}

// Steps 4 to 15 of the upload order. The caller has checked host, session, Origin and Sec-Fetch-Site.
export async function uploadMusic(ctx: Ctx, req: IncomingMessage): Promise<Res> {
  const fail = (status: number, msg: string): Res => ({ ...musicPage(ctx, msg, status), headers: status === 413 ? { connection: 'close' } : undefined });
  const plain = (status: number, text: string): Res => ({ status, body: text, type: 'text/plain; charset=utf-8' });
  const ct = req.headers['content-type'] ?? '';
  if (!/^multipart\/form-data;\s*boundary=/i.test(ct)) return plain(415, 'Unsupported media type');
  const len = req.headers['content-length'];
  if (len === undefined || !/^\d+$/.test(len)) return plain(411, 'Length required');
  if (Number(len) > MAX_BODY) return { ...plain(413, 'Request too large'), headers: { connection: 'close' } };
  if (busy) return plain(429, 'Another upload is running');
  busy = true;
  let part: string | null = null;
  const root = musicRoot();
  const incoming = path.join(root, '.incoming', `${randomBytes(12).toString('hex')}.bin`);
  try {
    mkdirSync(path.join(root, '.incoming'), { recursive: true });
    const st = await stage(ctx, req, ct, incoming);
    if ('status' in st) return st;
    const { sha, name, d } = st;
    const guard = ['-protocol_whitelist', 'file', '-format_whitelist', 'mov,wav,mp3', '-codec_whitelist', 'aac,mp3,mp3float,pcm_s16le,pcm_s24le,h264,mjpeg,png', '-f', d];
    try {
      const probe = JSON.parse((await ff('ffprobe', ['-v', 'error', ...guard, '-print_format', 'json', '-show_format', '-show_streams', incoming], { timeoutMs: 15_000 })).stdout.toString());
      const a = (probe.streams ?? []).find((s: any) => s.codec_type === 'audio' && CODECS.has(s.codec_name));
      const seconds = Number(probe.format?.duration ?? a?.duration);
      if (!a) return fail(422, 'The file has no audio stream in a supported codec (aac, mp3 or wav).');
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
      return fail(422, 'The file could not be read as audio.');
    }
  } finally {
    busy = false;
    for (const f of [incoming, part]) if (f) try { rmSync(f, { force: true }); } catch { /* sweepMusic */ }
  }
}
