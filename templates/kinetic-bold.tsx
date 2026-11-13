import React from 'react';
import { AbsoluteFill } from 'remotion';
import type { RenderProps } from '../src/contracts.ts';
import { alpha, backOut, cardSize, clamp, easeOut, endShot, fitHeadline, FH, FW, legible, onColor, ShotView, Tracks, useCtx, capLines, type Ctx } from './common.tsx';

// Dark and punchy: full-bleed photo, slammed headline, hard-cut tilted cards, sticker price.
import { CAPTION_STYLES } from './caption-style.ts';
export const CAPTION_STYLE = CAPTION_STYLES['kinetic-bold'];

const CAP_H = Math.round(2 * CAPTION_STYLE.fontPx * 1.05 + 36);

const Backdrop: React.FC<{ c: Ctx }> = ({ c }) => {
  const { pal, edl, kind, shot, vp, shotT, si, beatT } = c;
  const src = kind === 'cta' ? endShot(edl) : shot;
  const flash = si > 0 || kind !== 'hook' ? clamp(1 - Math.min(shotT, beatT) / 140) * 0.28 : 0;
  return (
    <AbsoluteFill style={{ background: pal.bg }}>
      <div style={{ position: 'absolute', left: -90, top: -90, transform: `scale(${1 + 0.1 * vp})` }}>
        <ShotView shot={src} w={FW + 180} h={FH + 180} blur={16} dim={0.62} />
      </div>
      <AbsoluteFill style={{ background: `linear-gradient(180deg, ${alpha(pal.bg, 0.7)} 0%, ${alpha(pal.bg, 0.15)} 30%, ${alpha(pal.bg, 0.35)} 60%, ${alpha(pal.bg, 0.92)} 100%)` }} />
      <AbsoluteFill style={{ background: pal.accent, opacity: flash }} />
    </AbsoluteFill>
  );
};

const Headline: React.FC<{ c: Ctx; px: number; lines: string[] }> = ({ c, px, lines }) => {
  const { edl, pal, S, beatT, t } = c;
  const all = lines.flatMap((l, li) => l.split(' ').map((w) => ({ w, li })));
  const key = all.reduce((a, x, i) => (x.w.replace(/\W/g, '').length > all[a].w.replace(/\W/g, '').length ? i : a), 0);
  return (
    <div style={{ position: 'absolute', left: S.x0, top: S.y0, width: S.w, fontFamily: 'Anton', fontSize: px, lineHeight: 1.04, color: pal.ink, textTransform: 'uppercase', textShadow: '0 6px 30px rgba(0,0,0,.6)', transform: `translateY(${Math.sin(t / 700) * 6}px)` }}>
      {lines.map((l, li) => (
        <div key={li} style={{ whiteSpace: 'nowrap' }}>
          {all.map((x, i) => {
            if (x.li !== li) return null;
            const age = beatT - 120 - i * 170;
            const k = easeOut(age / 220);
            const hot = i === key;
            return (
              <span key={i} style={{ display: 'inline-block', marginRight: '0.22em', opacity: clamp(age / 60), transform: `scale(${1 + 1.3 * (1 - k)}) rotate(${hot ? -2 : 0}deg)`, transformOrigin: '0% 70%', background: hot ? pal.accent : undefined, color: hot ? onColor(pal.accent) : undefined, padding: hot ? '0 0.14em' : undefined, textShadow: hot ? 'none' : undefined }}>
                {x.w}
              </span>
            );
          })}
        </div>
      ))}
      <span style={{ display: 'none' }}>{edl.headline}</span>
    </div>
  );
};

const Card: React.FC<{ c: Ctx; shot: Ctx['shot']; w: number; h: number; x: number; y: number; tilt: number; enter: number; dir: number }> = ({ c, shot, w, h, x, y, tilt, enter, dir }) => {
  const k = easeOut(enter);
  return (
    <div style={{ position: 'absolute', left: x + (1 - k) * dir * 1300, top: y, width: w, height: h, transform: `rotate(${tilt * k + (1 - k) * dir * 6}deg)`, border: `10px solid ${c.pal.ink}`, boxSizing: 'content-box', marginLeft: -10, marginTop: -10, boxShadow: '0 30px 80px rgba(0,0,0,.65)' }}>
      <ShotView shot={shot} w={w} h={h} motion={shot.motion} p={c.sp} />
    </div>
  );
};

