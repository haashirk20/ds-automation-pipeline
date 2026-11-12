import React, { useEffect, useState } from 'react';
import { Audio, continueRender, delayRender, Img, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import type { Edl, RenderProps } from '../src/contracts.ts';
import antonUrl from '@fontsource/anton/files/anton-latin-400-normal.woff2';
import interRegUrl from '@fontsource/inter/files/inter-latin-500-normal.woff2';
import inter700Url from '@fontsource/inter/files/inter-latin-700-normal.woff2';
import interUrl from '@fontsource/inter/files/inter-latin-800-normal.woff2';
import fraunces600Url from '@fontsource/fraunces/files/fraunces-latin-600-normal.woff2';
import fraunces700Url from '@fontsource/fraunces/files/fraunces-latin-700-normal.woff2';
import fraunces600iUrl from '@fontsource/fraunces/files/fraunces-latin-600-italic.woff2';

export const FW = 1080;
export const FH = 1920;

const FONTS: [string, string, string, string?][] = [
  ['Anton', antonUrl, '400'],
  ['Inter', interRegUrl, '500'],
  ['Inter', inter700Url, '700'],
  ['Inter', interUrl, '800'],
  ['Fraunces', fraunces600Url, '600'],
  ['Fraunces', fraunces700Url, '700'],
  ['Fraunces', fraunces600iUrl, '600', 'italic'],
];
let fontsReady: Promise<unknown> | null = null;
function loadFonts() {
  fontsReady ??= Promise.all(
    FONTS.map(async ([family, url, weight, style]) => {
      const f = await new FontFace(family, `url(${url})`, { weight, style: style ?? 'normal' }).load();
      document.fonts.add(f);
    }),
  );
  return fontsReady;
}

export type Beat = Edl['beats'][number];
export type ShotT = Beat['shots'][number];
export type Safe = RenderProps['safe'];
export type ShotLike = { src: string; width: number; height: number; crop: ShotT['crop'] };

export const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
export const easeOut = (x: number) => 1 - (1 - clamp(x)) ** 3;
export const backOut = (x: number) => {
  const c = 1.9;
  const y = clamp(x) - 1;
  return 1 + (c + 1) * y ** 3 + c * y ** 2;
};
export const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
export const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
export const mix = (a: string, b: string, t: number) =>
  '#' + [1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t).toString(16).padStart(2, '0')).join('');
export const alpha = (hex: string, a: number) => hex + Math.round(clamp(a) * 255).toString(16).padStart(2, '0');
// Moves a colour away from its surface (lighter on dark, darker on light) until it reads at 4.5:1.
export const legible = (c: string, on: string) => {
  let out = c;
  const to = lum(on) < 0.4 ? '#FFFFFF' : '#000000';
  for (let i = 0; i < 12 && contrast(out, on) < 4.5; i++) out = mix(out, to, 0.15);
  return out;
};
export const onColor = (bg: string) => (contrast('#000000', bg) >= contrast('#FFFFFF', bg) ? '#000000' : '#FFFFFF');

export const cropOf = (s: Pick<ShotLike, 'crop'>) => s.crop ?? { x: 0, y: 0, w: 1, h: 1 };
export const shotAspect = (s: ShotLike) => (cropOf(s).w * s.width) / (cropOf(s).h * s.height);
// Largest box with the crop's aspect that fits maxW x maxH.
export function cardSize(s: ShotLike, maxW: number, maxH: number) {
  const a = shotAspect(s);
  const w = Math.min(maxW, maxH * a);
  return { w: Math.round(w), h: Math.round(w / a) };
}

// Splits a headline into at most maxLines balanced lines and picks the largest font size that fits.
export function fitHeadline(text: string, width: number, charW: number, minPx: number, maxPx: number, maxLines: number) {
  const words = text.split(/\s+/).filter(Boolean);
  let best = { lines: [text], px: minPx };
  let bestPx = 0;
  for (let n = 1; n <= Math.min(maxLines, words.length); n++) {
    const target = text.length / n;
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (cur && next.length > target && lines.length < n - 1) {
        lines.push(cur);
        cur = w;
      } else cur = next;
    }
    lines.push(cur);
    const px = Math.min(maxPx, width / (Math.max(...lines.map((l) => l.length)) * charW));
    if (px > bestPx + 6 || (n === 1 && px >= maxPx)) {
      bestPx = px;
      best = { lines, px: Math.floor(px) };
    }
  }
  best.px = Math.max(Math.min(best.px, maxPx), Math.min(minPx, best.px));
  return best;
}

