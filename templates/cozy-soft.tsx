import React from 'react';
import { AbsoluteFill } from 'remotion';
import type { RenderProps } from '../src/contracts.ts';
import { alpha, cardSize, capLines, clamp, easeOut, endShot, fitHeadline, FH, FW, legible, mix, onColor, ShotView, Tracks, useCtx, type Ctx, type ShotLike } from './common.tsx';

// Light and calm: palette background, big floating rounded cards, serif type, crossfades, lower-third captions.
import { CAPTION_STYLES } from './caption-style.ts';
export const CAPTION_STYLE = CAPTION_STYLES['cozy-soft'];

const Background: React.FC<{ c: Ctx }> = ({ c }) => {
  const { pal, t } = c;
  const blob = (x: number, y: number, d: number, k: number, a: number): React.CSSProperties => ({ position: 'absolute', left: x + Math.sin(t / 2200 + k) * 60, top: y + Math.cos(t / 2600 + k) * 70, width: d, height: d, borderRadius: '50%', background: alpha(pal.accent, a), filter: 'blur(70px)' });
  return (
    <AbsoluteFill style={{ background: `radial-gradient(ellipse at 50% 38%, ${mix(pal.bg, '#FFFFFF', 0.4)} 0%, ${pal.bg} 55%, ${mix(pal.bg, pal.ink, 0.16)} 100%)` }}>
      <div style={blob(-200, 150, 700, 0, 0.16)} />
      <div style={blob(600, 1150, 800, 2, 0.14)} />
    </AbsoluteFill>
  );
};

const Float: React.FC<{ t: number; k?: number; style: React.CSSProperties; children: React.ReactNode }> = ({ t, k = 0, style, children }) => (
  <div style={{ position: 'absolute', ...style, transform: `${style.transform ?? ''} translateY(${Math.sin(t / 900 + k) * 12}px) rotate(${Math.sin(t / 1400 + k) * 0.8}deg)` }}>{children}</div>
);

const cardStyle: React.CSSProperties = { borderRadius: 48, overflow: 'hidden', boxShadow: '0 40px 90px rgba(58,42,32,.28), 0 8px 24px rgba(58,42,32,.18)' };

const Headline: React.FC<{ c: Ctx; px: number; lines: string[] }> = ({ c, px, lines }) => {
  const { S, pal, beatT } = c;
  return (
    <div style={{ position: 'absolute', left: S.x0, top: S.y0, width: S.w, textAlign: 'center', fontFamily: 'Fraunces', fontWeight: 600, fontSize: px, lineHeight: 1.08, color: pal.ink }}>
      {lines.map((l, i) => {
        const k = easeOut((beatT - 150 - i * 260) / 520);
        return (
          <div key={i} style={{ overflow: 'hidden', paddingBottom: px * 0.1 }}>
            <div style={{ transform: `translateY(${(1 - k) * px * 1.1}px)`, opacity: k }}>{l}</div>
          </div>
        );
      })}
    </div>
  );
};

// Main card for the current shot, crossfading from the previous one, with the next shot peeking in at its corner.
const Cards: React.FC<{ c: Ctx; place: (h: number) => number; maxW: number; maxH: number; peek?: boolean }> = ({ c, place, maxW, maxH, peek = true }) => {
  const { beat, si, shotT, prevBeat, t, sp, nextShot, shot } = c;
  const prev: ShotLike | null = si > 0 ? beat.shots[si - 1] : prevBeat ? prevBeat.shots[prevBeat.shots.length - 1] : null;
  const fade = easeOut(shotT / 500);
  const main = (s: ShotLike & { motion: typeof shot.motion }, o: number, k: number, p: number) => {
    const { w, h } = cardSize(s, maxW, maxH);
    const top = place(h);
    return (
      <Float key={s.src + String(s.crop?.x) + k} t={t} k={k} style={{ left: (FW - w) / 2, top, width: w, height: h, opacity: o, transform: `scale(${1 + 0.05 * p})` }}>
        <ShotView shot={s} w={w} h={h} motion="still" style={cardStyle} p={p} />
      </Float>
    );
  };
  const cur = main(shot, fade, si, sp);
  const old = fade < 1 && prev ? main({ ...(prev as ShotLike), motion: 'still' }, 1 - fade, si + 9, 1) : null;
  const { w, h } = cardSize(shot, maxW, maxH);
  const top = place(h);
  let small: React.ReactNode = null;
  if (peek && nextShot && sp > 0.35) {
    const sz = cardSize(nextShot, 340, 400);
    const k = easeOut((sp - 0.35) / 0.2);
    small = (
      <Float t={t} k={si + 3} style={{ left: (FW + w) / 2 - sz.w * 0.55, top: top + h - sz.h * 0.7, width: sz.w, height: sz.h, opacity: k, transform: `scale(${0.8 + 0.2 * k}) rotate(4deg)` }}>
        <ShotView shot={nextShot} w={sz.w} h={sz.h} style={{ ...cardStyle, borderRadius: 36, border: `8px solid ${c.pal.plate}`, boxSizing: 'border-box' }} />
      </Float>
    );
  }
  return (
    <>
      {old}
      {cur}
      {small}
    </>
  );
};

