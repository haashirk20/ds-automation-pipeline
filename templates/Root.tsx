import React from 'react';
import { Composition, Img, staticFile } from 'remotion';
import { FRAME, type RenderProps } from '../src/contracts.ts';
import { Ad } from './Ad.tsx';

const Sheet: React.FC<{ frames: string[] }> = ({ frames }) => (
  <div style={{ width: 1080, height: 960, background: '#000', display: 'flex', flexWrap: 'wrap' }}>
    {frames.map((f) => (
      <Img key={f} src={staticFile(f)} style={{ width: 270, height: 480 }} />
    ))}
  </div>
);

export const Root: React.FC = () => (
  <>
    <Composition
      id="Ad"
      component={Ad}
      width={FRAME.width}
      height={FRAME.height}
      fps={FRAME.fps}
      durationInFrames={450}
      defaultProps={{} as RenderProps}
      calculateMetadata={({ props }) => ({ durationInFrames: Math.round((props.edl.durationMs * FRAME.fps) / 1000) })}
    />
    <Composition id="Sheet" component={Sheet} width={1080} height={960} fps={FRAME.fps} durationInFrames={1} defaultProps={{ frames: [] as string[] }} />
  </>
);