// Shows the crop region of a shot so it fills the box: cover fit, nothing outside the crop, no stretch.
export const ShotView: React.FC<{ shot: ShotLike; w: number; h: number; motion?: ShotT['motion']; p?: number; blur?: number; dim?: number; style?: React.CSSProperties }> = ({ shot, w, h, motion = 'still', p = 0, blur = 0, dim = 1, style }) => {
  const c = cropOf(shot);
  const cw = c.w * shot.width;
  const ch = c.h * shot.height;
  const scale = Math.max(w / cw, h / ch);
  const zoom = motion === 'push-in' ? 1 + 0.12 * p : motion === 'pull-out' ? 1.12 - 0.12 * p : motion === 'still' ? 1 : 1.1;
  const pan = motion === 'pan-left' ? (0.5 - p) * 0.08 * w : motion === 'pan-right' ? (p - 0.5) * 0.08 * w : 0;
  const ox = (w - cw * scale) / 2 - c.x * shot.width * scale;
  const oy = (h - ch * scale) / 2 - c.y * shot.height * scale;
  return (
    <div style={{ width: w, height: h, overflow: 'hidden', position: 'relative', ...style }}>
      <Img
        src={staticFile(shot.src)}
        style={{
          position: 'absolute',
          width: shot.width * scale,
          height: shot.height * scale,
          left: ox,
          top: oy,
          maxWidth: 'none',
          transformOrigin: `${(c.x + c.w / 2) * shot.width * scale + ox}px ${(c.y + c.h / 2) * shot.height * scale + oy}px`,
          transform: `translateX(${pan}px) scale(${zoom})`,
          filter: blur || dim !== 1 ? `blur(${blur}px) brightness(${dim})` : undefined,
        }}
      />
    </div>
  );
};

export const endShot = (edl: Edl): ShotLike => ({ src: edl.endCard.shotSrc, width: edl.endCard.shotWidth, height: edl.endCard.shotHeight, crop: edl.endCard.shotCrop });

export type Ctx = ReturnType<typeof useCtx>;

// Time, beat, shot, caption and layout facts every template needs.
export function useCtx({ edl, safe, cta, platform }: RenderProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const [handle] = useState(() => delayRender('fonts'));
  useEffect(() => {
    loadFonts().then(() => continueRender(handle), () => continueRender(handle));
  }, [handle]);
  const t = (frame / fps) * 1000;
  const found = edl.beats.findIndex((b) => t >= b.startMs && t < b.endMs);
  const bi = found < 0 ? edl.beats.length - 1 : found;
  const beat = edl.beats[bi];
  const si = Math.max(0, beat.shots.findIndex((s) => t >= s.startMs && t < s.endMs));
  const shot = beat.shots[si < 0 ? beat.shots.length - 1 : si];
  const sp = clamp((t - shot.startMs) / Math.max(1, shot.endMs - shot.startMs));
  const ci = edl.captions.findIndex((c) => t >= c.startMs && t < c.endMs);
  const cap = ci >= 0 ? edl.captions[ci] : null;
  const active = cap ? cap.words.reduce((a, w, i) => (w.startMs <= t ? i : a), 0) : 0;
  const priceIdx = edl.captions.findIndex((c) => c.words.map((w) => w.text).join(' ').includes(edl.endCard.priceText));
  const offer = edl.beats.find((b) => b.kind === 'offer');
  const priceAt = priceIdx >= 0 ? edl.captions[priceIdx].startMs : offer ? offer.startMs + (offer.endMs - offer.startMs) / 2 : 0;
  const S = { x0: safe.left, y0: safe.top, x1: FW - safe.right, y1: FH - safe.bottom, w: FW - safe.left - safe.right, h: FH - safe.top - safe.bottom };
  const prevBeat = edl.beats[bi - 1];
  const nextShot = beat.shots[si + 1] ?? edl.beats[bi + 1]?.shots[0] ?? null;
  return { edl, safe, cta, platform, frame, fps, t, bi, beat, kind: beat.kind, si, shot, sp, beatP: clamp((t - beat.startMs) / (beat.endMs - beat.startMs)), beatT: t - beat.startMs, shotT: t - shot.startMs, cap, ci, active, priceAt, S, prevBeat, nextShot, vp: t / edl.durationMs, pal: edl.palette };
}

// Music: base gain, 8 dB lower while a caption shows (150 ms ramps), 600 ms fade at the end.
function musicVolume(edl: Edl, t: number): number {
  let duck = 0;
  for (const c of edl.captions) duck = Math.max(duck, clamp(Math.min((t - c.startMs) / 150, (c.endMs + 150 - t) / 150)));
  return Math.min(1, 10 ** ((edl.audio.musicGainDb - 8 * duck) / 20)) * clamp((edl.durationMs - t) / 600);
}
export const Tracks: React.FC<{ edl: Edl }> = ({ edl }) => {
  const { fps } = useVideoConfig();
  return (
    <>
      <Audio src={staticFile(edl.audio.voiceSrc)} />
      {edl.audio.musicSrc && <Audio src={staticFile(edl.audio.musicSrc)} volume={(f) => musicVolume(edl, (f / fps) * 1000)} />}
    </>
  );
};

// Estimated number of caption lines for the end card (used to reserve room at the bottom of the safe area).
export function capLines(edl: Edl, fontPx: number, charW: number, width: number): number {
  const cta = edl.beats[3];
  const caps = edl.captions.filter((c) => c.startMs >= cta.startMs - 200);
  const chars = Math.max(0, ...caps.map((c) => c.words.map((w) => w.text).join(' ').length));
  return Math.min(2, Math.max(1, Math.ceil((chars * charW * fontPx) / (width - 90))));
}

export const abs = (x: number, y: number, w: number, h: number, extra: React.CSSProperties = {}): React.CSSProperties => ({ position: 'absolute', left: x, top: y, width: w, height: h, ...extra });