const Offer: React.FC<{ c: Ctx; capH: number }> = ({ c, capH }) => {
  const { beat, S, t, pal, edl, priceAt } = c;
  const d = 390;
  const pk = easeOut((t - priceAt) / 600);
  const px = 210;
  const priceTop = Math.max(S.y0 + 20, Math.round(FH * 0.2));
  const top = priceTop + px * 1.1 + 40;
  const pos = [
    { x: 150, y: 0 },
    { x: 540, y: 0 },
    { x: 345, y: 290 },
  ];
  void capH;
  return (
    <>
      <div style={{ position: 'absolute', left: S.x0, width: S.w, top: priceTop, textAlign: 'center', fontFamily: 'Fraunces', fontWeight: 700, fontSize: px, lineHeight: 1.05, color: legible(pal.accent, pal.bg), opacity: pk, transform: `translateY(${(1 - pk) * 50}px)`, whiteSpace: 'nowrap' }}>
        {edl.endCard.priceText}
      </div>
      {beat.shots.map((s, i) => {
        const k = easeOut((t - s.startMs) / 500);
        return (
          <div key={i} style={{ position: 'absolute', left: pos[i % 3].x, top: top + pos[i % 3].y, width: d, height: d, zIndex: i, borderRadius: '50%', overflow: 'hidden', border: `10px solid ${pal.plate}`, boxSizing: 'border-box', boxShadow: '0 24px 60px rgba(58,42,32,.3)', opacity: k, transform: `scale(${0.6 + 0.4 * k}) translateY(${Math.sin(t / 800 + i * 1.7) * 10}px)` }}>
            <ShotView shot={s} w={d} h={d} motion={s.motion} p={clamp((t - s.startMs) / 2500)} />
          </div>
        );
      })}
    </>
  );
};

