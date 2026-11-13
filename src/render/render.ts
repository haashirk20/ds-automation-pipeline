import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { makeCancelSignal, renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import { env, type Config, type PlatformName } from '../config/index.ts';
import { Edl, type RenderProps } from '../contracts.ts';
import { ff } from './ffmpeg.ts';

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

let bundled: Promise<string> | null = null;
// One bundle per template version, kept in a stable cache directory (BUNDLE_CACHE_DIR; the Docker image
// builds it ahead of time) and shared by every process. Renders add their files under <bundle>/public/.
export function getBundle(): Promise<string> {
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
  return bundled;
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
export async function normalizeLoudness(inFile: string, outFile: string): Promise<{ inputLufs: number }> {
  const target = 'I=-14:TP=-1:LRA=11';
  const m = await ff('ffmpeg', ['-hide_banner', '-nostdin', '-i', inFile, '-vn', '-af', `loudnorm=${target}:print_format=json`, '-f', 'null', '-']);
  const json = JSON.parse(m.stderr.slice(m.stderr.lastIndexOf('{'), m.stderr.lastIndexOf('}') + 1));
  const af = `loudnorm=${target}:measured_I=${json.input_i}:measured_TP=${json.input_tp}:measured_LRA=${json.input_lra}:measured_thresh=${json.input_thresh}:offset=${json.target_offset}:linear=true`;
  await ff('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-i', inFile, '-map', '0:v', '-map', '0:a', '-c:v', 'copy', '-af', af, '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', outFile]);
  return { inputLufs: Number(json.input_i) };
}

export async function renderEdl(opts: { edl: Edl; platform: PlatformName; config: Config; outFile: string; signal?: AbortSignal }): Promise<void> {
  const outFile = assertInside(opts.outFile, env.outDir());
  const edl = Edl.parse(opts.edl);
  const p = opts.config.platforms[opts.platform];
  const serveUrl = await getBundle();
  const id = randomBytes(6).toString('hex');
  const plan = planStaging(edl, id);
  const stagedDir = path.join(serveUrl, 'public', 's', id);
  mkdirSync(path.dirname(outFile), { recursive: true });
  const raw = outFile + '.raw.mp4';
  try {
    stageFiles(serveUrl, plan.files);
    const inputProps: RenderProps = { edl: plan.edl, platform: opts.platform, safe: p.safe, cta: p.cta };
    const composition = await selectComposition({ serveUrl, id: 'Ad', inputProps });
    // Remotion starts Chrome in its own process group; cancelling is the only way to stop it.
    const { cancelSignal, cancel } = makeCancelSignal();
    if (opts.signal?.aborted) cancel();
    opts.signal?.addEventListener('abort', cancel, { once: true });
    await renderMedia({ composition, serveUrl, inputProps, codec: 'h264', pixelFormat: 'yuv420p', audioCodec: 'aac', outputLocation: raw, logLevel: 'error', cancelSignal });
    await normalizeLoudness(raw, outFile);
  } finally {
    rmSync(stagedDir, { recursive: true, force: true });
    rmSync(raw, { force: true });
  }
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
