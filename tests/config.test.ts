import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config/index.ts';
import raw from '../config/pipeline.config.ts';

const mod = (f: (c: any) => void) => {
  const c = structuredClone(raw);
  f(c);
  return c;
};

test('ugc mode needs a produce timeout that outlasts every video job', () => {
  assert.ok(parseConfig(mod((c) => (c.render.produceTimeoutMinutes = 90))));
  assert.throws(() => parseConfig(mod((c) => (c.render.produceTimeoutMinutes = 89))), /produceTimeoutMinutes/);
  assert.ok(parseConfig(mod((c) => { c.creative.mode = 'ad'; c.tiers.mix = { t0: 1, t1: 0, t2: 0 }; c.tiers.clipSeconds = 4; c.render.produceTimeoutMinutes = 30; })));
});

test('an enabled instagram cannot be private', () => {
  assert.throws(() => parseConfig(mod((c) => { c.platforms.instagram.enabled = true; })), /instagram has no private mode/);
  assert.ok(parseConfig(mod((c) => { c.platforms.instagram.enabled = true; c.platforms.instagram.visibility = 'public'; })));
});
