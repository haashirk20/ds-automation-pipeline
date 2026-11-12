import { PermanentError, type Publisher } from './types.ts';

const stub = (platform: string): Publisher => ({
  platform,
  async publish() {
    throw new PermanentError('not implemented until Phase 5');
  },
});

export const publishers: Record<string, Publisher> = Object.fromEntries(
  ['youtube', 'facebook', 'linkedin', 'tiktok'].map((p) => [p, stub(p)]),
);
