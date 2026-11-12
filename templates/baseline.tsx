import React, { useEffect, useState } from 'react';
import { AbsoluteFill, Audio, continueRender, delayRender, Img, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import type { Edl, RenderProps } from '../src/contracts.ts';
import antonUrl from '@fontsource/anton/files/anton-latin-400-normal.woff2';
import interUrl from '@fontsource/inter/files/inter-latin-800-normal.woff2';
import interRegUrl from '@fontsource/inter/files/inter-latin-500-normal.woff2';
import frauncesUrl from '@fontsource/fraunces/files/fraunces-latin-600-normal.woff2';

// Read by the QA layout check. Captions are white on a dark plate whatever the palette.
export const CAPTION_STYLE = { fontPx: 68, textHex: '#FFFFFF', plateHex: '#000000', plateAlpha: 0.78 };

const FONTS: [string, string, string][] = [
  ['Anton', antonUrl, '400'],
  ['Inter', interUrl, '800'],
  ['Inter', interRegUrl, '500'],
  ['Fraunces', frauncesUrl, '600'],
];
let fontsReady: Promise<unknown> | null = null;
function loadFonts() {
  fontsReady ??= Promise.all(
    FONTS.map(async ([family, url, weight]) => {
      const f = await new FontFace(family, `url(${url})`, { weight }).load();
      document.fonts.add(f);
    }),
  );
  return fontsReady;
}

type Beat = Edl['beats'][number];
type ShotT = Beat['shots'][number];
type Safe = RenderProps['safe'];
type CropT = ShotT['crop'];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const mix = (a: string, b: string, t: number) =>
  '#' + [1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t).toString(16).padStart(2, '0')).join('');
// Moves a colour away from its surface (lighter on dark, darker on light) until it reads.
const legible = (c: string, on: string) => {
  let out = c;
  const to = lum(on) < 0.4 ? '#FFFFFF' : '#000000';
  for (let i = 0; i < 10 && contrast(out, on) < 4.5; i++) out = mix(out, to, 0.15);
  return out;
};
const onColor = (bg: string) => (contrast('#000000', bg) >= contrast('#FFFFFF', bg) ? '#000000' : '#FFFFFF');

// Shows the crop region of a shot so it fills the box: cover fit, nothing outside the crop, no stretch.
const ShotView: React.FC<{ shot: Pick<ShotT, 'src' | 'width' | 'height' | 'crop'>; w: number; h: number; motion: ShotT['motion']; p: number; blur?: number; dim?: number }> = ({ shot, w, h, motion, p, blur = 0, dim = 1 }) => {
  const c = shot.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const cw = c.w * shot.width;
  const ch = c.h * shot.height;
  const scale = Math.max(w / cw, h / ch);
  const zoom = motion === 'push-in' ? 1 + 0.12 * p : motion === 'pull-out' ? 1.12 - 0.12 * p : motion === 'still' ? 1 : 1.1;
  const pan = motion === 'pan-left' ? (0.5 - p) * 0.08 * w : motion === 'pan-right' ? (p - 0.5) * 0.08 * w : 0;
  return (
    <div style={{ width: w, height: h, overflow: 'hidden', position: 'relative' }}>
      <Img
        src={staticFile(shot.src)}
        style={{
          position: 'absolute',
          width: shot.width * scale,
          height: shot.height * scale,
          left: (w - cw * scale) / 2 - c.x * shot.width * scale,
          top: (h - ch * scale) / 2 - c.y * shot.height * scale,
          maxWidth: 'none',
          transformOrigin: `${(c.x + c.w / 2) * shot.width * scale + (w - cw * scale) / 2 - c.x * shot.width * scale}px ${(c.y + c.h / 2) * shot.height * scale + (h - ch * scale) / 2 - c.y * shot.height * scale}px`,
          transform: `translateX(${pan}px) scale(${zoom})`,
          filter: blur || dim !== 1 ? `blur(${blur}px) brightness(${dim})` : undefined,
        }}
      />
    </div>
  );
};

const Backdrop: React.FC<{ shot: ShotT | { src: string; width: number; height: number; crop: CropT }; bg: string; t: number; p: number }> = ({ shot, bg, p }) => (
  <AbsoluteFill style={{ background: bg }}>
    <div style={{ position: 'absolute', inset: -80 }}>
      <ShotView shot={shot} w={1240} h={2080} motion="push-in" p={p} blur={45} dim={0.55} />
    </div>
    <AbsoluteFill style={{ background: bg, opacity: 0.35 }} />
  </AbsoluteFill>
);