const Offer: React.FC<{ c: Ctx }> = ({ c }) => {
  const { beat, S, t, pal, edl, priceAt } = c;
  const rowTop = Math.round(FH * 0.375);
  const badgeH = 230;
  const badgeTop = Math.max(S.y0 + 20, rowTop - 180);
  const cw = 400;
  const step = 300;
  const tilts = [-5, 3, -3];
  const zig = [0, 170, 40];
  const price = backOut((t - priceAt) / 520);
  return (
    <>
      {beat.shots.map((s, i) => {
        if (t < s.startMs - 40) return null;
        const k = backOut((t - s.startMs) / 360);
        const { w, h } = cardSize(s, cw, 560);
        const x = 40 + i * step + (cw - w) / 2;
        return (
          <div key={i} style={{ position: 'absolute', left: x, top: rowTop + zig[i % 3] + Math.sin(t / 600 + i) * 8, width: w, height: h, transform: `scale(${k}) rotate(${tilts[i % 3]}deg)`, border: `8px solid ${pal.ink}`, boxSizing: 'content-box', marginLeft: -8, marginTop: -8, boxShadow: '0 20px 60px rgba(0,0,0,.6)', zIndex: i }}>
            <ShotView shot={s} w={w} h={h} motion={s.motion} p={clamp((t - s.startMs) / 2000)} />
          </div>
        );
      })}
      {t >= priceAt && (
        <div style={{ position: 'absolute', left: S.x0, width: S.w, top: badgeTop, height: badgeH, display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 5 }}>
          <div style={{ background: pal.accent, color: onColor(pal.accent), fontFamily: 'Anton', fontSize: Math.min(260, badgeH * 0.8), lineHeight: 1, padding: '0 0.25em', borderRadius: 24, border: `8px solid ${pal.ink}`, transform: `scale(${price}) rotate(${-4 + Math.sin(t / 300) * 1.5}deg)`, boxShadow: '0 20px 60px rgba(0,0,0,.6)', whiteSpace: 'nowrap', maxWidth: S.w, boxSizing: 'border-box' }}>{edl.endCard.priceText}</div>
        </div>
      )}
    </>
  );
};

