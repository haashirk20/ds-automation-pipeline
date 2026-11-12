import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertInside, planStaging } from '../src/render/render.ts';
import { assembleEdl, ttsLines } from '../src/creative/assemble.ts';
import { Brief, Script } from '../src/contracts.ts';

const fx = JSON.parse(readFileSync('tests/fixtures/samples/samples.json', 'utf8'));
const script = Script.parse(fx.samples[0].script);
let t = 0;
const tts = {
  durationMs: 0,
  lines: ttsLines(script).map((l) => ({ id: l.id, startMs: t, endMs: (t += 300 * l.text.split(/\s+/).length + 180) - 180, words: l.text.split(/\s+/).map((text, i) => ({ text, startMs: t - 300 * (l.text.split(/\s+/).length - i) - 180, endMs: t - 300 * (l.text.split(/\s+/).length - i - 1) - 180 })) })),
};
const edl = assembleEdl({ slotId: 's', brief: Brief.parse(fx.brief), script, template: 'cozy-soft', palette: fx.samples[0].palette, tts, voiceSrc: '/w/voice.wav', musicSrc: '/w/bed.wav', musicGainDb: -18, dataDir: '/d', ai: { visuals: false, voice: true, music: false } });

test('planStaging: unique files get generated relative names, edl copy rewritten, original untouched', () => {
  const plan = planStaging(edl, 'abc');
  const froms = plan.files.map((f) => f.from);
  assert.equal(new Set(froms).size, froms.length);
  assert.ok(froms.includes('/w/voice.wav') && froms.includes('/w/bed.wav'));
  for (const f of plan.files) assert.match(f.to, /^s\/abc\/f\d+\.(jpg|wav)$/);
  const refs = [...plan.edl.beats.flatMap((b) => b.shots.map((s) => s.src)), plan.edl.endCard.shotSrc, plan.edl.audio.voiceSrc, plan.edl.audio.musicSrc!];
  for (const r of refs) assert.ok(plan.files.some((f) => f.to === r));
  assert.ok(edl.audio.voiceSrc.startsWith('/'), 'input not mutated');
  // the same source photo (several crops) is staged once
  assert.ok(plan.files.length < refs.length);
});

test('assertInside: only paths below the directory pass', () => {
  assert.equal(assertInside('/o/samples/a.mp4', '/o'), '/o/samples/a.mp4');
  assert.throws(() => assertInside('/o/../etc/a.mp4', '/o'));
  assert.throws(() => assertInside('/other/a.mp4', '/o'));
  assert.throws(() => assertInside('/o', '/o'));
  assert.throws(() => assertInside('/oo/a.mp4', '/o'));
});