const Card: React.FC<{ shot: ShotT; box: { x0: number; y0: number; w: number; h: number }; p: number; frame: number }> = ({ shot, box, p }) => {
  const c = shot.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const aspect = (c.w * shot.width) / (c.h * shot.height);
  const w = clamp(box.h * aspect, 600, 900);
  return (
    <div style={{ position: 'absolute', left: (1080 - w) / 2, top: box.y0, borderRadius: 36, overflow: 'hidden', boxShadow: '0 24px 70px rgba(0,0,0,0.55)' }}>
      <ShotView shot={shot} w={w} h={box.h} motion={shot.motion} p={p} />
    </div>
  );
};

const Captions: React.FC<{ edl: Edl; safe: Safe; t: number }> = ({ edl, safe, t }) => {
  const cap = edl.captions.find((c) => t >= c.startMs && t < c.endMs);
  if (!cap) return null;
  const active = cap.words.reduce((a, w, i) => (w.startMs <= t ? i : a), 0);
  const hi = legible(edl.palette.accent, CAPTION_STYLE.plateHex);
  return (
    <div style={{ position: 'absolute', left: safe.left, width: 1080 - safe.left - safe.right, bottom: safe.bottom, display: 'flex', justifyContent: 'center' }}>
      <div
        style={{
          background: `${CAPTION_STYLE.plateHex}${Math.round(CAPTION_STYLE.plateAlpha * 255).toString(16).padStart(2, '0')}`,
          borderRadius: 30,
          padding: '20px 34px',
          maxWidth: '100%',
          boxSizing: 'border-box',
          textAlign: 'center',
          fontFamily: 'Inter',
          fontWeight: 800,
          fontSize: CAPTION_STYLE.fontPx,
          lineHeight: 1.15,
          color: CAPTION_STYLE.textHex,
        }}
      >
        {cap.words.map((w, i) => (
          <span key={i} style={{ color: i === active ? hi : CAPTION_STYLE.textHex }}>
            {w.text}
            {i < cap.words.length - 1 ? ' ' : ''}
          </span>
        ))}
      </div>
    </div>
  );
};

const CAP_H = 220; // two caption lines plus padding

const Headline: React.FC<{ edl: Edl; safe: Safe; t: number; beat: Beat }> = ({ edl, safe, t, beat }) => {
  const k = clamp((t - beat.startMs) / 350, 0, 1);
  const n = edl.headline.length;
  const font = n > 40 ? 84 : n > 24 ? 100 : 120;
  return (
    <div style={{ position: 'absolute', left: safe.left, width: 1080 - safe.left - safe.right, top: safe.top, display: 'flex', justifyContent: 'center', opacity: k, transform: `translateY(${(1 - k) * 30}px)` }}>
      <div style={{ background: edl.palette.bg, color: edl.palette.ink, borderRadius: 28, padding: '22px 36px', maxWidth: '100%', boxSizing: 'border-box', textAlign: 'center', fontFamily: 'Anton', fontSize: font, lineHeight: 1.08, textTransform: 'uppercase', border: `6px solid ${edl.palette.accent}` }}>
        {edl.headline}
      </div>
    </div>
  );
};

