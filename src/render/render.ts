import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { makeCancelSignal, renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import { env, type Config, type PlatformName } from '../config/index.ts';
import { Edl, type RenderProps } from '../contracts.ts';
import { safeRemove } from '../ops/housekeeping.ts';
import { ff } from './ffmpeg.ts';
import { probeVideo } from './probe.ts';

const ENTRY = path.resolve(import.meta.dirname, '../../templates/index.ts');

// Hash of everything the bundle is made from.
function sourceHash(): string {
  const h = createHash('sha256');
  const walk = (dir: string) => {
    for (const f of readdirSync(dir).sort()) {
      const full = path.join(dir, f);
      if (statSync(full).isDirectory()) walk(full);
      else h.update(f).update(readFileSync(full));
    }
  };
  walk(path.dirname(ENTRY));
  h.update(readFileSync(path.resolve(import.meta.dirname, '../contracts.ts')));
  return h.digest('hex').slice(0, 16);
}

// Removes staged folders under <bundle>/public/s/ older than maxAgeMs: a render killed at its timeout never cleans up.
export function sweepStaged(bundleDir: string, maxAgeMs: number, nowMs: number): number {
  const root = path.join(bundleDir, 'public', 's');
  let n = 0;
  for (const e of existsSync(root) ? readdirSync(root) : []) {
    try {
      if (nowMs - lstatSync(path.join(root, e)).mtimeMs > maxAgeMs && safeRemove(path.join(root, e), root)) n++;
    } catch { /* removed meanwhile */ }
  }
  return n;
}

let bundled: Promise<string> | null = null;
let swept = false;
// One bundle per template version, kept in a stable cache directory (BUNDLE_CACHE_DIR; the Docker image
// builds it ahead of time) and shared by every process. Renders add their files under <bundle>/public/.
// With staleMs, the first call in a process also sweeps staged folders older than that.
export function getBundle(staleMs?: number): Promise<string> {
  bundled ??= (async () => {
    const root = process.env.BUNDLE_CACHE_DIR || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ad-pipeline');
    const dir = path.join(root, `bundle-${sourceHash()}`);
    if (existsSync(path.join(dir, 'index.html'))) return dir;
    mkdirSync(root, { recursive: true });
    const tmp = `${dir}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
    await bundle({ entryPoint: ENTRY, outDir: tmp });
    try {
      renameSync(tmp, dir);
    } catch {
      rmSync(tmp, { recursive: true, force: true }); // another process won the race
      if (!existsSync(path.join(dir, 'index.html'))) throw new Error('bundle cache is not usable');
    }
    return dir;
  })().catch((e) => {
    bundled = null;
    throw e;
  });
  if (staleMs === undefined || swept) return bundled;
  swept = true;
  // File ages are wall-clock mtimes, so they are compared with the system clock, not the pipeline's.
  return bundled.then((dir) => (sweepStaged(dir, staleMs, Date.now()), dir));
}

// Every file the EDL references, each mapped to a generated name under s/<id>/. Pure.
export function planStaging(edl: Edl, id: string): { files: { from: string; to: string }[]; edl: Edl } {
  const names = new Map<string, string>();
  const stage = (src: string) => {
    let to = names.get(src);
    if (!to) {
      to = `s/${id}/f${names.size}${path.extname(src).toLowerCase()}`;
      names.set(src, to);
    }
    return to;
  };
  const out: Edl = structuredClone(edl);
  for (const b of out.beats) for (const s of b.shots) s.src = stage(s.src);
  out.endCard.shotSrc = stage(out.endCard.shotSrc);
  out.audio.voiceSrc = stage(out.audio.voiceSrc);
  if (out.audio.musicSrc) out.audio.musicSrc = stage(out.audio.musicSrc);
  return { files: [...names].map(([from, to]) => ({ from, to })), edl: out };
}

export function assertInside(file: string, dir: string): string {
  const root = path.resolve(dir);
  const abs = path.resolve(file);
  if (!abs.startsWith(root + path.sep)) throw new Error(`output path ${abs} is outside OUT_DIR ${root}`);
  return abs;
}

function stageFiles(bundleDir: string, files: { from: string; to: string }[]) {
  for (const f of files) {
    const dest = path.join(bundleDir, 'public', f.to);
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(f.from, dest);
  }
}

// Two-pass loudnorm to -14 LUFS / -1 dBTP; video is copied. Returns the measured input loudness.
// A clip with one loud line and quiet room sound cannot reach the target in one pass without clipping,
// and this FFmpeg build has no limiter, so the pass is repeated (at most three times) until the result
// is inside the band the QA gate checks.
export async function normalizeLoudness(inFile: string, outFile: string): Promise<{ inputLufs: number }> {
  const target = 'I=-14:TP=-1:LRA=11';
  let src = inFile;
  let inputLufs = NaN;
  for (let pass = 0; pass < 3; pass++) {
    const m = await ff('ffmpeg', ['-hide_banner', '-nostdin', '-i', src, '-vn', '-af', `loudnorm=${target}:print_format=json`, '-f', 'null', '-']);
    const json = JSON.parse(m.stderr.slice(m.stderr.lastIndexOf('{'), m.stderr.lastIndexOf('}') + 1));
    if (pass === 0) inputLufs = Number(json.input_i);
    else if (Math.abs(Number(json.input_i) + 14) <= 1 && Number(json.input_tp) <= -0.75) break; // the last pass landed
    const af = `loudnorm=${target}:measured_I=${json.input_i}:measured_TP=${json.input_tp}:measured_LRA=${json.input_lra}:measured_thresh=${json.input_thresh}:offset=${json.target_offset}:linear=true`;
    const out = `${outFile}.pass${pass}.mp4`;
    await ff('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-i', src, '-map', '0:v', '-map', '0:a', '-c:v', 'copy', '-af', af, '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', out]);
    if (src !== inFile) rmSync(src, { force: true });
    src = out;
  }
  renameSync(src, outFile);
  return { inputLufs };
}

// Stages files under <bundle>/public/s/<id>/, renders one composition, loudness-normalises into outFile, and always cleans up.
async function renderStaged(o: { composition: string; id: string; files: { from: string; to: string }[]; inputProps: Record<string, unknown>; outFile: string; config: Config; signal?: AbortSignal }): Promise<void> {
  const { composition: compositionId, id, inputProps, outFile } = o;
  const serveUrl = await getBundle(o.config.render.produceTimeoutMinutes * 60000);
  const stagedDir = path.join(serveUrl, 'public', 's', id);
  mkdirSync(path.dirname(outFile), { recursive: true });
  const raw = outFile + '.raw.mp4';
  try {
    stageFiles(serveUrl, o.files);
    const composition = await selectComposition({ serveUrl, id: compositionId, inputProps });
    // Remotion starts Chrome in its own process group; cancelling is the only way to stop it.
    const { cancelSignal, cancel } = makeCancelSignal();
    if (o.signal?.aborted) cancel();
    o.signal?.addEventListener('abort', cancel, { once: true });
    await renderMedia({ composition, serveUrl, inputProps, codec: 'h264', pixelFormat: 'yuv420p', audioCodec: 'aac', outputLocation: raw, logLevel: 'error', cancelSignal });
    await normalizeLoudness(raw, outFile);
  } finally {
    rmSync(stagedDir, { recursive: true, force: true });
    rmSync(raw, { force: true });
  }
}

export async function renderEdl(opts: { edl: Edl; platform: PlatformName; config: Config; outFile: string; signal?: AbortSignal }): Promise<void> {
  const outFile = assertInside(opts.outFile, env.outDir());
  const edl = Edl.parse(opts.edl);
  const p = opts.config.platforms[opts.platform];
  const id = randomBytes(6).toString('hex');
  const plan = planStaging(edl, id);
  const inputProps: RenderProps = { edl: plan.edl, platform: opts.platform, safe: p.safe, cta: p.cta };
  await renderStaged({ composition: 'Ad', id, files: plan.files, inputProps, outFile, config: opts.config, signal: opts.signal });
}

export const UGC_MIN_SECONDS = 14;
export const UGC_MAX_MS = 16000;
export const UGC_MIN_SHORT_SIDE = 480;

// Caption top edge: below the tallest top safe zone of the enabled platforms, plus 30 px.
export const ugcTop = (config: Config): number => Math.max(...Object.values(config.platforms).filter((p) => p.enabled).map((p) => p.safe.top)) + 30;

// Refuses a clip that cannot be a finished ad; returns the length to render, in ms.
export function ugcDurationMs(v: { width: number; height: number; seconds: number } | null): number {
  if (!v) throw new Error('clip has no video stream');
  if (!(v.seconds >= UGC_MIN_SECONDS)) throw new Error(`clip is ${v.seconds.toFixed(1)} s, shorter than ${UGC_MIN_SECONDS} s`);
  if (Math.min(v.width, v.height) < UGC_MIN_SHORT_SIDE) throw new Error(`clip is ${v.width}x${v.height}, short side under ${UGC_MIN_SHORT_SIDE} px`);
  return Math.min(Math.round(v.seconds * 1000), UGC_MAX_MS);
}

// One AI clip with its own sound and a single caption at the top.
export async function renderUgc(opts: { clip: string; caption: string; config: Config; outFile: string; music?: { file: string; gainDb: number; duckDb: number; duckUntilMs: number } | null; signal?: AbortSignal }): Promise<void> {
  const outFile = assertInside(opts.outFile, env.outDir());
  const durationMs = ugcDurationMs(await probeVideo(opts.clip));
  const id = randomBytes(6).toString('hex');
  const to = `s/${id}/clip${path.extname(opts.clip).toLowerCase() || '.mp4'}`;
  const files = [{ from: opts.clip, to }];
  let music = null;
  if (opts.music) {
    const { file, ...mix } = opts.music;
    files.push({ from: file, to: `s/${id}/music.m4a` });
    music = { src: `s/${id}/music.m4a`, ...mix };
  }
  const inputProps = { clipSrc: to, caption: opts.caption, top: ugcTop(opts.config), fontPx: opts.config.ugc.captionPx, durationMs, music };
  await renderStaged({ composition: 'Ugc', id, files, inputProps, outFile, config: opts.config, signal: opts.signal });
}

// Lays out already-extracted 270x480 PNGs 4x2 in one 1080x960 PNG using the "Sheet" composition.
export async function renderSheet(framePngs: string[], outFile: string): Promise<void> {
  const serveUrl = await getBundle();
  const id = randomBytes(6).toString('hex');
  const dir = path.join(serveUrl, 'public', 's', id);
  try {
    const names = framePngs.map((f, i) => {
      const to = `s/${id}/${i}.png`;
      mkdirSync(dir, { recursive: true });
      copyFileSync(f, path.join(serveUrl, 'public', to));
      return to;
    });
    const inputProps = { frames: names };
    const composition = await selectComposition({ serveUrl, id: 'Sheet', inputProps });
    await renderStill({ composition, serveUrl, inputProps, output: outFile, imageFormat: 'png', logLevel: 'error' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
