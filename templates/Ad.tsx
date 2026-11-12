import React from 'react';
import type { RenderProps } from '../src/contracts.ts';
import { TEMPLATE_COMPONENTS } from './templates.ts';

export const Ad: React.FC<RenderProps> = (props) => {
  const T = TEMPLATE_COMPONENTS[props.edl.template];
  return <T {...props} />;
};
