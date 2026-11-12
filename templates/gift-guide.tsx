import React from 'react';
import { AbsoluteFill } from 'remotion';
import type { RenderProps } from '../src/contracts.ts';
import { alpha, backOut, capLines, cardSize, clamp, easeOut, endShot, fitHeadline, FH, FW, mix, onColor, ShotView, Tracks, useCtx, type Ctx, type ShotLike } from './common.tsx';

// Festive editorial: deep background with dots and ribbons, tilted white-bordered prints, price tag.
export const CAPTION_STYLE = { fontPx: 66, textHex: '#FFF8EC', plateHex: '#12241B', plateAlpha: 0.9 };

const BORDER = 18;
const TILT = [-5, 4, -2.5, 5.5];
const DX = [-26, 34, -12, 22];

const Ribbon: React.FC<{ c: Ctx; x: number; y: number; angle: number; k: number }> = ({ c, x, y, angle, k }) => {
  const { pal, t } = c;
  const slide = Math.sin(t / 1800 + k) * 40;
  return (
    <div style={{ position: 'absolute', left: x + slide, top: y, width: 1700, height: 54, transform: `rotate(${angle}deg)`, transformOrigin: '0 0', background: `linear-gradient(180deg, ${pal.accent} 0 14%, ${alpha(pal.accent, 0.35)} 14% 28%, ${pal.accent} 28% 72%, ${alpha(pal.accent, 0.35)} 72% 86%, ${pal.accent} 86% 100%)`, opacity: 0.9, boxShadow: '0 8px 24px rgba(0,0,0,.35)' }} />
  );
};

const Background: React.FC<{ c: Ctx }> = ({ c }) => {
  const { pal, t } = c;
  const d = (t / 40) % 54;
  return (
    <AbsoluteFill style={{ background: `radial-gradient(ellipse at 50% 35%, ${mix(pal.bg, '#FFFFFF', 0.12)} 0%, ${pal.bg} 60%, ${mix(pal.bg, '#000000', 0.35)} 100%)` }}>
      <AbsoluteFill style={{ backgroundImage: `radial-gradient(circle, ${alpha(pal.accent, 0.3)} 3px, transparent 4px)`, backgroundSize: '54px 54px', backgroundPosition: `${d}px ${d}px` }} />
      <AbsoluteFill style={{ backgroundImage: 'repeating-linear-gradient(45deg, transparent 0 46px, rgba(255,255,255,.035) 46px 48px)' }} />
      <Ribbon c={c} x={-300} y={1720} angle={-18} k={0} />
      <Ribbon c={c} x={-200} y={1825} angle={-18} k={1.5} />
      <Ribbon c={c} x={700} y={-120} angle={32} k={3} />
    </AbsoluteFill>
  );
};

type Anim = { drop: number; tilt: number; dx: number };
const Print: React.FC<{ shot: ShotLike & { motion: 'push-in' }; cx: number; place: (outerH: number) => number; maxW: number; maxH: number; anim: Anim; t: number; p: number }> = ({ shot, cx, place, maxW, maxH, anim, t, p }) => {
  const top = 0;
  const { w, h } = cardSize(shot, maxW - 2 * BORDER, maxH - 2 * BORDER);
  const k = backOut(anim.drop);
  const y = place(h + 2 * BORDER);
  return (
    <div style={{ position: 'absolute', left: cx - w / 2 - BORDER + anim.dx, top: top + y + (1 - k) * -500, width: w + 2 * BORDER, height: h + 2 * BORDER, background: '#FFFFFF', padding: BORDER, boxSizing: 'border-box', transform: `rotate(${anim.tilt + (1 - k) * -12 + Math.sin(t / 1100) * 0.6}deg) scale(${1 + 0.04 * p})`, boxShadow: '0 28px 60px rgba(0,0,0,.55)', opacity: clamp(anim.drop * 6) }}>
      <ShotView shot={shot} w={w} h={h} motion="still" />
    </div>
  );
};

// The shots shown so far in this beat, newest on top; each new one drops in and shuffles the pile.
const Stack: React.FC<{ c: Ctx; place: (outerH: number) => number; maxW: number; maxH: number }> = ({ c, place, maxW, maxH }) => {
  const { beat, si, t, shotT, sp } = c;
  const from = Math.max(0, si - 2);
  const prints = [];
  for (let j = from; j <= si; j++) {
    const age = si - j;
    const s = beat.shots[j];
    const drop = j === si ? shotT / 420 : 1;
    prints.push(<Print key={j} shot={{ ...s, motion: 'push-in' }} cx={FW / 2} place={(h) => place(h) + age * -14} maxW={maxW - age * 40} maxH={maxH - age * 60} anim={{ drop, tilt: TILT[(j + beat.shots.length) % 4], dx: DX[j % 4] }} t={t} p={j === si ? sp : 1} />);
  }
  return <>{prints}</>;
};

