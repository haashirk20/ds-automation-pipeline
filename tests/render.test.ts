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

test('ugcTop: tallest top safe zone of the enabled platforms plus 30', async () => {
  const { ugcTop } = await import('../src/render/render.ts');
  const { parseConfig } = await import('../src/config/index.ts');
  const { default: raw } = await import('../config/pipeline.config.ts');
  const c = parseConfig(structuredClone(raw));
  const want = Math.max(...Object.values(c.platforms).filter((p) => p.enabled).map((p) => p.safe.top)) + 30;
  assert.equal(ugcTop(c), want);
  c.platforms.facebook.enabled = true;
  c.platforms.facebook.safe.top = 400;
  assert.equal(ugcTop(c), 430);
});

test('ugcDurationMs: refuses unusable clips, caps the length at 16 s', async () => {
  const { ugcDurationMs } = await import('../src/render/render.ts');
  assert.throws(() => ugcDurationMs(null), /no video stream/);
  assert.throws(() => ugcDurationMs({ width: 720, height: 1280, seconds: 13.9 }), /shorter than 14 s/);
  assert.throws(() => ugcDurationMs({ width: 360, height: 640, seconds: 15 }), /short side/);
  assert.equal(ugcDurationMs({ width: 720, height: 1280, seconds: 15.04 }), 15040);
  assert.equal(ugcDurationMs({ width: 720, height: 1280, seconds: 20 }), 16000);
});

// A real render (Chrome and the bundle; about a minute): owner music is audible and ducks while the line plays.
test('renderUgc with music: the duck window is quieter than after it', { timeout: 300_000 }, async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { deflateSync } = await import('node:zlib');
  const path = await import('node:path');
  const { renderUgc } = await import('../src/render/render.ts');
  const { ff } = await import('../src/render/ffmpeg.ts');
  const { parseConfig } = await import('../src/config/index.ts');
  const { default: raw } = await import('../config/pipeline.config.ts');
  const dir = mkdtempSync(path.join(tmpdir(), 'ugc-music-'));
  process.env.OUT_DIR = path.join(dir, 'out');
  mkdirSync(process.env.OUT_DIR);
  // The FFmpeg build has no video source filter, so the picture is a 64x64 PNG made here.
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const chunk = (t: string, d: Buffer) => {
    const td = Buffer.concat([Buffer.from(t), d]);
    let c = -1;
    for (const x of td) c = crcT[(c ^ x) & 255] ^ (c >>> 8);
    const l = Buffer.alloc(4); l.writeUInt32BE(d.length);
    const k = Buffer.alloc(4); k.writeUInt32BE((c ^ -1) >>> 0);
    return Buffer.concat([l, td, k]);
  };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(64, 0); ih.writeUInt32BE(64, 4); ih[8] = 8; ih[9] = 2;
  const px = Buffer.alloc(64 * 193, 80);
  for (let y = 0; y < 64; y++) px[y * 193] = 0;
  writeFileSync(path.join(dir, 'x.png'), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', deflateSync(px)), chunk('IEND', Buffer.alloc(0))]));
  const clip = path.join(dir, 'clip.mp4');
  const music = path.join(dir, 'music.m4a');
  await ff('ffmpeg', ['-y', '-loop', '1', '-framerate', '30', '-i', path.join(dir, 'x.png'), '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '15', '-vf', 'scale=540:960', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip]);
  await ff('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:a', 'aac', '-f', 'mp4', music]); // shorter than the clip, so it loops
  const out = path.join(process.env.OUT_DIR, 'ugc.mp4');
  await renderUgc({ clip, caption: 'test', config: parseConfig(structuredClone(raw)), outFile: out, music: { file: music, gainDb: -6, duckDb: -20, duckUntilMs: 5000 } });
  const loud = async (from: number, to: number) => {
    const r = await ff('ffmpeg', ['-hide_banner', '-nostdin', '-i', out, '-vn', '-af', `atrim=start=${from}:end=${to},loudnorm=print_format=json`, '-f', 'null', '-']);
    return Number(JSON.parse(r.stderr.slice(r.stderr.lastIndexOf('{'), r.stderr.lastIndexOf('}') + 1)).input_i);
  };
  const ducked = await loud(1, 4);
  const after = await loud(7, 10);
  console.log(`music duck measured: ducked ${ducked} LUFS, after ${after} LUFS, diff ${(after - ducked).toFixed(1)} dB`);
  assert.ok(after > -40, 'music is audible after the duck');
  assert.ok(after - ducked > 15 && after - ducked < 25, 'the duck is about 20 dB');
});