const EndCard: React.FC<{ edl: Edl; safe: Safe; cta: string; t: number; beat: Beat }> = ({ edl, safe, cta, t, beat }) => {
  const e = edl.endCard;
  const k = clamp((t - beat.startMs) / 400, 0, 1);
  const p = clamp((t - beat.startMs) / (beat.endMs - beat.startMs), 0, 1);
  const c = e.shotCrop ?? { x: 0, y: 0, w: 1, h: 1 };
  const aspect = (c.w * e.shotWidth) / (c.h * e.shotHeight);
  const imgH = 220;
  const imgW = clamp(imgH * aspect, 300, 900);
  const sw = 1080 - safe.left - safe.right;
  const pulse = 1 + 0.03 * Math.sin(t / 260);
  const S: React.CSSProperties = { textAlign: 'center', maxWidth: sw };
  return (
    <div style={{ position: 'absolute', left: safe.left, width: sw, top: safe.top, height: 1920 - safe.top - safe.bottom - CAP_H, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'space-evenly', opacity: k, transform: `translateY(${Math.sin(t / 500) * 10}px)`, color: edl.palette.ink }}>
      <div style={{ borderRadius: 32, overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }}>
        <ShotView shot={{ src: e.shotSrc, width: e.shotWidth, height: e.shotHeight, crop: e.shotCrop }} w={imgW} h={imgH} motion="push-in" p={p} />
      </div>
      <div style={{ background: edl.palette.bg, borderRadius: 28, padding: '12px 32px', ...S, boxSizing: 'border-box' }}>
        <div style={{ fontFamily: 'Inter', fontWeight: 800, fontSize: 52, lineHeight: 1.1 }}>{e.title}</div>
        <div style={{ fontFamily: 'Anton', fontSize: 130, lineHeight: 1.05, color: legible(edl.palette.accent, edl.palette.bg) }}>{e.priceText}</div>
        <div style={{ fontFamily: 'Inter', fontWeight: 500, fontSize: 44 }}>{e.shopName}</div>
      </div>
      <div style={{ background: edl.palette.accent, color: onColor(edl.palette.accent), fontFamily: 'Inter', fontWeight: 800, fontSize: 56, padding: '16px 56px', borderRadius: 999, transform: `scale(${pulse})`, ...S, boxSizing: 'border-box' }}>{cta}</div>
      <div style={{ ...S, fontFamily: 'Inter', fontWeight: 500, fontSize: 30, lineHeight: 1.2, background: `${edl.palette.bg}CC`, borderRadius: 16, padding: '6px 20px', boxSizing: 'border-box' }}>
        {e.shopDomain}
        {e.disclosures.map((d) => (
          <div key={d}>{d}</div>
        ))}
      </div>
    </div>
  );
};

// Music level in dB at time t: base gain, 8 dB lower while a caption shows (150 ms ramps), 600 ms end fade.
function musicVolume(edl: Edl, t: number): number {
  let duck = 0;
  for (const c of edl.captions) duck = Math.max(duck, clamp(Math.min((t - c.startMs) / 150, (c.endMs + 150 - t) / 150), 0, 1));
  const fade = clamp((edl.durationMs - t) / 600, 0, 1);
  return Math.min(1, 10 ** ((edl.audio.musicGainDb - 8 * duck) / 20)) * fade;
}

export const Baseline: React.FC<RenderProps> = ({ edl, safe, cta }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const [handle] = useState(() => delayRender('fonts'));
  useEffect(() => {
    loadFonts().then(() => continueRender(handle), () => continueRender(handle));
  }, [handle]);

  const t = (frame / fps) * 1000;
  const beat = edl.beats.find((b) => t >= b.startMs && t < b.endMs) ?? edl.beats[edl.beats.length - 1];
  const shot = beat.shots.find((s) => t >= s.startMs && t < s.endMs) ?? beat.shots[beat.shots.length - 1];
  const p = clamp((t - shot.startMs) / Math.max(1, shot.endMs - shot.startMs), 0, 1);
    const isHook = beat.kind === 'hook';
  const ctaP = clamp((t - edl.beats[3].startMs) / (edl.durationMs - edl.beats[3].startMs), 0, 1);
  const isCta = beat.kind === 'cta';
  const y0 = safe.top + (isHook ? 345 : 0);
  const box = { x0: 0, y0, w: 900, h: 1920 - safe.bottom - CAP_H - 10 - y0 };

  return (
    <AbsoluteFill style={{ fontFamily: 'Inter' }}>
      <Backdrop shot={isCta ? { src: edl.endCard.shotSrc, width: edl.endCard.shotWidth, height: edl.endCard.shotHeight, crop: edl.endCard.shotCrop } : shot} bg={edl.palette.bg} t={t} p={isCta ? ctaP : p} />
      {!isCta && <Card shot={shot} box={box} p={p} frame={frame} />}
      {isHook && <Headline edl={edl} safe={safe} t={t} beat={beat} />}
      {isCta && <EndCard edl={edl} safe={safe} cta={cta} t={t} beat={beat} />}
      <Captions edl={edl} safe={safe} t={t} />
      <Audio src={staticFile(edl.audio.voiceSrc)} />
      {edl.audio.musicSrc && <Audio src={staticFile(edl.audio.musicSrc)} volume={(f) => musicVolume(edl, (f / fps) * 1000)} />}
    </AbsoluteFill>
  );
};