const Headline: React.FC<{ c: Ctx; px: number; lines: string[] }> = ({ c, px, lines }) => {
  const { S, pal, beatT } = c;
  const wMax = Math.max(...lines.map((l) => l.length)) * 0.5 * px;
  const k = easeOut((beatT - 650) / 650);
  return (
    <div style={{ position: 'absolute', left: S.x0, top: S.y0, width: S.w, textAlign: 'center', fontFamily: 'Fraunces', fontWeight: 700, fontSize: px, lineHeight: 1.08, color: pal.ink, textShadow: '0 4px 24px rgba(0,0,0,.45)' }}>
      {lines.map((l, i) => {
        const a = easeOut((beatT - i * 200) / 450);
        return <div key={i} style={{ opacity: a, transform: `scale(${0.94 + 0.06 * a})` }}>{l}</div>;
      })}
      <div style={{ margin: '12px auto 0', height: 14, width: Math.min(S.w, wMax) * k, background: pal.accent, borderRadius: 7 }} />
    </div>
  );
};

const Tag: React.FC<{ text: string; w: number; h: number; px: number; pal: Ctx['pal']; swing: number }> = ({ text, w, h, px, pal, swing }) => (
  <div style={{ width: w, height: h, transform: `rotate(${swing}deg)`, transformOrigin: '8% 50%', filter: 'drop-shadow(0 18px 24px rgba(0,0,0,.5))' }}>
    <div style={{ width: '100%', height: '100%', background: pal.accent, clipPath: 'polygon(0 50%, 12% 0, 100% 0, 100% 100%, 12% 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', paddingLeft: '12%', boxSizing: 'border-box' }}>
      <span style={{ fontFamily: 'Fraunces', fontWeight: 700, fontSize: px, color: onColor(pal.accent), lineHeight: 1, whiteSpace: 'nowrap' }}>{text}</span>
    </div>
    <div style={{ position: 'absolute', left: '7%', top: '50%', width: 22, height: 22, marginTop: -11, borderRadius: '50%', background: pal.bg, boxShadow: 'inset 0 2px 4px rgba(0,0,0,.5)' }} />
  </div>
);

const Offer: React.FC<{ c: Ctx; capH: number }> = ({ c, capH }) => {
  const { beat, S, t, pal, edl, priceAt } = c;
  const tagH = 230;
  const centerY = Math.round(FH * 0.54);
  const tagTop = Math.min(centerY - 450, S.y1 - capH - 24 - tagH);
  const pk = backOut((t - priceAt) / 500);
  const rot = [-9, 1, 9];
  return (
    <>
      {beat.shots.map((s, i) => {
        if (t < s.startMs - 30) return null;
        const drop = (t - s.startMs) / 420;
        return <Print key={i} shot={{ ...s, motion: 'push-in' }} cx={FW / 2 + (i - 1) * 290} place={(h) => centerY - h / 2 + Math.abs(i - 1) * 30} maxW={420} maxH={560} anim={{ drop, tilt: rot[i % 3], dx: 0 }} t={t} p={clamp((t - s.startMs) / 2500)} />;
      })}
      {t >= priceAt && (
        <div style={{ position: 'absolute', left: (FW - 600) / 2, top: tagTop, width: 600, height: tagH, transform: `scale(${pk})`, opacity: clamp(pk * 2), zIndex: 9 }}>
          <Tag text={edl.endCard.priceText} w={600} h={tagH} px={130} pal={pal} swing={-5 + Math.sin(t / 380) * 3} />
        </div>
      )}
    </>
  );
};

