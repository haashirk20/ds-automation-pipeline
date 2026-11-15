import { openSync, readSync, closeSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { ff } from '../render/ffmpeg.ts';

export type QaCheck = { name: string; pass: boolean; value: string; limit: string };
export type QaResult = { pass: boolean; checks: QaCheck[] };

export const MIN_DURATION_S = 14.0;
export const MAX_DURATION_S = 16.0;
export const MAX_BYTES = 100 * 1024 * 1024;
export const MIN_BYTES = 500 * 1000;
export const LOUD_TARGET_LUFS = -14;
export const LOUD_TOLERANCE_LU = 1.5;
export const MAX_TRUE_PEAK_DBTP = -0.7;
export const SILENCE_NOISE_DB = -50;
export const SILENCE_MIN_S = 1.5;
export const THUMB_W = 32;
export const THUMB_H = 57;
export const FRAME_BYTES = THUMB_W * THUMB_H;
export const BLACK_MEAN_MAX = 16;
export const BLACK_RUN_MAX_S = 0.3;
export const FROZEN_DIFF_MAX = 0.15;
export const FROZEN_RUN_MAX_S = 2.5;
export const MIN_FONT_PX = 56;
export const MIN_PLATE_ALPHA = 0.6;
export const MIN_CONTRAST = 4.5;
export const FRAME_W = 1080;
export const FRAME_H = 1920;
const FPS = 30;

const c = (name: string, pass: boolean, value: string, limit: string): QaCheck => ({ name, pass, value, limit });

// ---- probe ----
type Stream = { codec_type?: string; codec_name?: string; pix_fmt?: string; width?: number; height?: number; avg_frame_rate?: string; sample_rate?: string };
export type Probe = { format?: { format_name?: string; duration?: string }; streams?: Stream[] };

const fps = (r = '0/1') => { const [n, d] = r.split('/').map(Number); return d ? n! / d : NaN; };

export function evaluateProbe(p: Probe): QaCheck[] {
  const streams = p.streams ?? [];
  const v = streams.filter((s) => s.codec_type === 'video');
  const a = streams.filter((s) => s.codec_type === 'audio');
  const fmt = p.format?.format_name ?? '';
  const dur = Number(p.format?.duration);
  const v0 = v[0];
  const rate = fps(v0?.avg_frame_rate);
  const vDesc = `${v.length}x ${v0?.codec_name} ${v0?.pix_fmt} ${v0?.width}x${v0?.height} ${Number.isFinite(rate) ? rate.toFixed(2) : '?'}fps`;
  const a0 = a[0];
  return [
    c('container', fmt.includes('mp4'), fmt || 'none', 'format includes mp4'),
    c('video', v.length === 1 && v0!.codec_name === 'h264' && v0!.pix_fmt === 'yuv420p' && v0!.width === FRAME_W && v0!.height === FRAME_H && Math.abs(rate - FPS) < 0.01, vDesc, `1x h264 yuv420p ${FRAME_W}x${FRAME_H} ${FPS}fps`),
    c('duration', dur >= MIN_DURATION_S && dur <= MAX_DURATION_S, Number.isFinite(dur) ? `${dur.toFixed(2)}s` : 'none', `${MIN_DURATION_S} to ${MAX_DURATION_S}s`),
    c('audio', a.length === 1 && a0!.codec_name === 'aac' && Number(a0!.sample_rate) === 48000, `${a.length}x ${a0?.codec_name ?? 'none'} ${a0?.sample_rate ?? ''}`.trim(), '1x aac 48000'),
  ];
}

export const sizeCheck = (bytes: number) => c('size', bytes <= MAX_BYTES && bytes > MIN_BYTES, `${(bytes / 1e6).toFixed(2)} MB`, '500 kB < size <= 100 MB');

// ---- mp4 atoms ----
type Reader = (offset: number, len: number) => Buffer;

// Lists top-level atoms until moov and mdat are both seen or the file ends.
export function topAtoms(read: Reader, fileSize: number): { type: string; offset: number }[] {
  const out: { type: string; offset: number }[] = [];
  let off = 0;
  while (off + 8 <= fileSize) {
    const h = read(off, 16);
    if (h.length < 8) break;
    let size = h.readUInt32BE(0);
    const type = h.toString('latin1', 4, 8);
    if (size === 1) { if (h.length < 16) break; size = Number(h.readBigUInt64BE(8)); }
    else if (size === 0) size = fileSize - off;
    out.push({ type, offset: off });
    if (size < 8) break;
    off += size;
  }
  return out;
}

export function faststartOk(atoms: { type: string }[]): { pass: boolean; value: string } {
  const moov = atoms.findIndex((a) => a.type === 'moov');
  const mdat = atoms.findIndex((a) => a.type === 'mdat');
  return { pass: moov >= 0 && mdat >= 0 && moov < mdat, value: atoms.map((a) => a.type).join(',') || 'none' };
}

function fileAtoms(file: string, size: number) {
  const fd = openSync(file, 'r');
  try {
    return topAtoms((off, len) => { const b = Buffer.alloc(len); return b.subarray(0, readSync(fd, b, 0, len, off)); }, size);
  } finally { closeSync(fd); }
}

// ---- loudness / silence ----
export function parseLoudnorm(stderr: string): { i: number; tp: number } | null {
  const m = stderr.match(/\{[^{}]*"input_i"[^{}]*\}/);
  if (!m) return null;
  try { const j = JSON.parse(m[0]); return { i: Number(j.input_i), tp: Number(j.input_tp) }; } catch { return null; }
}

export function loudnessChecks(l: { i: number; tp: number } | null): QaCheck[] {
  const iOk = !!l && Math.abs(l.i - LOUD_TARGET_LUFS) <= LOUD_TOLERANCE_LU;
  const tpOk = !!l && l.tp <= MAX_TRUE_PEAK_DBTP;
  return [c('loudness', iOk && tpOk, l ? `${l.i} LUFS, ${l.tp} dBTP` : 'unmeasurable', `${LOUD_TARGET_LUFS}+-${LOUD_TOLERANCE_LU} LUFS, <= ${MAX_TRUE_PEAK_DBTP} dBTP`)];
}

export function parseSilence(stderr: string): number[] {
  return [...stderr.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map((m) => Number(m[1]));
}

// ---- frames ----
// This ffmpeg build has no rawvideo muxer: the rawvideo codec through image2pipe yields the same bytes.
// Longest run of true flags, in frames.
export function longestRun(flags: boolean[]): number {
  let best = 0, cur = 0;
  for (const f of flags) { cur = f ? cur + 1 : 0; if (cur > best) best = cur; }
  return best;
}

const frameAt = (buf: Buffer, i: number) => buf.subarray(i * FRAME_BYTES, (i + 1) * FRAME_BYTES);

export function blackRunSeconds(buf: Buffer, rate = FPS): number {
  const n = Math.floor(buf.length / FRAME_BYTES);
  const flags: boolean[] = [];
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (const x of frameAt(buf, i)) sum += x;
    flags.push(sum / FRAME_BYTES < BLACK_MEAN_MAX);
  }
  return longestRun(flags) / rate;
}

// A frame counts as frozen when it differs from the previous one by under FROZEN_DIFF_MAX on average.
export function frozenRunSeconds(buf: Buffer, rate = FPS): number {
  const n = Math.floor(buf.length / FRAME_BYTES);
  const flags: boolean[] = [];
  for (let i = 1; i < n; i++) {
    const a = frameAt(buf, i - 1), b = frameAt(buf, i);
    let sum = 0;
    for (let k = 0; k < FRAME_BYTES; k++) sum += Math.abs(a[k]! - b[k]!);
    flags.push(sum / FRAME_BYTES < FROZEN_DIFF_MAX);
  }
  return longestRun(flags) / rate;
}

// ---- caption / safe zone helpers ----
function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((x) => x + x).join('') : h;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(full.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function contrastRatio(hexA: string, hexB: string): number {
  const [hi, lo] = [luminance(hexA), luminance(hexB)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

export function captionStyleOk(s: { fontPx: number; textHex: string; plateHex: string; plateAlpha: number }): boolean {
  return s.fontPx >= MIN_FONT_PX && s.plateAlpha >= MIN_PLATE_ALPHA && contrastRatio(s.textHex, s.plateHex) >= MIN_CONTRAST;
}

// ---- runner ----
const tryFf = (args: string[]) => ff('ffmpeg', args).then((r) => r, () => null);

// A raw clip must have an audio stream that is not silent for (nearly) its whole length. Same silencedetect as the gate.
export async function clipHasSound(file: string, seconds: number): Promise<boolean> {
  const sil = await tryFf(['-nostats', '-i', file, '-vn', '-af', `silencedetect=noise=${SILENCE_NOISE_DB}dB:d=${SILENCE_MIN_S}`, '-f', 'null', '-']);
  if (!sil) return false; // no audio stream (or unreadable)
  return ![...sil.stderr.matchAll(/silence_duration:\s*([\d.]+)/g)].some((m) => Number(m[1]) >= seconds * 0.9);
}

const CHECK_NAMES = ['container', 'video', 'duration', 'audio', 'size', 'faststart', 'loudness', 'silence', 'black frames', 'frozen picture'];

// The gate reports, it never throws: any failure yields all ten checks, failed, with the reason.
export async function runQa(file: string): Promise<QaResult> {
  try {
    return await analyse(file);
  } catch (e) {
    const why = `unreadable: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`;
    return { pass: false, checks: CHECK_NAMES.map((n) => c(n, false, why, 'readable file')) };
  }
}

async function analyse(file: string): Promise<QaResult> {
  const size = (await stat(file)).size;
  const [probeR, loud, sil, raw] = await Promise.all([
    ff('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]).then((r) => r, () => null),
    tryFf(['-nostats', '-i', file, '-vn', '-af', 'loudnorm=I=-14:TP=-1:LRA=11:print_format=json', '-f', 'null', '-']),
    tryFf(['-nostats', '-i', file, '-vn', '-af', `silencedetect=noise=${SILENCE_NOISE_DB}dB:d=${SILENCE_MIN_S}`, '-f', 'null', '-']),
    tryFf(['-v', 'error', '-i', file, '-an', '-vf', `scale=${THUMB_W}:${THUMB_H},format=gray`, '-c:v', 'rawvideo', '-f', 'image2pipe', 'pipe:1']),
  ]);
  let probe: Probe = {};
  try { if (probeR) probe = JSON.parse(probeR.stdout.toString()); } catch { /* leave empty: probe checks fail */ }
  const checks: QaCheck[] = [...evaluateProbe(probe), sizeCheck(size)];

  let fast: { pass: boolean; value: string };
  try { fast = faststartOk(fileAtoms(file, size)); } catch (e) { fast = { pass: false, value: String(e) }; }
  checks.push(c('faststart', fast.pass, fast.value, 'moov before mdat'));

  checks.push(...loudnessChecks(loud ? parseLoudnorm(loud.stderr) : null));
  // silencedetect fails when the file has no audio stream; that counts as failing too.
  const starts = sil ? parseSilence(sil.stderr) : null;
  checks.push(c('silence', starts !== null && starts.length === 0, starts === null ? 'unmeasurable' : starts.length ? `${starts.length} gap(s) from ${starts[0]}s` : 'none', `no gap >= ${SILENCE_MIN_S}s below ${SILENCE_NOISE_DB}dB`));

  const frames = raw?.stdout ?? Buffer.alloc(0);
  const have = frames.length >= FRAME_BYTES;
  const black = have ? blackRunSeconds(frames) : NaN;
  const frozen = have ? frozenRunSeconds(frames) : NaN;
  checks.push(c('black frames', have && black <= BLACK_RUN_MAX_S, have ? `${black.toFixed(2)}s longest run` : 'undecodable', `<= ${BLACK_RUN_MAX_S}s`));
  checks.push(c('frozen picture', have && frozen <= FROZEN_RUN_MAX_S, have ? `${frozen.toFixed(2)}s longest run` : 'undecodable', `<= ${FROZEN_RUN_MAX_S}s`));

  return { pass: checks.every((k) => k.pass), checks };
}