const EndCard: React.FC<{ c: Ctx; capH: number }> = ({ c, capH }) => {
  const { edl, pal, S, beatT, beatP, t, cta } = c;
  const e = edl.endCard;
  const item = (i: number): React.CSSProperties => {
    const k = easeOut((beatT - i * 110) / 420);
    return { opacity: k, transform: `translateY(${(1 - k) * 36}px)` };
  };
  const panelBg = mix(pal.bg, '#FFFFFF', 0.55);
  const w = Math.min(800, FW - 100);
  return (
    <div style={{ position: 'absolute', left: S.x0, width: S.w, bottom: FH - (S.y1 - capH - 14), display: 'flex', flexDirection: 'column', alignItems: 'center', color: pal.ink }}>
      <div style={{ ...item(0), transform: `translateY(${Math.sin(t / 900) * 10}px)`, width: w, height: 700, marginBottom: -80 }}>
        <ShotView shot={endShot(edl)} w={w} h={700} motion="push-in" p={beatP} style={cardStyle} />
      </div>
      <div style={{ ...item(1), width: Math.min(S.w, 860), boxSizing: 'border-box', background: panelBg, borderRadius: 44, padding: '20px 28px 56px', textAlign: 'center', boxShadow: '0 30px 70px rgba(58,42,32,.25)', zIndex: 2 }}>
        <div style={{ fontFamily: 'Fraunces', fontWeight: 600, fontSize: 56, lineHeight: 1.1 }}>{e.title}</div>
        <div style={{ fontFamily: 'Fraunces', fontWeight: 700, fontSize: 160, lineHeight: 1.05, color: legible(pal.accent, panelBg) }}>{e.priceText}</div>
        <div style={{ fontFamily: 'Fraunces', fontWeight: 600, fontStyle: 'italic', fontSize: 44 }}>
          {e.shopName} <span style={{ fontFamily: 'Inter', fontStyle: 'normal', fontWeight: 500, fontSize: 30 }}>{e.shopDomain}</span>
        </div>
        {e.disclosures.map((d) => (
          <div key={d} style={{ fontFamily: 'Inter', fontWeight: 500, fontSize: 30, lineHeight: 1.3 }}>{d}</div>
        ))}
      </div>
      <div style={{ ...item(2), marginTop: -40, zIndex: 3, background: pal.accent, color: onColor(pal.accent), fontFamily: 'Fraunces', fontWeight: 700, fontSize: 56, padding: '16px 72px', borderRadius: 999, boxShadow: '0 16px 40px rgba(58,42,32,.3)', whiteSpace: 'nowrap', transform: `${item(2).transform} scale(${1 + 0.03 * Math.sin(t / 260)})` }}>{cta}</div>
    </div>
  );
};

const Captions: React.FC<{ c: Ctx }> = ({ c }) => {
  const { cap, active, t, S, safe, pal } = c;
  if (!cap) return null;
  const k = easeOut((t - cap.startMs) / 220);
  return (
    <div style={{ position: 'absolute', left: S.x0, width: S.w, bottom: safe.bottom, opacity: k, transform: `translateX(${(1 - k) * -50}px)` }}>
      <div style={{ background: alpha(CAPTION_STYLE.plateHex, CAPTION_STYLE.plateAlpha), borderRadius: 28, borderLeft: `14px solid ${pal.accent}`, padding: '18px 32px 20px 30px', boxSizing: 'border-box', fontFamily: 'Fraunces', fontWeight: 600, fontSize: CAPTION_STYLE.fontPx, lineHeight: 1.2, color: CAPTION_STYLE.textHex, boxShadow: '0 14px 40px rgba(58,42,32,.22)' }}>
        {cap.words.map((w, i) => (
          <span key={i}>
            <span style={i === active ? { textDecoration: 'underline', textDecorationColor: pal.accent, textDecorationThickness: 8, textUnderlineOffset: 8 } : undefined}>{w.text}</span>
            {i < cap.words.length - 1 ? ' ' : ''}
          </span>
        ))}
      </div>
    </div>
  );
};

export const Template: React.FC<RenderProps> = (props) => {
  const c = useCtx(props);
  const { edl, S, kind } = c;
  const head = fitHeadline(edl.headline, S.w, 0.56, 100, 135, 3);
  const headH = head.lines.length * head.px * 1.18;
  const capH = Math.round(capLines(edl, CAPTION_STYLE.fontPx, 0.5, S.w) * CAPTION_STYLE.fontPx * 1.2 + 40);
  let body: React.ReactNode = null;
  const lowQuarter = S.y1 + 90; // portrait cards end here so the caption plate lands on their lower quarter
  if (kind === 'hook') {
    const top = S.y0 + headH + 30;
    body = (
      <>
        <Cards c={c} place={() => top} maxW={940} maxH={lowQuarter - top} />
        <Headline c={c} px={head.px} lines={head.lines} />
      </>
    );
  } else if (kind === 'benefit') body = <Cards c={c} place={(h) => (h > FH * 0.45 ? lowQuarter - h : Math.round(FH * 0.52 - h / 2))} maxW={940} maxH={1150} />;
  else if (kind === 'offer') body = <Offer c={c} capH={capH + 20} />;
  else body = <EndCard c={c} capH={capH} />;
  return (
    <AbsoluteFill style={{ fontFamily: 'Fraunces' }}>
      <Background c={c} />
      {body}
      <Captions c={c} />
      <Tracks edl={edl} />
    </AbsoluteFill>
  );
};
