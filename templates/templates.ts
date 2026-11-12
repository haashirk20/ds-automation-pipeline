import type React from 'react';
import type { RenderProps } from '../src/contracts.ts';
import { Template as kineticBold } from './kinetic-bold.tsx';
import { Template as cozySoft } from './cozy-soft.tsx';
import { Template as giftGuide } from './gift-guide.tsx';

export const TEMPLATE_COMPONENTS: Record<RenderProps['edl']['template'], React.FC<RenderProps>> = {
  'kinetic-bold': kineticBold,
  'cozy-soft': cozySoft,
  'gift-guide': giftGuide,
};
