import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  evaluateProbe, topAtoms, faststartOk, parseLoudnorm, loudnessChecks, parseSilence, blackRunSeconds, frozenRunSeconds,
  contrastRatio, captionStyleOk, sizeCheck, runQa, FRAME_BYTES,
} from '../src/qa/index.ts';

const good = {
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '15.0' },
  streams: [
    { codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 1080, height: 1920, avg_frame_rate: '30/1' },
    { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000' },
  ],
};
test('probe passes good file', () => assert.ok(evaluateProbe(good).every((k) => k.pass)));
test('probe flags each fault', () => {
  const bad = { format: { format_name: 'matroska', duration: '16.5' }, streams: [{ ...good.streams[0]!, avg_frame_rate: '2997/100' }] };
  assert.deepEqual(evaluateProbe(bad).map((k) => k.pass), [false, false, false, false]);
});
test('size bounds', () => {
  assert.ok(sizeCheck(5e6).pass);
  assert.ok(!sizeCheck(1000).pass);
  assert.ok(!sizeCheck(101 * 1024 * 1024).pass);
});

const atom = (type: string, size: number) => { const b = Buffer.alloc(size); b.writeUInt32BE(size, 0); b.write(type, 4, 'latin1'); return b; };
const reader = (buf: Buffer) => (o: number, l: number) => buf.subarray(o, o + l);
test('faststart: moov before mdat', () => {
  const f = Buffer.concat([atom('ftyp', 24), atom('moov', 100), atom('mdat', 500)]);
  assert.ok(faststartOk(topAtoms(reader(f), f.length)).pass);
});
test('faststart: mdat before moov fails', () => {
  const f = Buffer.concat([atom('ftyp', 24), atom('mdat', 500), atom('moov', 100)]);
  assert.ok(!faststartOk(topAtoms(reader(f), f.length)).pass);
});
test('atom walk handles 64-bit and to-EOF sizes', () => {
  const big = Buffer.alloc(40); big.writeUInt32BE(1, 0); big.write('mdat', 4, 'latin1'); big.writeBigUInt64BE(40n, 8);
  const eof = Buffer.alloc(20); eof.write('moov', 4, 'latin1'); // size 0
  const f = Buffer.concat([atom('ftyp', 24), big, eof]);
  assert.deepEqual(topAtoms(reader(f), f.length).map((a) => a.type), ['ftyp', 'mdat', 'moov']);
});

test('loudnorm json amid log noise', () => {
  const err = `[Parsed_loudnorm_0 @ 0x1] \n{\n\t"input_i" : "-14.20",\n\t"input_tp" : "-1.50",\n\t"input_lra" : "3.00"\n}\nframe= 1 size=N/A`;
  const l = parseLoudnorm(err)!;
  assert.deepEqual(l, { i: -14.2, tp: -1.5 });
  assert.ok(loudnessChecks(l)[0]!.pass);
  assert.ok(!loudnessChecks({ i: -20, tp: -1.5 })[0]!.pass);
  assert.ok(!loudnessChecks({ i: -14, tp: 0 })[0]!.pass);
  assert.ok(!loudnessChecks(parseLoudnorm('no json'))[0]!.pass);
});
test('silencedetect parse', () => {
  assert.deepEqual(parseSilence('x\n[silencedetect @ 0x] silence_start: 3.5\n[silencedetect @ 0x] silence_end: 6'), [3.5]);
  assert.deepEqual(parseSilence('nothing'), []);
});

const frame = (v: number) => Buffer.alloc(FRAME_BYTES, v);
const noisy = (seed: number) => Buffer.from(Array.from({ length: FRAME_BYTES }, (_, i) => 60 + ((i * 7 + seed * 13) % 120)));
test('black run of 12 frames in 450', () => {
  const fr = Array.from({ length: 450 }, (_, i) => (i >= 100 && i < 112 ? frame(2) : noisy(i)));
  assert.ok(Math.abs(blackRunSeconds(Buffer.concat(fr)) - 0.4) < 1e-9);
  assert.equal(blackRunSeconds(Buffer.concat(fr.slice(0, 109))), 0.3);
});
test('frozen run of 100 frames', () => {
  const fr = Array.from({ length: 450 }, (_, i) => (i >= 100 && i < 200 ? noisy(999) : noisy(i)));
  const s = frozenRunSeconds(Buffer.concat(fr));
  assert.ok(s > 2.5 && s < 3.5);
});
test('fade is not frozen', () => {
  const fr = Array.from({ length: 200 }, (_, i) => frame(20 + Math.floor(i / 2)));
  assert.ok(frozenRunSeconds(Buffer.concat(fr)) <= 2.5 / 5);
});

test('contrast and caption style', () => {
  assert.ok(Math.abs(contrastRatio('#000000', '#ffffff') - 21) < 1e-9);
  assert.ok(captionStyleOk({ fontPx: 64, textHex: '#ffffff', plateHex: '#000000', plateAlpha: 0.7 }));
  assert.ok(!captionStyleOk({ fontPx: 40, textHex: '#ffffff', plateHex: '#000000', plateAlpha: 0.7 }));
  assert.ok(!captionStyleOk({ fontPx: 64, textHex: '#ffffff', plateHex: '#000000', plateAlpha: 0.5 }));
  assert.ok(!captionStyleOk({ fontPx: 64, textHex: '#888888', plateHex: '#999999', plateAlpha: 0.9 }));
});

const dir = './out/samples';
test('runQa on out/samples', { skip: !existsSync(dir) }, async () => {
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.mp4'))) {
    const r = await runQa(`${dir}/${f}`);
    assert.equal(r.checks.length, 10);
  }
});

test('runQa reports instead of throwing on bad files', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'qa-'));
  const empty = path.join(tmp, 'empty.mp4'); writeFileSync(empty, '');
  const trunc = path.join(tmp, 'trunc.mp4');
  const real = existsSync(dir) ? readdirSync(dir).find((x) => x.endsWith('.mp4')) : undefined;
  writeFileSync(trunc, real ? readFileSync(`${dir}/${real}`).subarray(0, 4096) : Buffer.concat([atom('ftyp', 24), atom('mdat', 4000)]));
  for (const f of [path.join(tmp, 'missing.mp4'), empty, trunc]) {
    const r = await runQa(f);
    assert.equal(r.pass, false);
    assert.equal(r.checks.length, 10);
    assert.ok(r.checks.some((k) => !k.pass && k.value.length > 0));
  }
});
