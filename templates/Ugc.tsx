import React, { useEffect, useState } from 'react';
import { AbsoluteFill, Audio, continueRender, delayRender, OffthreadVideo, staticFile, useVideoConfig } from 'remotion';
import { loadFonts } from './common.tsx';
import { ugcMusicVolume } from './music-volume.ts';

export type UgcProps = { clipSrc: string; caption: string; top: number; fontPx: number; durationMs: number; music?: { src: string; gainDb: number; duckDb: number; duckUntilMs: number } | null };

// An AI clip with its own sound and one caption at the top for the whole video. Nothing else is drawn.
export const Ugc: React.FC<UgcProps> = ({ clipSrc, caption, top, fontPx, durationMs, music }) => {
  const { fps } = useVideoConfig();
  const [handle] = useState(() => delayRender('fonts'));
  useEffect(() => {
    loadFonts().then(() => continueRender(handle), () => continueRender(handle));
  }, [handle]);
  return (
    <AbsoluteFill style={{ background: '#000' }}>
      <OffthreadVideo src={staticFile(clipSrc)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      {music ? <Audio src={staticFile(music.src)} loop loopVolumeCurveBehavior="extend" volume={(f) => ugcMusicVolume((f / fps) * 1000, durationMs, music)} /> : null}
      <div
        style={{
          position: 'absolute',
          top,
          left: 70,
          right: 70,
          fontFamily: 'Inter, "Noto Color Emoji", sans-serif',
          fontWeight: 700,
          fontSize: fontPx,
          lineHeight: 1.18,
          color: '#FFFFFF',
          WebkitTextStroke: '10px #000000',
          paintOrder: 'stroke fill',
          textShadow: '0 2px 6px rgba(0,0,0,0.5)',
          textAlign: 'center',
          textWrap: 'balance',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
        }}
      >
        {caption}
      </div>
    </AbsoluteFill>
  );
};
