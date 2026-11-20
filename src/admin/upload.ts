// Image uploads: product photos and the logo. Like music, untrusted files are parsed here, in the container
// that holds no API keys. The type comes from the first bytes, ffmpeg runs with a forced demuxer and a
// file-only protocol whitelist, and every image is re-encoded to PNG with its metadata dropped. PNG and JPEG only:
// the bundled ffmpeg has no WebP decoder.
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { ff } from '../render/ffmpeg.ts';

export const MAX_IMAGE = 15 * 1024 * 1024;
export const MAX_PHOTOS = 8;

// Reads a multipart body of at most maxBody bytes. null = too large or unreadable (the reason is in `why`).
export async function readMultipart(req: IncomingMessage, maxBody: number): Promise<{ fd: FormData } | { why: 'large' | 'bad' }> {
  const ct = req.headers['content-type'] ?? '';
  let n = 0;
  let capped = false;
  const counter = new Transform({
    transform(chunk: Buffer, _e, cb) {
      n += chunk.length;
      if (n > maxBody) { capped = true; cb(new Error('too large')); } else cb(null, chunk);
    },
  });
  req.pipe(counter);
  req.on('error', (e) => counter.destroy(e));
  try {
    const fd = await new Request('http://x/', { method: 'POST', headers: { 'content-type': ct }, body: Readable.toWeb(counter) as ReadableStream, duplex: 'half' } as RequestInit).formData();
    return { fd };
  } catch {
    req.unpipe(counter);
    return { why: capped ? 'large' : 'bad' };
  }
}

// From the first bytes, never from the file name.
export function imageKind(b: Buffer): 'png' | 'jpeg' | 'webp' | null {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

export class ImageError extends Error {}

// Writes one uploaded image as `<dir>/<prefix><sha256>.png`, at most `maxSide` pixels on its long side.
// Returns the file name and size. Throws ImageError with a sentence for the owner.
export async function saveImage(file: File, dir: string, prefix: string, maxSide: number): Promise<{ name: string; width: number; height: number }> {
  if (file.size < 100) throw new ImageError(`${file.name || 'A file'} is empty.`);
  if (file.size > MAX_IMAGE) throw new ImageError(`${file.name || 'A file'} is over 15 MB.`);
  mkdirSync(path.join(dir, '.incoming'), { recursive: true });
  const id = randomBytes(12).toString('hex');
  const buf = Buffer.from(await file.arrayBuffer());
  const k = imageKind(buf.subarray(0, 12));
  if (k !== 'png' && k !== 'jpeg') throw new ImageError(`${file.name || 'A file'} is not a PNG or JPEG image.`);
  // The image demuxer reads the codec from the extension, so the staged file carries the sniffed one.
  const incoming = path.join(dir, '.incoming', `${id}.in.${k === 'png' ? 'png' : 'jpg'}`);
  const part = path.join(dir, '.incoming', `${id}.png`);
  try {
    writeFileSync(incoming, buf);
    // The bundled ffmpeg has the generic image demuxer only; the decoder is forced from the sniffed type.
    // ffprobe cannot force a decoder; the codec whitelist limits it to the same two.
    const probe = ['-protocol_whitelist', 'file', '-format_whitelist', 'image2pipe', '-codec_whitelist', 'png,mjpeg', '-f', 'image2pipe'];
    const guard = [...probe, '-c:v', k === 'png' ? 'png' : 'mjpeg'];
    const size = async (f: string) => {
      const p = JSON.parse((await ff('ffprobe', ['-v', 'error', ...probe, '-print_format', 'json', '-show_streams', f], { timeoutMs: 15_000 })).stdout.toString());
      const s = (p.streams ?? []).find((x: { codec_type?: string; codec_name?: string }) => x.codec_type === 'video' && (x.codec_name === 'png' || x.codec_name === 'mjpeg'));
      return { width: Number(s?.width), height: Number(s?.height) };
    };
    let src: { width: number; height: number };
    try { src = await size(incoming); } catch { throw new ImageError(`${file.name || 'A file'} could not be read as an image.`); }
    if (!(src.width >= 64 && src.height >= 64)) throw new ImageError(`${file.name || 'A file'} is smaller than 64 × 64 pixels.`);
    if (src.width > 12_000 || src.height > 12_000) throw new ImageError(`${file.name || 'A file'} is larger than 12000 pixels on a side.`);
    try {
      await ff('ffmpeg', ['-hide_banner', '-nostdin', '-threads', '2', ...guard, '-i', incoming, '-frames:v', '1', '-vf', `scale=w='min(${maxSide},iw)':h='min(${maxSide},ih)':force_original_aspect_ratio=decrease`, '-map_metadata', '-1', '-c:v', 'png', '-f', 'image2', '-update', '1', '-y', part], { timeoutMs: 60_000 });
    } catch {
      throw new ImageError(`${file.name || 'A file'} could not be converted.`);
    }
    const out = await size(part);
    const sha = createHash('sha256').update(readFileSync(part)).digest('hex');
    const name = `${prefix}${sha}.png`;
    renameSync(part, path.join(dir, name));
    return { name, width: out.width, height: out.height };
  } finally {
    for (const f of [incoming, part]) try { rmSync(f, { force: true }); } catch { /* left for sweepIncoming (src/shopify/index.ts) */ }
  }
}