const EndCard: React.FC<{ c: Ctx; capH: number }> = ({ c, capH }) => {
  const { edl, pal, S, beatT, beatP, t, cta } = c;
  const e = edl.endCard;
  const item = (i: number): React.CSSProperties => {
    const k = easeOut((beatT - i * 90) / 260);
    return { opacity: k, transform: `translateY(${(1 - k) * 40}px)` };
  };
  const pulse = 1 + 0.035 * Math.sin(t / 220);
  const pk = backOut(beatT / 420);
  return (
    <div style={{ position: 'absolute', left: S.x0, width: S.w, bottom: FH - (S.y1 - capH - 14), display: 'flex', flexDirection: 'column', alignItems: 'center', color: pal.ink }}>
      <div style={{ width: 780, height: 700, border: `10px solid ${pal.ink}`, boxSizing: 'content-box', transform: `rotate(-3deg) scale(${pk})`, boxShadow: '0 30px 80px rgba(0,0,0,.6)', marginBottom: -80 }}>
        <ShotView shot={endShot(edl)} w={780} h={700} motion="push-in" p={beatP} />
      </div>
      <div style={{ ...item(1), background: pal.accent, color: onColor(pal.accent), fontFamily: 'Anton', fontSize: 140, lineHeight: 1.05, padding: '0 0.25em', borderRadius: 22, border: `8px solid ${pal.ink}`, transform: `${item(1).transform} rotate(-2deg)`, whiteSpace: 'nowrap', maxWidth: S.w, boxSizing: 'border-box', zIndex: 2 }}>{e.priceText}</div>
      <div style={{ ...item(2), fontFamily: 'Anton', fontSize: 50, textTransform: 'uppercase', textAlign: 'center', marginTop: 8, textShadow: '0 4px 20px #000' }}>{e.title}</div>
      <div style={{ ...item(3), marginTop: 10 }}>
        <div style={{ background: pal.ink, color: onColor(pal.ink), fontFamily: 'Anton', fontSize: 56, textTransform: 'uppercase', padding: '4px 48px', borderRadius: 16, transform: `scale(${pulse})`, whiteSpace: 'nowrap' }}>{cta}</div>
      </div>
      <div style={{ ...item(4), marginTop: 10, display: 'flex', alignItems: 'baseline', gap: 16, whiteSpace: 'nowrap' }}>
        <span style={{ fontFamily: 'Inter', fontWeight: 800, fontSize: 40, textTransform: 'uppercase' }}>{e.shopName}</span>
        <span style={{ fontFamily: 'Inter', fontWeight: 500, fontSize: 30, textShadow: '0 2px 12px #000' }}>{e.shopDomain}</span>
      </div>
      <div style={{ ...item(4), fontFamily: 'Inter', fontWeight: 500, fontSize: 30, textAlign: 'center', lineHeight: 1.25, textShadow: '0 2px 12px #000' }}>
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
  const k = backOut((t - cap.startMs) / 160);
  const hi = legible(pal.accent, CAPTION_STYLE.plateHex);
  return (
    <div style={{ position: 'absolute', left: S.x0, width: S.w, bottom: safe.bottom, display: 'flex', justifyContent: 'center' }}>
      <div style={{ background: alpha(CAPTION_STYLE.plateHex, CAPTION_STYLE.plateAlpha), padding: '10px 28px 12px', maxWidth: '100%', boxSizing: 'border-box', textAlign: 'center', fontFamily: 'Anton', fontSize: CAPTION_STYLE.fontPx, lineHeight: 1.05, textTransform: 'uppercase', color: CAPTION_STYLE.textHex, transform: `scale(${0.85 + 0.15 * k})`, borderBottom: `8px solid ${pal.accent}` }}>
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

export const Template: React.FC<RenderProps> = (props) => {
  const c = useCtx(props);
  const { edl, S, kind, shot, si, beatT, t } = c;
  const head = fitHeadline(edl.headline.toUpperCase(), S.w, 0.5, 110, 230, 3);
  const headH = head.lines.length * head.px * 1.04;
  const capH = Math.round((capLines(edl, CAPTION_STYLE.fontPx, 0.46, S.w) * CAPTION_STYLE.fontPx * 1.05 + 40) * 1);
  let body: React.ReactNode = null;
  if (kind === 'hook') {
    const top = S.y0 + headH + 50;
    const { w, h } = cardSize(shot, 1000, 1620 - top);
    body = (
      <>
        <Card c={c} shot={shot} w={w} h={h} x={(FW - w) / 2} y={top} tilt={-3} enter={beatT / 320} dir={1} />
        <Headline c={c} px={head.px} lines={head.lines} />
      </>
    );
  } else if (kind === 'benefit') {
    const { w, h } = cardSize(shot, 1000, 1150);
    const dir = si % 2 ? 1 : -1;
    body = <Card key={si} c={c} shot={shot} w={w} h={h} x={(FW - w) / 2 + dir * -30} y={Math.round(FH * 0.52 - h / 2)} tilt={dir * 3} enter={c.shotT / 230} dir={dir} />;
  } else if (kind === 'offer') body = <Offer c={c} />;
  else body = <EndCard c={c} capH={capH} />;
  void t;
  return (
    <AbsoluteFill>
      <Backdrop c={c} />
      {body}
      <Captions c={c} />
      <Tracks edl={edl} />
    </AbsoluteFill>
  );
};