const EndCard: React.FC<{ c: Ctx; capH: number }> = ({ c, capH }) => {
  const { edl, pal, S, beatT, beatP, t, cta } = c;
  const e = edl.endCard;
  const item = (i: number): React.CSSProperties => {
    const k = easeOut((beatT - i * 100) / 400);
    return { opacity: k, transform: `translateY(${(1 - k) * 36}px)` };
  };
  const pw = Math.min(760, Math.round(S.w * 0.84));
  const ph = 660;
  const k0 = backOut(beatT / 520);
  const line = <div style={{ flex: 1, height: 6, background: pal.accent, borderRadius: 3 }} />;
  return (
    <div style={{ position: 'absolute', left: S.x0, width: S.w, bottom: FH - (S.y1 - capH - 34), display: 'flex', flexDirection: 'column', alignItems: 'center', color: pal.ink }}>
      <div style={{ position: 'relative', width: S.w, height: ph + 2 * BORDER + 10, marginBottom: 10 }}>
        <div style={{ position: 'absolute', left: 0, top: 10, width: pw + 2 * BORDER, height: ph + 2 * BORDER, background: '#fff', padding: BORDER, boxSizing: 'border-box', transform: `rotate(${-4 + Math.sin(t / 1100) * 0.7}deg) scale(${k0})`, boxShadow: '0 28px 60px rgba(0,0,0,.55)' }}>
          <ShotView shot={endShot(edl)} w={pw} h={ph} motion="push-in" p={beatP} />
        </div>
        <div style={{ ...item(1), position: 'absolute', right: 24, top: 190 }}>
          <Tag text={e.priceText} w={Math.min(560, S.w - pw * 0.5 - 24)} h={190} px={120} pal={pal} swing={-6 + Math.sin(t / 380) * 3} />
        </div>
      </div>
      <div style={{ ...item(2), fontFamily: 'Fraunces', fontWeight: 700, fontSize: 54, lineHeight: 1.1, textAlign: 'center' }}>{e.title}</div>
      <div style={{ ...item(3), display: 'flex', alignItems: 'center', gap: 20, width: S.w, margin: '8px 0' }}>
        {line}
        <div style={{ fontFamily: 'Fraunces', fontWeight: 600, fontStyle: 'italic', fontSize: 44, whiteSpace: 'nowrap' }}>
          {e.shopName} <span style={{ fontFamily: 'Inter', fontStyle: 'normal', fontWeight: 500, fontSize: 30 }}>{e.shopDomain}</span>
        </div>
        {line}
      </div>
      <div style={{ ...item(4), background: pal.accent, color: onColor(pal.accent), fontFamily: 'Fraunces', fontWeight: 700, fontSize: 54, padding: '10px 80px', clipPath: 'polygon(0 0, 100% 0, 96% 50%, 100% 100%, 0 100%, 4% 50%)', whiteSpace: 'nowrap', transform: `${item(4).transform} scale(${1 + 0.03 * Math.sin(t / 260)})` }}>{cta}</div>
      <div style={{ ...item(5), fontFamily: 'Inter', fontWeight: 500, fontSize: 30, lineHeight: 1.25, textAlign: 'center', marginTop: 8 }}>
        {e.disclosures.map((d) => (
          <div key={d}>{d}</div>
        ))}
      </div>
    </div>
  );
};

const Captions: React.FC<{ c: Ctx }> = ({ c }) => {
  const { cap, active, t, S, safe, pal } = c;
  if (!cap) return null;
  const k = easeOut((t - cap.startMs) / 200);
  return (
    <div style={{ position: 'absolute', left: S.x0, width: S.w, bottom: safe.bottom, display: 'flex', justifyContent: 'center', opacity: k, transform: `translateY(${(1 - k) * 24}px)` }}>
      <div style={{ background: alpha(CAPTION_STYLE.plateHex, CAPTION_STYLE.plateAlpha), border: `3px solid ${pal.accent}`, borderRadius: 22, padding: '14px 32px 16px', maxWidth: '100%', boxSizing: 'border-box', textAlign: 'center', fontFamily: 'Inter', fontWeight: 700, fontSize: CAPTION_STYLE.fontPx, lineHeight: 1.18, color: CAPTION_STYLE.textHex }}>
        {cap.words.map((w, i) => (
          <span key={i} style={{ color: i === active ? pal.accent : CAPTION_STYLE.textHex }}>
            {w.text}
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
  const head = fitHeadline(edl.headline, S.w, 0.57, 100, 140, 3);
  const headH = head.lines.length * head.px * 1.08 + 30;
  const capH = Math.round(capLines(edl, CAPTION_STYLE.fontPx, 0.5, S.w) * CAPTION_STYLE.fontPx * 1.18 + 36);
  let body: React.ReactNode = null;
  if (kind === 'hook') {
    const top = S.y0 + headH + 40;
    body = (
      <>
        <Stack c={c} place={() => top} maxW={900} maxH={1600 - top} />
        <Headline c={c} px={head.px} lines={head.lines} />
      </>
    );
  } else if (kind === 'benefit') body = <Stack c={c} place={(h) => Math.round(FH * 0.52 - h / 2)} maxW={980} maxH={1150} />;
  else if (kind === 'offer') body = <Offer c={c} capH={capH} />;
  else body = <EndCard c={c} capH={capH} />;
  return (
    <AbsoluteFill style={{ fontFamily: 'Inter' }}>
      <Background c={c} />
      {body}
      <Captions c={c} />
      <Tracks edl={edl} />
    </AbsoluteFill>
  );
};
