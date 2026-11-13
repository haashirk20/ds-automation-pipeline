import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { env, type Config, type PlatformName } from '../config/index.ts';
import { Brief, Edl, Script } from '../contracts.ts';
import { assembleEdl, ttsLines } from '../creative/assemble.ts';
import { makeBed } from '../music/index.ts';
import { synthesize } from '../tts/index.ts';
import { ff } from './ffmpeg.ts';
import { runQa } from '../qa/index.ts';
import { renderEdl, renderSheet } from './render.ts';

const Fixture = z.object({
  brief: Brief,
  samples: z.array(z.object({ id: z.string(), template: Edl.shape.template, palette: Edl.shape.palette, voice: z.string(), musicSeed: z.number(), script: Script })),
});

const SHEET_TIMES = [0.5, 1.5, 4, 7, 9.5, 11.5, 13, 14.5];

// Render the sample ads described in tests/fixtures/samples/samples.json to OUT_DIR/samples.
export async function runSamples(config: Config, _now: Date): Promise<void> {
  const fixtureFile = 'tests/fixtures/samples/samples.json';
  if (!existsSync(fixtureFile)) throw new Error('samples needs tests/fixtures, which are not in the Docker image: mount them (-v ./tests/fixtures:/app/tests/fixtures:ro)');
  const fx = Fixture.parse(JSON.parse(readFileSync(fixtureFile, 'utf8')));
  const out = path.resolve(env.outDir(), 'samples');
  const failures: string[] = [];
  for (const [i, s] of fx.samples.entries()) {
    const work = path.join(out, 'work', s.id);
    mkdirSync(work, { recursive: true });
    const t0 = Date.now();
    const voiceWav = path.join(work, 'voice.wav');
    // Speed 1.0 first; a script that runs long for its voice is sped up a little, then rejected.
    let tts = await synthesize({ lines: ttsLines(s.script), voice: s.voice, speed: 1.0, gapMs: 180, outWav: voiceWav });
    for (const speed of [1.06, 1.12]) {
      if (Math.max(...tts.lines.map((l) => l.endMs)) <= 14800) break;
      tts = await synthesize({ lines: ttsLines(s.script), voice: s.voice, speed, gapMs: 180, outWav: voiceWav });
    }
    const music = config.creative.music.enabled;
    const bed = path.join(work, 'bed.wav');
    if (music) await makeBed({ seed: s.musicSeed, durationSec: 16, outWav: bed });
    const edl = assembleEdl({
      slotId: s.id,
      brief: fx.brief,
      script: s.script,
      template: s.template,
      palette: s.palette,
      tts,
      voiceSrc: voiceWav,
      musicSrc: music ? bed : null,
      musicGainDb: config.creative.music.gainDb,
      dataDir: path.resolve(env.dataDir()),
      ai: { visuals: false, voice: true, music: false },
    });
    writeFileSync(path.join(out, `${s.id}.edl.json`), JSON.stringify(edl, null, 2));
    const speechEnd = Math.max(...tts.lines.map((l) => l.endMs));
    const platforms: PlatformName[] = i === 0 ? ['facebook', 'youtube', 'instagram', 'tiktok'] : ['facebook'];
    for (const platform of platforms) {
      const file = path.join(out, platform === 'facebook' ? `${s.id}.mp4` : `${s.id}-${platform}.mp4`);
      const r0 = Date.now();
      await renderEdl({ edl, platform, config, outFile: file });
      const qa = await runQa(file);
      const failed = qa.checks.filter((k) => !k.pass);
      if (failed.length) failures.push(`${path.basename(file)}: ${failed.map((k) => `${k.name} ${k.value} (limit ${k.limit})`).join('; ')}`);
      console.log(JSON.stringify({ qa: qa.pass ? 'pass' : 'FAIL', failed: failed.map((k) => `${k.name} ${k.value}`) }));
      console.log(JSON.stringify({ sample: s.id, platform, speechEndMs: speechEnd, durationMs: edl.durationMs, renderSec: Math.round((Date.now() - r0) / 100) / 10, file }));
    }
    // Contact sheet from the facebook render.
    const frames: string[] = [];
    for (const [k, sec] of SHEET_TIMES.entries()) {
      const png = path.join(work, `frame${k}.png`);
      await ff('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-ss', String(sec), '-i', path.join(out, `${s.id}.mp4`), '-frames:v', '1', '-vf', 'scale=270:480', png]);
      frames.push(png);
    }
    await renderSheet(frames, path.join(out, `${s.id}.sheet.png`));
    console.log(JSON.stringify({ sample: s.id, totalSec: Math.round((Date.now() - t0) / 1000) }));
  }
  if (failures.length) throw new Error(`QA failed:\n${failures.join('\n')}`);
}
