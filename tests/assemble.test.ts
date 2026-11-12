import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assembleEdl, ScriptTooLongError, ttsLines, type AssembleInput } from '../src/creative/assemble.ts';
import { Brief, Edl, Script } from '../src/contracts.ts';
import type { TtsResult } from '../src/tts/index.ts';

const fx = JSON.parse(readFileSync('tests/fixtures/samples/samples.json', 'utf8'));
const brief = Brief.parse(fx.brief);
const sample = fx.samples[0];
const script = Script.parse(sample.script);

// Fake TTS: every spoken word takes 300 ms, lines separated by 180 ms.
function fakeTts(s: Script, endShift = 0, dropWords = 0): TtsResult {
  let t = 200;
  const lines = ttsLines(s).map((l, i) => {
    const ws = l.text.split(/\s+/).slice(0, i === 1 ? undefined : undefined);
    const keep = i === 1 ? ws.length - dropWords : ws.length;
    const start = t;
    const words = ws.slice(0, keep).map((text) => {
      const w = { text, startMs: t, endMs: t + 300 };
      t += 300;
      return w;
    });
    const line = { id: l.id, startMs: start, endMs: t, words };
    t += 180;
    return line;
  });
  lines[3].endMs += endShift;
  lines[3].words[lines[3].words.length - 1].endMs += endShift;
  return { durationMs: lines[3].endMs, lines };
}

const base = (tts: TtsResult, over: Partial<AssembleInput> = {}): AssembleInput => ({
  slotId: 'slot-1', brief, script, template: 'kinetic-bold', palette: sample.palette, tts, voiceSrc: '/v.wav', musicSrc: null, musicGainDb: -18, dataDir: '/data', ai: { visuals: false, voice: true, music: false }, ...over,
});

test('ttsLines: one line per beat, say strings joined', () => {
  const l = ttsLines(script);
  assert.deepEqual(l.map((x) => x.id), ['hook', 'benefit', 'offer', 'cta']);
  assert.equal(l[1].text, script.beats[1].chunks.map((c) => c.say).join(' '));
});

test('assemble: valid Edl, monotonic beats, captions inside beats, 15 s when speech is short', () => {
  const edl = assembleEdl(base(fakeTts(script)));
  Edl.parse(edl);
  assert.equal(edl.beats[0].startMs, 0);
  assert.equal(edl.beats[3].endMs, edl.durationMs);
  for (let i = 1; i < 4; i++) assert.equal(edl.beats[i].startMs, edl.beats[i - 1].endMs);
  const hookLineStart = 200;
  assert.equal(edl.beats[1].startMs, 200 + script.beats[0].chunks.flatMap((c) => c.say.split(/\s+/)).length * 300 + 180 - 120);
  assert.ok(hookLineStart >= 0);
  edl.captions.forEach((c, i) => {
    assert.ok(c.startMs < c.endMs);
    if (i) assert.ok(c.startMs >= edl.captions[i - 1].endMs, 'captions do not overlap');
    const b = edl.beats.find((x) => c.startMs >= x.startMs && c.startMs < x.endMs)!;
    assert.ok(c.endMs <= b.endMs, 'caption inside its beat');
    for (const w of c.words) assert.ok(w.startMs >= c.startMs && w.endMs <= c.endMs);
  });
  assert.equal(edl.captions.length, script.beats.reduce((n, b) => n + b.chunks.length, 0));
});

test('assemble: one-to-one word mapping when counts match', () => {
  const edl = assembleEdl(base(fakeTts(script)));
  const first = edl.captions[0]; // "Still cold on the couch?" shown identically
  assert.deepEqual(first.words.map((w) => w.text), ['Still', 'cold', 'on', 'the', 'couch?']);
  assert.deepEqual(first.words.map((w) => w.startMs), [200, 500, 800, 1100, 1400]);
});

test('assemble: uneven mapping spreads time by character length', () => {
  const edl = assembleEdl(base(fakeTts(script)));
  const cap = edl.captions.find((c) => c.words.map((w) => w.text).join(' ') === '$49.99')!;
  assert.equal(cap.words.length, 1);
  const odd = structuredClone(script);
  odd.beats[0].chunks = [{ say: 'one two three', show: 'a bbbbbbb' }];
  const [x, y] = assembleEdl(base(fakeTts(odd), { script: odd })).captions[0].words;
  assert.ok(x.endMs <= y.startMs + 1 && y.endMs - y.startMs > 3 * (x.endMs - x.startMs), 'time follows character length');
});

test('assemble: word count mismatch splits the line time by say word counts', () => {
  const edl = assembleEdl(base(fakeTts(script, 0, 1)));
  const benefit = script.beats[1].chunks.length;
  const caps = edl.captions.slice(1, 1 + benefit);
  caps.forEach((c, i) => {
    assert.ok(c.endMs > c.startMs);
    if (i) assert.ok(c.startMs >= caps[i - 1].startMs);
  });
  Edl.parse(edl);
});

test('assemble: duration rule', () => {
  const tts = fakeTts(script);
  const end = tts.lines[3].endMs;
  assert.equal(assembleEdl(base(tts)).durationMs, 15000);
  const longer = fakeTts(script, 14000 - end); // ends at 14000
  assert.equal(assembleEdl(base(longer)).durationMs, 15200);
  const max = fakeTts(script, 14800 - end);
  assert.equal(assembleEdl(base(max)).durationMs, 16000);
  assert.throws(() => assembleEdl(base(fakeTts(script, 14801 - end))), ScriptTooLongError);
});

test('assemble: shots share the beat equally, absolute src, motion never still', () => {
  const edl = assembleEdl(base(fakeTts(script)));
  const b = edl.beats[1];
  assert.equal(b.shots.length, 3);
  assert.equal(b.shots[0].startMs, b.startMs);
  assert.equal(b.shots[2].endMs, b.endMs);
  assert.ok(b.shots[0].src.startsWith('/data/assets/'));
  for (const s of edl.beats.flatMap((x) => x.shots)) assert.notEqual(s.motion, 'still');
  const other = assembleEdl(base(fakeTts(script), { slotId: 'slot-2' }));
  const m = (e: Edl) => e.beats.flatMap((x) => x.shots.map((s) => s.motion)).join();
  const alt = ['slot-3', 'slot-4', 'slot-5'].map((slotId) => m(assembleEdl(base(fakeTts(script), { slotId }))));
  assert.ok(new Set([m(edl), m(other), ...alt]).size > 1);
});

test('assemble: unknown shot id throws; end card uses first cta shot and brief fields', () => {
  const bad = structuredClone(script);
  bad.beats[0].shotIds = ['nope'];
  assert.throws(() => assembleEdl(base(fakeTts(script), { script: bad })), /unknown shot id nope/);
  const edl = assembleEdl(base(fakeTts(script)));
  assert.equal(edl.endCard.shopName, brief.shop.name);
  assert.equal(edl.endCard.priceText, brief.product.priceText);
  assert.equal(edl.headline, script.hook.headline);
  assert.ok(edl.endCard.shotSrc.endsWith(brief.shots.find((s) => s.id === script.beats[3].shotIds[0])!.file));
});
